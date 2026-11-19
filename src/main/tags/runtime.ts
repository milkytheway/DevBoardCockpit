import { RoundTripQueue } from '../hal/round-trip-queue';
import type { Connection } from '../hal/connection';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { deviceKeyOf } from '../profiles/schema';
import type { TagReading } from '../../shared/tag-reading';
import { AppError, type ErrorCode } from '../../shared/errors';
import type { ActionDef, BoardPack } from './schema';
import { matchTagPattern } from './vocabulary';
import { TagStore, type TagSample } from './store';
import { packView, type PackView } from './pack-view';
import type { RuntimeState, RuntimeStatus } from '../../shared/runtime-status';
import { TagSampler } from './sampler';
import { PollScheduler } from './scheduler';
import { resolvePack } from './binding';
import { validatePack, errorsOf } from './validator';

/**
 * 运行时的状态类型**住在 shared**（`src/shared/runtime-status.ts`）——
 * 它要经 IPC 上屏（面板得说「为什么没有数」），而 shared 是 IPC 类型的唯一住处。
 * 这里再导出一次，既有 import 不断。
 */
export type { RuntimeState, RuntimeStatus };

/**
 * tag 运行时 —— 把 M3/M4 写好的库**接进应用**。
 *
 * ── 它管四件事 ──
 *
 * | 事 | 为什么 |
 * |---|---|
 * | 建连接 → 绑包 → 校验 → 起调度器 | 「值要自己会动」的四个前提，缺一不可 |
 * | 读数**只经 TagStore** 进出 | ADR-D22：一份状态只有一份副本 |
 * | 晚订阅**不丢当前值** | 晚打开的窗口也该看到现在的数（契约 §2.1） |
 * | 失败**说清楚** | 「这块板没有板型包」与「连不上」是两件事 |
 *
 * ── 连接是谁的？──
 *
 * **运行时自己建一条连接**，与终端标签的连接**分开**。
 *
 * 理由：面板必须在**没有终端标签**的时候也有数——
 * 「看板子的读数」是这个产品的主线，终端是附带的。
 *
 * 代价（**明说，不藏**）：**串口是独占的**——
 * 运行时与终端标签各要一条连接，同一个 COM3 上**只能有一个**。
 * 第二个会失败（端口被占用），而失败是**看得见的**（不是静默）。
 * 这是串口这条路的**已知限制**，不是本模块的 bug。
 */

export interface TagRuntimeOptions {
  /** 板型包目录的父目录（**内置那一份** ✓） */
  packsDir: string;
  /**
   * **用户自己的板型包目录** ✓（**可选** ✓ —— 不存在就跳过 ✓）。
   *
   * → **同 id 时用户优先** ✓（与 `profiles/loader.ts` 同款 ✓）。
   */
  userPacksDir?: string;
  /** 建连接 */
  createConnection: (profile: ConnectionProfile, log: SessionLog) => Connection;
  /** 建会话日志 */
  createLog: (label: string, transport: string) => SessionLog;
}

export class TagRuntime {
  private readonly store = new TagStore();
  /**
   * 一切往返都经这条队列（契约 §1.2.1 · ADR-D23）。
   *
   * **它是实例字段，不是 `start()` 里的局部变量**——
   * 动作执行器要用**同一条**队列跑「执行 + 回读」那个独占事务
   * （`runTransaction`）；队列是局部的，动作执行器就够不着它。
   */
  private readonly queue = new RoundTripQueue();
  private readonly listeners: ((reading: TagReading) => void)[] = [];
  private scheduler: PollScheduler | undefined;
  /** 采样器（**定向读**要用它） */
  private sampler: TagSampler | undefined;
  private connection: Connection | undefined;
  private state: RuntimeState = 'idle';
  private detail: string | undefined;
  private profileId: string | undefined;
  /**
   * **当前那块板的 `device_key`** ✓（契约 `spec/02` §10.2 ✓）。
   *
   * → **板实物与连接是两层** ✓ —— 一块板有 ADB / 串口 / SSH 三条连接 ✓
   * → **凭据要绑它** ✓（契约 `spec/04` §2.4.1 的第六项 ✓）。
   */
  private deviceKey: string | undefined;
  /** 上次失败的错误码（`RuntimeStatus.detailCode` 的来源） */
  private detailCode: ErrorCode | undefined;
  /** 当前绑定的板型包（**执行器要查动作的定义**——`spec/02` §4） */
  private pack: BoardPack | undefined;

