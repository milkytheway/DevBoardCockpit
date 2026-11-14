import { makeError } from '../../shared/errors';
import { RoundTripQueue } from '../hal/round-trip-queue';
import type { Connection } from '../hal/connection';
import type { ConnectionProfile } from '../profiles/schema';

/**
 * 目标登记处 —— **role → 连接**。
 *
 * ── 它补的是哪个缺口 ──
 *
 * M6 的执行器**只能对运行时那条连接执行**（板子）——
 * 接线给的是 `runtime.runTransaction`（`src/main/index.ts`）。
 * 而「**在客机上跑一条 scp**」（直传，ADR-D31 R7）要的是**另一条连接**。
 * → 计划 5 的 **A17** 写了「执行器要能对指定的连接执行」，**实现里一直缺着** ✗。
 * → 这一层就是补它：**按 profile id 拿到连接**，执行器就能指名目标了 ✓。
 *
 * ── 三条规矩 ──
 *
 * 1. **一个目标一条线**：每个 profile 一条连接 + **它自己的队列**
 *    （串口是一根线——两个目标各走各的 ✓）。
 * 2. **profile 不存在 → 报错**：绝不悄悄连到别的目标 ✗。
 * 3. **同一个目标复用同一条连接**：重开一条 ssh 要好几秒 ✗。
 */
export interface TargetRegistryOptions {
  /** 按 id 找 profile（宿主加载好的那批；找不到就是**没有这个目标**） */
  profileFor: (profileId: string) => ConnectionProfile | undefined;
  /** 建连接（宿主给：它知道 adb 路径、假设备那些事） */
  createConnection: (profile: ConnectionProfile) => Connection;
  /** 事务的默认 deadline（毫秒）——长步骤要自己传大的 */
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 3_000;

export class TargetRegistry {
  /** 已建立的连接（按 profile id） */
  private readonly connections = new Map<string, Connection>();
  /** 每个目标自己的队列（一条线一个队列） */
  private readonly queues = new Map<string, RoundTripQueue>();
  /** 正在开的连接（避免并发开两条同一条线） */
  private readonly opening = new Map<string, Promise<Connection>>();

  constructor(private readonly opts: TargetRegistryOptions) {}

  /** 现在开着几个目标（诊断用） */
  get openCount(): number {
    return this.connections.size;
  }

  /**
   * 拿到某个目标的连接（**第一次开，之后复用**）。
   *
   * @throws 目标不存在 → `CONN_OPEN_FAILED`（**不静默回落**）
   */
  async connectionFor(profileId: string): Promise<Connection> {
    const existing = this.connections.get(profileId);
    if (existing !== undefined) return existing;

    const inFlight = this.opening.get(profileId);
    if (inFlight !== undefined) return inFlight;

    const opening = this.open(profileId);
    this.opening.set(profileId, opening);
    try {
      const connection = await opening;
      this.connections.set(profileId, connection);
      return connection;
    } finally {
      this.opening.delete(profileId);
    }
  }

  /**
   * 在某个目标上跑一次**独占事务**。
   *
   * ── 为什么是「独占」 ──
   *
   * 同一个目标上的两次往返**不能并发**（串口是一根线；ssh 也是一条会话一个通道）。
   * → 走**它自己的队列**（`action-verify` 级：动作与回读不可拆分，SPEC-D22）✓。
   *
   * ── deadline ──
   *
   * 默认 3 秒（同连接级默认，ADR-D23）；**长步骤要自己传大的**
   * （编译是分钟级 → 尖兵实测传输波动 20 倍，A14）。
   * deadline 只管**排队**等了多久，**不管跑多久** ✓。
   */
  async runOn<T>(
    profileId: string,
    fn: (connection: Connection) => Promise<T>,
    opts: { deadlineMs?: number } = {},
  ): Promise<T> {
    const connection = await this.connectionFor(profileId);
    const queue = this.queueFor(profileId);
    return queue.run('action-verify', () => fn(connection), {
      deadlineMs: opts.deadlineMs ?? this.opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
    });
  }

  /** 收摊：关掉所有连接（流程跑完时调） */
  async closeAll(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.queues.clear();
    for (const connection of connections) {
      try {
        await connection.close();
      } catch {
        // **关不掉不是致命的**：一条目标没关掉，不该让整次运行的账丢掉
      }
    }
  }

  private queueFor(profileId: string): RoundTripQueue {
    const existing = this.queues.get(profileId);
    if (existing !== undefined) return existing;
    const created = new RoundTripQueue();
    this.queues.set(profileId, created);
    return created;
  }

  private async open(profileId: string): Promise<Connection> {
    const profile = this.opts.profileFor(profileId);
    if (profile === undefined) {
      throw makeError('CONN_OPEN_FAILED', `没有这个连接 profile：${profileId}`, {
        detail: { profileId },
      });
    }
    const connection = this.opts.createConnection(profile);
    await connection.open();
    return connection;
  }
}
