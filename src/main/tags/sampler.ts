import type { BoardPack, ReaderDef } from './schema';
import { getKind, type ReaderContext } from './kinds';
import { buildGroupCommand, splitSections } from './fetch';
import { bindSampleToTag, matchTagPattern, unitForTag } from './vocabulary';
import { makeError, AppError } from '../../shared/errors';
import type { TagStore } from './store';
import type { ExecResult } from '../hal/connection';
import type { ReasonCode } from '../../shared/tag-reading';

/**
 * 采样器 —— 把前面几件事串起来：
 * **取数 → 分段 → 逐 reader 解析 → sample 绑成 tag → 入 store**。
 *
 * ── 它是「一个组的一次往返」──
 *
 * 一个 poll group = 一次往返（契约 §1.2）：
 * 同组的所有 reader 合成**一条**命令，一次取回。
 *
 * ── 为什么 reader 的解析状态存在这里 ──
 *
 * `proc_stat` 需要**两次采样**做差（契约 §2.4）。
 * 那份历史**属于这条连接上的这个 reader**，所以存在采样器里——
 * 不在 kind 里（那会让两个连接共用一份历史），
 * 也不在 store 里（那是读数的汇点，不是采样状态）。
 */

export interface ExecRunner {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
}

/** 一次往返失败时，reason 是什么 */
function reasonForError(err: unknown): ReasonCode {
  if (err instanceof AppError && err.code === 'CONN_TIMEOUT') return 'timeout';
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|超时/i.test(message)) return 'timeout';
  return 'service_down';
}

export class TagSampler {
  /** 每个 reader 的解析状态（两次采样之间的历史） */
  private readonly contexts = new Map<string, ReaderContext>();