  constructor(private readonly opts: TagRuntimeOptions) {}

  /** 现在的状态 */
  get status(): RuntimeStatus {
    return {
      state: this.state,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(this.profileId === undefined ? {} : { profileId: this.profileId }),
      ...(this.detailCode === undefined ? {} : { detailCode: this.detailCode }),
    };
  }

  /**
   * 开始采某个 profile 的读数。
   *
   * **不抛错**——失败都进 `status`：
   * 「这块板没有板型包」与「连不上」是**两件事**，
   * 都要让用户看见（契约 §十：「报『这块板没有板型包』」）。
   */
  async start(profile: ConnectionProfile): Promise<RuntimeStatus> {
    this.stop();
    this.profileId = profile.id;
    // **这块板是哪块板** ✓（**板实物与连接是两层** ✓ —— 契约 `spec/02` §10.2 ✓）
    this.deviceKey = deviceKeyOf(profile);
    this.detailCode = undefined;

    // 1) 建连接
    const log = this.opts.createLog(`tags-${profile.id}`, profile.transport);
    const connection = this.opts.createConnection(profile, log);
    try {
      await connection.open();
    } catch (err) {
      this.state = 'error';
      this.detail = err instanceof Error ? err.message : String(err);
      // **带上错误码**：判「串口是不是被别的程序占了」要靠封闭的码，不靠中文消息
      this.detailCode = err instanceof AppError ? err.code : undefined;
      return this.status;
    }
    this.connection = connection;

    // 2) 绑板型包（连接指名优先，否则按型号自动识别）
    const binding = await resolvePack({
      connection,
      boardPackId: profile.board_pack ?? null,
      packsDir: this.opts.packsDir,
      userPacksDir: this.opts.userPacksDir,
    });
    if (binding.pack === null) {
      this.state = 'no-pack';
      this.detail = binding.reason;
      await this.closeConnection();
      return this.status;
    }

    this.pack = binding.pack;

    // 3) 校验（过不了自己校验器的包不采）
    const errs = errorsOf(validatePack(binding.pack));
    if (errs.length > 0) {
      this.state = 'error';
      this.detail = `板型包「${binding.pack.id}」没过校验：${errs
        .map((e) => `规则 ${e.rule} · ${e.path}`)
        .join('；')}`;
      await this.closeConnection();
      return this.status;
    }

    // 4) 起调度器（一切往返都经队列，契约 §1.2.1）
    const sampler = new TagSampler(binding.pack, connection, this.store);
    this.sampler = sampler;
    this.scheduler = new PollScheduler(binding.pack, sampler, this.queue);
    this.scheduler.start();

    // 读数只经 TagStore 出（ADR-D22）
    this.store.subscribe((reading) => {
      for (const listener of this.listeners) listener(reading);
    });

    this.state = 'running';
    this.detail = undefined;
    return this.status;
  }

