import type { BoardPack, ReaderDef } from './schema';
import { getKind, type ReaderContext } from './kinds';
import { buildGroupCommand, splitSections } from './fetch';
import { bindSampleToTag, unitForTag } from './vocabulary';
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

    // 取数片段
    const plans = readers.map((r) => {
      const kind = getKind(r.kind);
      if (kind === undefined) {
        throw makeError('PACK_INVALID', `reader「${r.id}」的 kind「${r.kind}」不在 v1 的清单里`, {
          detail: { readerId: r.id, kind: r.kind },
        });
      }
      return { id: r.id, fragment: kind.fetch(r.args ?? {}) };
    });

    const groupCommand = buildGroupCommand(plans);

    let stdout: string;
    try {
      const result = await this.connection.exec(groupCommand.command);
      if (result.timedOut) {
        for (const reader of readers) {
          this.reportUnavailable(reader, 'timeout', '这次往返超时了（事实 G1：统一 124）');
        }
        return;
      }
      stdout = result.stdout;
    } catch (err) {
      const reason = reasonForError(err);
      const detail = err instanceof Error ? err.message : String(err);
      for (const reader of readers) {
        this.reportUnavailable(reader, reason, detail);
      }
      return;
    }

    const sections = splitSections(stdout, groupCommand.markers);

    for (const reader of readers) {
      const text = sections.get(reader.id);
      if (text === null || text === undefined) {
        // 这一段没跑起来（marker 没出现）
        this.reportUnavailable(reader, 'service_down', '这一段没有回包');
        continue;
      }

      const kind = getKind(reader.kind)!;
      const result = kind.parse(text, reader.args ?? {}, this.contextFor(reader.id));

      if (result.status === 'unavailable') {
        this.reportUnavailable(reader, result.reason, result.detail);
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

  /** 这个 reader 不可用：它那些**不带通配符**的 tag 全部报不可用 */
  private reportUnavailable(reader: ReaderDef, reason: ReasonCode, detail: string): void {
    for (const p of reader.provides) {
      // 带通配符的 tag 现在还不知道具体名字——**不猜**（契约 §十：「不猜」）
      if (p.tag.includes('*')) continue;
      this.store.put({
        tag: p.tag,
        value: null,
        unit: unitForTag(p.tag),
        status: 'unavailable',
        reason,
        detail,
        at: this.now(),
      });
    }
  }
}
