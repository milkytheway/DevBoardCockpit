import { apiByName, type CardApiContext, type CardServices } from './api-registry';
import { permissionCovers, type CardPermissions } from './permissions';
import { TagsService, type TagsServiceDeps } from './tags-service';
import type { TagReading } from '../../shared/tag-reading';
import type { CardRequest, CardResponse } from '../../shared/ipc-contract';

/**
 * 一个卡片实例的**会话**。
 *
 * ── 会话是权限的载体 ──
 *
 * 权限集在**建卡时**定死（契约 §3.3：卡片不能运行时提权）。
 * 会话把它带在身上，于是「这个实例能看什么」在**每一层**都是同一个答案：
 * 读侧过滤、订阅过滤、列表过滤，都用 `session.perms`。
 *
 * ── 为什么会话在 main 而不是页面 ──
 *
 * 页面是不可信的一侧（卡片就住在它旁边）。
 * 权限判定**必须在可信进程**（ADR-D28 / `docs/21` §4.4）。
 */

/** 读数的来源（TagStore 满足它） */
export interface RuntimeReader {
  readings(): TagReading[];
  subscribe(cb: (r: TagReading) => void): () => void;
}

export interface CardSession {
  instanceId: string;
  cardId: string;
  connectionId: string | null;
  perms: CardPermissions;
  createdAt: number;
  services: CardServices;
}

export interface CardSessionManagerDeps {
  /** 读数的来源 */
  runtime: RuntimeReader;
  /** 这张卡的权限集（来自 manifest + 已授权的动作） */
  permsFor: (cardId: string) => CardPermissions;
  now?: () => number;
  /** 推给某个实例（Task 10 接上） */
  push?: (instanceId: string, payload: unknown) => void;
  /**
   * 每张卡的存储（**按卡片 id 分开**——存储是每卡一个命名空间）。
   *
   * 做成「工厂」而不是一个实例：会话是**每卡一份**的，
   * 存储也必须跟着卡走，否则 A 卡的写入会落到 B 卡上。
   */
  storageFor?: (cardId: string) => CardServices['storage'];
  /** 每张卡的日志 */
  logFor?: (cardId: string) => (level: 'error' | 'warn' | 'info', message: string) => void;
  /**
   * 每张卡的写侧（动作执行器）。
   *
   * 做成**工厂**而不是一个实例：执行器要拿着**这张卡的授权**，
   * 而授权是每卡一份的。
   */
  actionsFor?: (cardId: string) => CardServices['actions'];
  /** 当前连接的身份（给 `capabilities()` 用） */
  connectionInfo?: (connectionId: string | null) => { label: string; transport: string } | null;
}

/**
 * 一个实例最多能订阅几次（RF-4）。
 *
 * ── 为什么要有上限 ──
 *
 * 卡片是 AI 写的任意网页。它可以**循环订阅**：
 * ```
 * setInterval(() => cockpit.tags.subscribe('cpu.usage', cb), 100)
 * ```
 * 每订阅一次，运行时上就多一个监听器 → 每次推送都 fan-out N 份 →
 * **main 的内存与 IPC 被打满**，工作台跟着卡死。
 *
 * 契约 §六：「**单卡崩溃不影响其他卡，也不影响工作台**」——
 * 「影响」在这里就是「把 main 打满」。
 *
 * → 上限由**宿主**来守（卡片不会自觉）。超了回
 * `{ ok:false, reason:'too_many_subscriptions' }`（契约 §7.7：不抛异常，回失败）。
 */
export const MAX_SUBSCRIPTIONS_PER_SESSION = 64;

export class CardSessionManager {
  private readonly sessions = new Map<string, CardSession>();
  /**
   * 每个实例的订阅 → 退订函数（RF-4）。
   *
   * **为什么必须存着**：`deps.subscribe` 返回的退订函数是**唯一**能真正
   * 把监听器从运行时摘掉的东西。丢掉它 = 订阅永远解不掉。
   */
  private readonly subscriptions = new Map<string, Map<string, () => void>>();

  constructor(private readonly deps: CardSessionManagerDeps) {}

  /** 开一个会话（同一实例重复调用是同一个会话） */
  open(instanceId: string, cardId: string, connectionId: string | null): CardSession {
    const existing = this.sessions.get(instanceId);
    if (existing !== undefined) return existing;

    const perms = this.deps.permsFor(cardId);
    const now = this.deps.now ?? (() => Date.now());
    /** 这个实例的订阅（订阅 id → 退订函数） */
    const subs = new Map<string, () => void>();
    this.subscriptions.set(instanceId, subs);
    const tagsDeps: TagsServiceDeps = {
      readings: () => this.deps.runtime.readings(),
      subscribe: (cb) => this.deps.runtime.subscribe(cb),
      now,
    };
    const tags = new TagsService(perms, tagsDeps);
    const push = this.deps.push;

    const services: CardServices = {
      tags: {
        get: (name) => tags.get(name),
        list: () => tags.list(),
        subscribe: (name, subscriptionId) => {
          if (subs.size >= MAX_SUBSCRIPTIONS_PER_SESSION) {
            return { ok: false, reason: 'too_many_subscriptions' };
          }
          // **退订函数要存着**——不然这个订阅永远解不掉（RF-4）
          const dispose = tags.subscribe(name, (reading) => {
            push?.(instanceId, { type: 'push', subscriptionId, value: reading });
          });
          subs.set(subscriptionId, dispose);
          return { ok: true };
        },
        subscribePattern: (pattern, subscriptionId) => {
          if (subs.size >= MAX_SUBSCRIPTIONS_PER_SESSION) {
            return { ok: false, reason: 'too_many_subscriptions' };
          }
          const dispose = tags.subscribePattern(pattern, (reading) => {
            push?.(instanceId, { type: 'push', subscriptionId, value: reading });
          });
          subs.set(subscriptionId, dispose);
          return { ok: true };
        },
        degradation: () => tags.degradation(),
      },
      actions: this.deps.actionsFor?.(cardId) ?? emptyActions(),
      storage: this.deps.storageFor?.(cardId) ?? emptyStorage(),
      log: (level, message) => {
        this.deps.logFor?.(cardId)(level, message);
      },
    };

    const session: CardSession = { instanceId, cardId, connectionId, perms, createdAt: now(), services };
    this.sessions.set(instanceId, session);
    return session;
  }