  constructor(
    private readonly pack: BoardPack,
    private readonly connection: ExecRunner,
    private readonly store: TagStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 某个 reader 的解析上下文（**每个 reader 一份**） */
  private contextFor(readerId: string): ReaderContext {
    let ctx = this.contexts.get(readerId);
    if (ctx === undefined) {
      ctx = { state: {} };
      this.contexts.set(readerId, ctx);
    }
    return ctx;
  }

  /** 在包里找一个 reader（readers 或 custom） */
  private findReader(readerId: string): ReaderDef {
    const reader = [...this.pack.readers, ...this.pack.custom].find((r) => r.id === readerId);
    if (reader === undefined) {
      throw makeError('PACK_INVALID', `包里没有 reader「${readerId}」`, {
        detail: { readerId, pack: this.pack.id },
      });
    }
    return reader;
  }

  /**
   * 采一个 poll group。
   *
   * **这一组里的 reader 共享一次往返**——所以它们的取数片段合成一条命令。
   */
  async sampleGroup(groupId: string): Promise<void> {
    const group = this.pack.poll_groups.find((g) => g.id === groupId);
    if (group === undefined) {
      throw makeError('PACK_INVALID', `包里没有轮询组「${groupId}」`, {
        detail: { groupId, pack: this.pack.id },
      });
    }

    const readers = group.readers.map((id) => this.findReader(id));

    // 取数片段。
    // **需要远端路径的 reader（script）**：运行时还没把脚本推到板子上，
    // 就**不生成那条注定失败的命令**——如实报「没推上去」。
    const plans: { id: string; fragment: string }[] = [];
    // **没进这条命令的 reader**（运行时还没准备好）——后面那一轮不许再报一次
    const skipped = new Set<string>();
    for (const r of readers) {
      const kind = getKind(r.kind);
      if (kind === undefined) {
        throw makeError('PACK_INVALID', `reader「${r.id}」的 kind「${r.kind}」不在 v1 的清单里`, {
          detail: { readerId: r.id, kind: r.kind },
        });
      }
      const args = r.args ?? {};
      if (kind.needsRemotePath === true && typeof args['remote_path'] !== 'string') {
        this.reportStatus(
          r,
          'unavailable',
          'service_down',
          '脚本还没推到板子上（运行时没给 remote_path）——推脚本是运行时的事（契约 §3.3）',
        );
        skipped.add(r.id);
        continue;
      }
      plans.push({ id: r.id, fragment: kind.fetch(args) });
    }
    if (plans.length === 0) return;

    const groupCommand = buildGroupCommand(plans);

    let stdout: string;
    try {
      const result = await this.connection.exec(groupCommand.command);
      if (result.timedOut) {
        // 传输层可能带了「下一步查什么」（串口超时的头号嫌疑是**端口被别的程序占用**）
        const detail = result.hint ?? '这次往返超时了（事实 G1：统一 124）';
        for (const reader of readers) {
          this.reportRoundTripFailure(reader, 'timeout', detail);
        }
        return;
      }
      stdout = result.stdout;
    } catch (err) {
      const reason = reasonForError(err);
      const detail = err instanceof Error ? err.message : String(err);
      for (const reader of readers) {
        this.reportRoundTripFailure(reader, reason, detail);
      }
      return;
    }

    const sections = splitSections(stdout, groupCommand.markers);

    for (const reader of readers) {
      // 已经报过「没推上去」的，不许再报一次「这一段没有回包」
      if (skipped.has(reader.id)) continue;
      const section = sections.get(reader.id);
      if (section === null || section === undefined) {
        // 这一段没跑起来（marker 没出现）
        this.reportRoundTripFailure(reader, 'service_down', '这一段没有回包');
        continue;
      }
      if (!section.complete) {
        // **截断了**（板子只回了一半）——**不发布半截数据**。
        // 契约 §2.1.1：「读出来了但值坏了」是 error，不是 ok。
        // 把 format: integer 的 1000 截成 100 当正常值发布，是**假数**。
        this.reportStatus(
          reader,
          'error',
          'parse_error',
          '这一段没收到结束标记——板子只回了一半（不发布半截数据）',
        );
        continue;
      }

      const kind = getKind(reader.kind)!;
      const result = kind.parse(section.text, reader.args ?? {}, this.contextFor(reader.id));

      if (result.status === 'unavailable' || result.status === 'error') {
        // 「资源不在」与「读出来了但坏了」是**两件事**（契约 §2.1.1）：
        // 前者要引导用户去挂 debugfs，后者是「读失败」。
        this.reportStatus(reader, result.status, result.reason, result.detail);
        continue;
      }

      if (result.status === 'pending') {
        // 首读：还没有 sample。**没有通配符的 tag** 可以先报 pending，
        // 通配符的 tag 现在还不知道具体名字（等第二次采样）。
        for (const p of reader.provides) {
          if (p.tag.includes('*')) continue;
          this.store.put({
            tag: p.tag,
            value: null,
            unit: unitForTag(p.tag),
            status: 'pending',
            at: this.now(),
          });
        }
        continue;
      }

      // ok：把 sample 绑成 tag
      for (const p of reader.provides) {
        for (const [sampleName, value] of Object.entries(result.samples)) {
          const tag = bindSampleToTag(p.tag, p.sample, sampleName);
          if (tag === null) continue;
          this.store.put({
            tag,
            value,
            unit: unitForTag(tag),
            status: 'ok',
            at: this.now(),
          });
        }
      }
    }
  }

  /**
   * 这个 reader 不可用/出错：它那些 tag 全部报同一个状态。
   *
   * ── 通配 tag 怎么办（**C27 的那条洞** ✓）──
   *
   * → **首读**时通配 tag 的具体名字**还不知道** ✓ → **跳过** ✓（**不猜** ✓）
   * → 但**读过之后**具体名字**已经知道了** ✓ → **这时跳过就是漏洞** ✓
   *   （一个 `cpu` reader 整个挂了 → `cpu.core.3.usage` 还是 `ok` + 旧值 ✓
   *    → **依赖它的卡片不会被判 degraded** ✓ → **陈旧数据被当成新的** ✓）
   *
   * → **修法**：标**已经读到过的那些实例** ✓（**用已知的** ✓ —— **不是编一个出来** ✓ ✓）
   * → 契约 §2.3 本来就说「**刷新停了 → stale**」✓ → **这是实现层的洞** ✓，
   *   **不需要新的契约概念** ✓（族级状态？不需要 ✓ —— 族里的每个成员各标各的 ✓ 就够了 ✓）
   */
  private reportStatus(
    reader: ReaderDef,
    status: 'unavailable' | 'error',
    reason: ReasonCode,
    detail: string,
  ): void {
    for (const p of reader.provides) {
      if (p.tag.includes('*')) {
        // **标已知的那些实例** ✓（**不猜** ✓ —— 用读过的 ✓）
        for (const tag of this.knownInstancesOf(p.tag)) {
          this.store.put({
            tag,
            value: null,
            unit: unitForTag(tag),
            status,
            reason,
            detail,
            at: this.now(),
          });
        }
        continue;
      }
      this.store.put({
        tag: p.tag,
        value: null,
        unit: unitForTag(p.tag),
        status,
        reason,
        detail,
        at: this.now(),
      });
    }
  }

  /**
   * 这个通配模式**已经读到过的那些具体 tag** ✓。
   *
   * → **不猜** ✓（契约 §十 ✓）—— 只用**读到过的** ✓，**不编一个出来** ✓
   * → 一个都没有 → **空数组** ✓（那就是「还没读出来过」✓ → 首读那一档 ✓）
   */
  private knownInstancesOf(tagPattern: string): string[] {
    return this.store
      .all()
      .filter((reading) => matchTagPattern(tagPattern, reading.tag))
      .map((reading) => reading.tag);
  }

  /**
   * 一次**往返失败**（超时、传输断了）：该组的 tag 报 stale 或 error。
   *
   * 契约 §2.1：「ok → stale = 本次刷新失败，但**保留上一次的值**」——
   * 一次 ADB 抖动不该让面板上的仪表整片消失（那是「假数」的另一种：没有数）。
   */
  private reportRoundTripFailure(reader: ReaderDef, reason: ReasonCode, detail: string): void {
    for (const p of reader.provides) {
      if (p.tag.includes('*')) {
        // **通配 tag：标已知的那些实例** ✓（**C27** ✓ —— 契约 §2.3：「刷新停了 → stale」✓）
        // → **不猜** ✓（用读到过的 ✓）→ **陈旧数据不再被当成新的** ✓
        for (const tag of this.knownInstancesOf(p.tag)) {
          const status = this.store.failureStatusFor(tag);
          this.store.put({
            tag,
            value: null,
            unit: unitForTag(tag),
            status,
            reason,
            detail,
            at: this.now(),
          });
        }
        continue;
      }
      const status = this.store.failureStatusFor(p.tag);
      this.store.put({
        tag: p.tag,
        value: null,
        unit: unitForTag(p.tag),
        status,
        reason,
        detail,
        at: this.now(),
      });
    }
  }
}
