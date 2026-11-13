/**
 * 卡片 API 的**单一真源**。
 *
 * ── 为什么必须是「一份」 ──
 *
 * 宿主实现与注入给卡片的 bridge 脚本，**如果各写一份**，
 * 它们迟早对不上——卡片调 `cockpit.tags.get` 而宿主只有 `cockpit.tagsGet`，
 * 症状是「卡片说方法不存在」，而**没人查得出是哪边错了**。
 *
 * → 注册表是**唯一的清单**，bridge 脚本由它**生成** ✓。
 * 加一个新方法只改这里一处。
 *
 * ── `scopeArg`：权限检查看哪个参数 ──
 *
 * 读权限按 **tag** 判（`permissions.read` 的模式覆盖），
 * 写权限按 **动作 id** 判。
 * → 每个方法说清楚「我的哪个参数是要被授权的那个」，
 * 宿主就不必按方法名硬编码（那是第二套规则）。
 */

export type CardApiPermission = 'read' | 'write' | 'none';

/** 一次调用的上下文（宿主注入） */
export interface CardApiContext {
  cardId: string;
  instanceId: string;
  connectionId: string | null;
  /** 会话服务（读侧 / 存储 / 日志 / 通知）——由 main 侧注入 */
  services: CardServices;
}

/**
 * 会话要提供的能力（**端口**）。
 *
 * 实现由 Task 9 落；这里只定形状 —— 于是
 * 「注册表 → handler → bridge 脚本」三层只依赖这一个接口，
 * 不会互相咬住。
 */
export interface CardServices {
  tags: {
    get(name: string): unknown;
    list(): unknown[];
    subscribe(name: string, subscriptionId: string): void;
    subscribePattern(pattern: string, subscriptionId: string): void;
    degradation(): unknown[];
  };
  storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): { ok: boolean; reason?: string };
    remove(key: string): { ok: boolean; reason?: string };
    keys(): string[];
    clear(): { ok: boolean; reason?: string };
  };
  log(level: 'error' | 'warn' | 'info', message: string): void;
  notify(title: string, body: string): void;
}

export type CardApiHandler = (ctx: CardApiContext, args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface CardApiDef {
  /** 全名，如 `tags.get`。bridge 按点号拆成命名空间 */
  name: string;
  permission: CardApiPermission;
  /** 权限检查看 `args` 里的哪个参数（tag 名 / 动作 id）。`none` 的方法没有 */
  scopeArg?: string;
  /** 位置参数的顺序（bridge 按它把实参拼成对象） */
  params: string[];
  /** 这张卡能不能订阅它（订阅是**长连接**，要走权限） */
  subscribable?: boolean;
  /** 造出这个方法的 handler。**注入会话**，所以实现不必认识 main 的其他模块 */
  make: (services: CardServices) => CardApiHandler;
}

/** M5 的占位实现 —— Task 9 会把它们换成真的 */
function pending(services: CardServices): CardApiHandler {
  void services;
  return () => ({ ok: false, reason: 'not_implemented' });
}

/**
 * M5 的卡片 API 全集。
 *
 * **没有 `actions.invoke`** —— 写侧属 M6（契约 §7.7 的写侧行）。
 * 卡片调它会得到 `unknown_method`（bridge 只暴露这里有的方法）。
 */
export function cardApis(): CardApiDef[] {
  return [
    {
      name: 'capabilities',
      permission: 'none',
      params: [],
      make: pending,
    },
    {
      name: 'tags.get',
      permission: 'read',
      scopeArg: 'name',
      params: ['name'],
      make: pending,
    },
    {
      name: 'tags.subscribe',
      permission: 'read',
      scopeArg: 'name',
      params: ['name'],
      subscribable: true,
      make: pending,
    },
    {
      name: 'tags.subscribePattern',
      permission: 'read',
      scopeArg: 'pattern',
      params: ['pattern'],
      subscribable: true,
      make: pending,
    },
    {
      name: 'tags.list',
      permission: 'read',
      params: [],
      make: pending,
    },
    {
      name: 'degradation',
      permission: 'none',
      params: [],
      make: pending,
    },
    {
      name: 'storage.get',
      permission: 'none',
      params: ['key'],
      make: pending,
    },
    {
      name: 'storage.set',
      permission: 'none',
      params: ['key', 'value'],
      make: pending,
    },
    {
      name: 'storage.remove',
      permission: 'none',
      params: ['key'],
      make: pending,
    },
    {
      name: 'storage.keys',
      permission: 'none',
      params: [],
      make: pending,
    },
    {
      name: 'storage.clear',
      permission: 'none',
      params: [],
      make: pending,
    },
    {
      name: 'log',
      permission: 'none',
      params: ['level', 'message'],
      make: pending,
    },
    {
      name: 'notify',
      permission: 'none',
      params: ['title', 'body'],
      make: pending,
    },
  ];
}

/** 按全名查（宿主分发时用） */
export function apiByName(): Map<string, CardApiDef> {
  return new Map(cardApis().map((api) => [api.name, api]));
}