  /**
   * 在**这条连接**上跑一次独占事务。
   *
   * ── 谁用这个 ──
   *
   * **M6 的动作执行器**：一次动作 = 「执行命令 + 回读」，
   * 而这两步**必须是一个不可拆分的独占事务**（ADR-D23 / SPEC-D22）：
   * 回读若被采样插队，读到的可能是**别的命令的输出**——
   * 「回读不符」就成了假阴性，驾驶舱会显示错的真实状态。
   *
   * @param fn 拿到连接去干活（执行 + 回读都在里面）
   * @throws 没连上任何连接（`CONN_CLOSED`）
   */
  async runTransaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = this.connection;
    if (connection === undefined) {
      throw new AppError('CONN_CLOSED', '运行时还没连上任何连接');
    }
    return this.queue.run('action-verify', () => fn(connection));
  }

  /** 当前板型包的 id（**确认凭据要绑它**） */
  /**
   * **动作清单**（**给设置页的权限区用** ✓ —— ADR-D47 ✓）。
   *
   * → **只要 id 与 label** ✓ —— **参数与命令不给** ✓（同 `pack-view` 的那条 ✓）
   */
  get actionSummaries(): { id: string; label?: string; danger: string }[] {
    return (this.pack?.actions ?? []).map((action) => ({
      id: action.id,
      ...(action.label === undefined ? {} : { label: action.label }),
      danger: action.danger,
    }));
  }

  get packId(): string | undefined {
    return this.pack?.id;
  }

  /**
   * **当前那块板的 `device_key`** ✓（契约 `spec/02` §10.2 ✓）。
   *
   * → **没有运行时连接就是 `undefined`** ✓（不猜 ✓）
   */
  get currentDeviceKey(): string | undefined {
    return this.deviceKey;
  }

  /**
   * **当前板型包的脱敏只读投影** ✓（MCP 的读侧工具要它 ✓）。
   *
   * → **不给原始的包** ✓ —— 原始 args 里有 `command` 与宿主路径 ✓
   *   （`tags/pack-view.ts` 的放行表挡掉了 ✓ —— 契约 §1.3 ✓）。
   * → **没有包就是 `null`** ✓（不猜 ✓）。
   */
  get packView(): PackView | null {
    return packView(this.pack);
  }

  /**
   * **板型包里声明的动作**（**完整定义** ✓ —— 参数 ✓ · guard ✓ · command ✓ · readback ✓）。
   *
   * → **不是** `packView.actions` ✓（那个只有 id ✓ —— 那是给 agent 看的清单 ✓）。
   * → **执行器要完整定义** ✓（它要 `command` ✓ · `guard` ✓ · `readback` ✓）。
   */
  get actionDefs(): ActionDef[] {
    return this.pack?.actions ?? [];
  }

  /**
   * **样本缓冲**（最近若干个样本）✓ —— 支撑 `sample_tag(name, n)` 与 `describe_tag.history` ✓。
   *
   * → **先定向采一次** ✓（契约 v5 §2.1 ✓：不采的话 agent 拿到的是**冻结的旧样本** ✓）。
   */
  async sampleTagHistory(tag: string, n: number): Promise<TagSample[]> {
    await this.sampleTag(tag);
    return this.store.history(tag, n);
  }

  /**
   * **样本缓冲**（**不采样** ✓ —— 同步 ✓）。
   *
   * → `describe_tag.history` 要它 ✓（**描述一个量不需要惊动板子** ✓）。
   * → `sample_tag` 要的是**采过之后**的那份 ✓（`sampleTagHistory` ✓）。
   */
  sampleHistory(tag: string, n: number): TagSample[] {
    return this.store.history(tag, n);
  }

  /**
   * 这条连接**有退出码吗**（串口没有，事实 S5）。
   *
   * 回读的形式 3 / 4 都看退出码 → 没有的话必须被拒绝
   * （契约 §4.4 末尾）。
   */
  get hasExitCode(): boolean {
    return this.connection?.capabilities().exitCode === true;
  }

  /**
   * 板型包里声明的动作（按 id）——**执行器要用**（`spec/02` §4）。
   *
   * 动作的定义**只在板型包里**（卡片不能自己声明命令，
   * 那是契约 §五的红线），所以执行器得从这里拿。
   */
  actionDef(actionId: string): ActionDef | undefined {
    return this.pack?.actions.find((action) => action.id === actionId);
  }

  /**
   * **定向**读一次某个 tag（**新鲜的**——不是等下一个周期的那份）。
   *
   * 回读的形式 1 要的就是这个（契约 §4.4）：
   * 「板子说起来了」的标准是一次**当下**的读数，
   * 等下一个采样周期的话，回读可能读到**动作之前**的值。
   */
  async sampleTag(tag: string): Promise<TagReading | undefined> {
    const pack = this.pack;
    if (pack === undefined) return undefined;
    const group = pack.poll_groups.find((g) =>
      [...g.readers].some((readerId) => {
        const reader = [...pack.readers, ...pack.custom].find((r) => r.id === readerId);
        return reader?.provides.some((p) => p.tag === tag || matchTagPattern(p.tag, tag)) === true;
      }),
    );
    if (group === undefined) return undefined;
    await this.sampler?.sampleGroup(group.id);
    return this.store.get(tag);
  }

  /** 停下：停调度器、关连接 */
  stop(): void {
    this.scheduler?.stop();
    this.scheduler = undefined;
    void this.closeConnection();
    this.state = 'idle';
    this.detail = undefined;
    this.detailCode = undefined;
  }

  /** 当前的读数快照（**晚订阅的人靠它看到现在的数**） */
  readings(): TagReading[] {
    return this.store.all();
  }

  /** 听读数的变化 */
  subscribe(cb: (reading: TagReading) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const at = this.listeners.indexOf(cb);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection === undefined) return;
    await connection.close().catch(() => undefined);
  }
}