  /** 取一个会话 */
  get(instanceId: string): CardSession | undefined {
    return this.sessions.get(instanceId);
  }

  /**
   * 关一个会话（卡片没了 / 连接变了 / 卡片重载了）。
   *
   * **退订函数在这里被调用**——这是「订阅不会一直挂着」的唯一保证。
   */
  close(instanceId: string): void {
    const subs = this.subscriptions.get(instanceId);
    if (subs !== undefined) {
      for (const dispose of subs.values()) {
        // 退订失败**不能挡住宿主**（一张卡的问题不该拖垮整个会话）
        try {
          dispose();
        } catch {
          /* 忽略 */
        }
      }
      this.subscriptions.delete(instanceId);
    }
    this.sessions.delete(instanceId);
  }

  /** 这个实例现在有几个订阅（诊断用） */
  subscriptionCount(instanceId: string): number {
    return this.subscriptions.get(instanceId)?.size ?? 0;
  }

  /**
   * 处理卡片的一个请求。
   *
   * ── 鉴权在这一层 ──
   *
   * | 权限 | 判什么 |
   * |---|---|
   * | `write` | 动作 id 必须在 `permissions.write` 里 → 否则 `denied` |
   * | `read` | **不在这里判**——交给读侧（`TagsService`）过滤，**「没权限」与「没有这个 tag」长得一样**（不泄露存在性） |
   * | `none` | 放行 |
   */
  async handle(req: CardRequest): Promise<CardResponse> {
    const session = this.sessions.get(req.instanceId);
    if (session === undefined) {
      return { id: req.id, ok: false, reason: 'unknown_instance' };
    }
    const api = apiByName().get(req.method);
    if (api === undefined) {
      return { id: req.id, ok: false, reason: 'unknown_method' };
    }

    const args = (req.args ?? {}) as Record<string, unknown>;
    if (api.permission === 'write') {
      const argName = api.scopeArg;
      const value = argName === undefined ? undefined : args[argName];
      if (typeof value !== 'string' || !session.perms.write.includes(value)) {
        return { id: req.id, ok: false, reason: 'denied' };
      }
    }

    const ctx: CardApiContext = {
      cardId: session.cardId,
      instanceId: session.instanceId,
      connectionId: session.connectionId,
      connection: this.deps.connectionInfo?.(session.connectionId) ?? null,
      services: session.services,
    };
    try {
      const value = await api.make(session.services)(ctx, args);
      // **方法级的失败要提到信封上**：
      // 契约 §7.7 说「失败时返回 `{ ok: false, reason }`」——
      // 卡片看到的就是这一层，不能让它自己去翻 `value`。
      if (isMethodFailure(value)) {
        return { id: req.id, ok: false, reason: value.reason };
      }
      return { id: req.id, ok: true, value };
    } catch (err) {
      return {
        id: req.id,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * 方法自己返回的失败（`{ ok:false, reason }`）。
 *
 * 契约 §7.7：「所有方法都不抛异常：失败时返回 `{ ok: false, reason }`」——
 * 所以「方法失败了」这件事必须出现在**信封**上（`CardResponse.ok/reason`），
 * 否则卡片只看到 `ok:true` + 一个藏在 `value` 里的失败。
 */
function isMethodFailure(value: unknown): value is { ok: false; reason: string } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; reason?: unknown };
  return v.ok === false && typeof v.reason === 'string';
}

/** 还没接上写侧时的占位（**调用一律被拒**，不是「假装成功」） */
function emptyActions(): CardServices['actions'] {
  return {
    invoke: (id: string) => ({ ok: false, reason: 'unknown_action', actionId: id }),
  };
}

/** 还没接上存储时的占位（Task 10 会换成真的） */
function emptyStorage(): CardServices['storage'] {
  return {
    get: () => undefined,
    set: () => ({ ok: false, reason: 'not_available' }),
    remove: () => ({ ok: false, reason: 'not_available' }),
    keys: () => [],
    clear: () => ({ ok: false, reason: 'not_available' }),
  };
}

/** 读权限覆盖（会话对外用） */
export { permissionCovers };
