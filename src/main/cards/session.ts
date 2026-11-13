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
  /** 存储（Task 10 接上） */
  storage?: CardServices['storage'];
  /** 日志（Task 10 接上） */
  log?: (level: 'error' | 'warn' | 'info', message: string) => void;
  /** 通知（Task 10 接上） */
  notify?: (title: string, body: string) => void;
  /** 当前连接的身份（给 `capabilities()` 用） */
  connectionInfo?: (connectionId: string | null) => { label: string; transport: string } | null;
}

export class CardSessionManager {
  private readonly sessions = new Map<string, CardSession>();

  constructor(private readonly deps: CardSessionManagerDeps) {}

  /** 开一个会话（同一实例重复调用是同一个会话） */
  open(instanceId: string, cardId: string, connectionId: string | null): CardSession {
    const existing = this.sessions.get(instanceId);
    if (existing !== undefined) return existing;

    const perms = this.deps.permsFor(cardId);
    const now = this.deps.now ?? (() => Date.now());
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
          tags.subscribe(name, (reading) => {
            push?.(instanceId, { type: 'push', subscriptionId, value: reading });
          });
        },
        subscribePattern: (pattern, subscriptionId) => {
          tags.subscribePattern(pattern, (reading) => {
            push?.(instanceId, { type: 'push', subscriptionId, value: reading });
          });
        },
        degradation: () => tags.degradation(),
      },
      storage: this.deps.storage ?? emptyStorage(),
      log: (level, message) => {
        this.deps.log?.(level, message);
      },
      notify: (title, body) => {
        this.deps.notify?.(title, body);
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

  /** 关一个会话（卡片没了） */
  close(instanceId: string): void {
    this.sessions.delete(instanceId);
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
