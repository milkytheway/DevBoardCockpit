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
import type { ReasonCode, TagReading } from '../../shared/tag-reading';

export type CardApiPermission = 'read' | 'write' | 'none';

/** 一次调用的上下文（宿主注入） */
export interface CardApiContext {
  cardId: string;
  instanceId: string;
  connectionId: string | null;
  /** 当前连接的身份（**不给 connectionId**——契约 §7.8：卡片代码里没有这个词） */
  connection: { label: string; transport: string } | null;
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
    get(name: string): TagReading;
    list(): TagReading[];
    subscribe(name: string, subscriptionId: string): { ok: boolean; reason?: string };
    subscribePattern(pattern: string, subscriptionId: string): { ok: boolean; reason?: string };
    degradation(): { tag: string; reason: ReasonCode; detail: string }[];
  };
  storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): { ok: boolean; reason?: string };
    remove(key: string): { ok: boolean; reason?: string };
    keys(): string[];
    clear(): { ok: boolean; reason?: string };
  };
  log(level: 'error' | 'warn' | 'info', message: string): void;
  /**
   * 写侧（M6 · 契约 §7.7 的写侧行）。
   *
   * **权限按动作 id 判**（写权限不用模式，契约 §2.3）——
   * 会话层已经有一道检查（`permissions.write` 里有没有这个 id），
   * 这里的 `invoke` 再走执行器那条链（编码 → 地板 → 授权 → 确认 → 执行 → 回读 → 审计）。
   */
  actions: {
    invoke(id: string, params: Record<string, unknown>): Promise<unknown> | unknown;
  };
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

/**
 * 卡片 API 的全集（**本 build 实际有的**）。
 *
 * **写侧 `actions.invoke` 自 M6 起有**（契约 §7.7 的写侧行）。
 *
 * **仍然没有 `notify`** —— 宿主的通知通道还没接上。
 * 契约 §7.7 明写「**本宿主没有实现的方法**，调用返回
 * `{ ok: false, reason: 'unknown_method' }`」，
 * 而 `capabilities().methods` 列的是「**本 build 实际有的方法**」——
 * 所以**没实现的就不该列**（列了 = 卡片以为通知发出去了，其实没人管）。
 */
export function cardApis(): CardApiDef[] {
  return [
    {
      name: 'capabilities',
      permission: 'none',
      params: [],
      // **本 build 实际有的方法**（不是契约全集）——否则卡片会以为能调还不存在的方法
      make: (services) => (ctx) => ({
        apiVersion: 'devboard/v1',
        methods: cardApis().map((api) => api.name),
        connection: ctx.connection,
        tags: services.tags.list().map((r) => r.tag),
      }),
    },
    {
      name: 'tags.get',
      permission: 'read',
      scopeArg: 'name',
      params: ['name'],
      make: (services) => (_ctx, args) => services.tags.get(String(args['name'])),
    },
    {
      name: 'tags.subscribe',
      permission: 'read',
      scopeArg: 'name',
      params: ['name'],
      subscribable: true,
      // 订阅的**回调**留在卡片那边（函数不能过 postMessage）；
      // 这里只登记「哪个订阅 id 要收哪个 tag 的推送」
      make: (services) => (_ctx, args) =>
        services.tags.subscribe(String(args['name']), String(args['subscriptionId'])),
    },
    {
      name: 'tags.subscribePattern',
      permission: 'read',
      scopeArg: 'pattern',
      params: ['pattern'],
      subscribable: true,
      make: (services) => (_ctx, args) =>
        services.tags.subscribePattern(String(args['pattern']), String(args['subscriptionId'])),
    },
    {
      name: 'tags.list',
      permission: 'read',
      params: [],
      make: (services) => () => services.tags.list(),
    },
    {
      name: 'degradation',
      permission: 'none',
      params: [],
      make: (services) => () => services.tags.degradation(),
    },
    {
      name: 'actions.invoke',
      permission: 'write',
      // **写权限按动作 id 判**（契约 §2.3：读权限用模式，写权限不用——
      // 模式让授权范围变大，对读来说方便，对写来说**危险**）
      scopeArg: 'id',
      params: ['id', 'params'],
      make: (services) => (_ctx, args) =>
        services.actions.invoke(String(args['id']), (args['params'] ?? {}) as Record<string, unknown>),
    },
    {
      name: 'storage.get',
      permission: 'none',
      params: ['key'],
      make: (services) => (_ctx, args) => services.storage.get(String(args['key'])),
    },
    {
      name: 'storage.set',
      permission: 'none',
      params: ['key', 'value'],
      make: (services) => (_ctx, args) =>
        services.storage.set(String(args['key']), args['value']),
    },
    {
      name: 'storage.remove',
      permission: 'none',
      params: ['key'],
      make: (services) => (_ctx, args) => services.storage.remove(String(args['key'])),
    },
    {
      name: 'storage.keys',
      permission: 'none',
      params: [],
      make: (services) => () => services.storage.keys(),
    },
    {
      name: 'storage.clear',
      permission: 'none',
      params: [],
      make: (services) => () => services.storage.clear(),
    },
    {
      name: 'log',
      permission: 'none',
      params: ['level', 'message'],
      make: (services) => (_ctx, args) => {
        const level = args['level'];
        const level2 =
          level === 'error' || level === 'warn' || level === 'info' ? level : 'info';
        services.log(level2, String(args['message'] ?? ''));
        return { ok: true };
      },
    },
  ];
}

/** 按全名查（宿主分发时用） */
export function apiByName(): Map<string, CardApiDef> {
  return new Map(cardApis().map((api) => [api.name, api]));
}