/* ══════════════════════════════════════════════════════════════════
   起不来了怎么办（计划 4 Task 2）
   ── 三个真 bug：`docs/19` P1 / P2（2026-11-13 实测）──
   ══════════════════════════════════════════════════════════════════ */

/** 一个「可以试着起运行时」的候选 */
export interface RuntimeCandidate {
  profileId: string;
  profile: ConnectionProfile;
}

/**
 * 退避档位（毫秒）。
 *
 * **为什么有退避**：板子可能**还没插上**、**adb 还没授权**——
 * 这两种情况**过一会儿就会好**，所以要隔一会儿再试。
 * 档位到 30s 封顶：再密就吵了，再疏就慢了。
 */
export const RETRY_BACKOFF_MS: readonly number[] = [2000, 5000, 10000, 30000];

/**
 * 挑候选：**只留绑了板型包的 profile**。
 *
 * **修 P2**：原来用的是 `board_pack !== undefined`——
 * 而 `local.json` 与 `ubuntu-ssh.json` 的 `board_pack` 是 **`null`**，
 * `null !== undefined` 为真 → 它们**被当成了候选** →
 * 运行时去连**本机**和 **192.168.100.10 的 SSH**，读它们的
 * `/proc/device-tree/model`（必然认不出来）。
 *
 * 代价不是「白开两条连接」那么简单：串口是**独占**的，
 * 一次失败的串口尝试可能占着端口不放，**把能用的 adb 挤掉**。
 *
 * 判据用 `!= null`（同时剔掉 `null` 与 `undefined`）。
 */
export function pickCandidates(profiles: ConnectionProfile[]): RuntimeCandidate[] {
  return profiles
    .filter((p) => p.board_pack != null)
    .map((p) => ({ profileId: p.id, profile: p }));
}

/**
 * 判「是不是端口被别的程序占了」。
 *
 * **先看错误码**（`PORT_BUSY` 是封闭枚举里的一项，`hal/serial.ts` 就在用），
 * **再退回消息匹配**——消息匹配是兜底，不是主判据
 * （改一个字就失效的那种判据不算判据）。
 */
export function isPortBusy(detail: string, code?: string): boolean {
  if (code === 'PORT_BUSY') return true;
  return /被占用|EBUSY|EACCES/i.test(detail);
}

/**
 * 运行时能被替身冒充的那部分。
 *
 * **为什么是结构类型而不是 `TagRuntime`**：`TagRuntime` 有私有字段，
 * 替身**冒充不了**（TypeScript 会拒绝）→ 测试就只能靠 `as any` 强转，
 * **测的就不是真接口了**。这里收窄到「只需要 `start`」，
 * 真 `TagRuntime` 天然满足，替身也能进。
 */
export interface TagRuntimeLike {
  start(profile: ConnectionProfile): Promise<RuntimeStatus>;
}

/**
 * 起运行时：挨个试候选，失败就退避重试。
 *
 * **修 P1**：原来每个候选只试一次就放弃 →
 * **板子后插上面板永远空着**，必须重启应用。
 *
 * **串口政策**（2026-11-14 用户拍板）：某个候选**因端口被占**而失败时，
 * **跳过它继续试下一个**，并且**后续轮次不再试它**——
 * 占着端口的是**别的程序**，等它退出才有用，
 * 而**面板不该被一根被占的串口拖死**。
 *
 * @param opts.sleep 注入的等待函数（测试用假 sleep，不真的等）
 */
export async function startWithRetry(
  runtime: TagRuntimeLike,
  candidates: RuntimeCandidate[],
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<RuntimeStatus> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (candidates.length === 0) {
    return { state: 'error', detail: '没有带板型包的连接（候选为空）' };
  }

  /** 端口被占的候选：占着端口的是别的程序，重试它没有意义 */
  const skipped = new Set<string>();
  let last: RuntimeStatus = { state: 'error', detail: '没有试过任何候选' };

  // 轮次 = 1（立刻）+ 每个退避档位之后再来一轮
  for (let round = 0; round <= RETRY_BACKOFF_MS.length; round += 1) {
    for (const candidate of candidates) {
      if (skipped.has(candidate.profileId)) continue;
      const status = await runtime.start(candidate.profile);
      if (status.state === 'running') return status;
      last = status;
      if (isPortBusy(status.detail ?? '', status.detailCode)) {
        skipped.add(candidate.profileId);
      }
    }
    if (round < RETRY_BACKOFF_MS.length) {
      await sleep(RETRY_BACKOFF_MS[round]);
    }
  }

  return last;
}
