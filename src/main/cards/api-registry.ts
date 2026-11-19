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

/**
 * 权限的**种类** ✓。
 *
 * → `'workflow'` 是**第四维** ✓（契约 §3.3 ✓）：
 * 流程**不是动作** ✓（不在板型包里 ✓），但它**一样能在用户机器上执行命令** ✗ →
 * 它**必须**有自己的授权面 ✓ → **不许混进 `permissions.write`** ✓
 * （那一维的语义是「动作 id」✓ —— 混进去就成了两套规则 ✓）。
 */
export type CardApiPermission = 'read' | 'write' | 'workflow' | 'none';

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
  /**
   * 流程侧（计划 7 · 契约 `spec/03` §7.7 的三行 ✓）。
   *
   * → **每卡一份** ✓（做成工厂 ✓ —— 与 `actions` 同形 ✓：
   *   流程的授权是每卡一份的 ✓）。
   * → **返回的是给卡片看的那一份** ✓（投影 ✓ —— `workflow-view.ts` ✓）。
   */
  workflows: {
    /** 列流程（**只列用户批过的** ✓ —— 契约 `05` §7.2 ✓） */
    list(): unknown;
    /** 起一条流程（**授权已经判过了** ✓ —— 会话层与宿主层各一道门 ✓） */
    run(id: string, inputs: Record<string, unknown>): Promise<unknown> | unknown;
    /** 看一次运行的状态（**缩减投影** ✓） */
    status(runId: string): Promise<unknown> | unknown;
  };
}

export type CardApiHandler = (ctx: CardApiContext, args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface CardApiDef {
  /** 全名，如 `tags.get`。bridge 按点号拆成命名空间 */
  name: string;
  /**
   * **一句人话**（这个方法什么时候用 ✓）。
   *
   * → **它进 SDK 活文档** ✓（`get_card_sdk_docs` ✓ —— 契约 §2.3 ✓）——
   *   **光有方法名不够** ✓：agent 看到 `degradation()` **不知道它什么时候用** ✗。
   * → **手写在这里，不在手抄的文档里** ✓ —— **它跟方法同生共死** ✓
   *   （方法删了，说明也一起没了 ✓ → 文档不会漂 ✓）。
   */
  summary: string;
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
      summary: 'Ask the host: which methods can I call, which board am I connected to, and which tags are on it. **A card asks this first when it starts**.',
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
      summary: 'Read the current value and status of a tag. **Use this to read a number for a panel**.',
      permission: 'read',
      scopeArg: 'name',
      params: ['name'],
      make: (services) => (_ctx, args) => services.tags.get(String(args['name'])),
    },
    {
      name: 'tags.subscribe',
      summary: 'Subscribe to the changes of a tag. **Use it when the card has to follow a number** (subscribe first, then update the UI in the callback).',
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
      summary: 'Subscribe to a family of tags by pattern (such as `cpu.core.*.usage`). **Use it when you want to watch a group of numbers**.',
      permission: 'read',
      scopeArg: 'pattern',
      params: ['pattern'],
      subscribable: true,
      make: (services) => (_ctx, args) =>
        services.tags.subscribePattern(String(args['pattern']), String(args['subscriptionId'])),
    },
    {
      name: 'tags.list',
      summary: 'List every tag that is readable right now (with value and status). **Ask this first when you do not know which numbers exist**.',
      permission: 'read',
      params: [],
      make: (services) => () => services.tags.list(),
    },
    {
      name: 'degradation',
      summary: 'List the tags that **cannot be read**, together with the reason. **Use it when a panel has to show "this number is unavailable"**.',
      permission: 'none',
      params: [],
      make: (services) => () => services.tags.degradation(),
    },
    {
      name: 'actions.invoke',
      summary: 'Execute an action declared by the board pack (the write side). **Use it to change the state of the board** (subject to the danger grading).',
      permission: 'write',
      // **写权限按动作 id 判**（契约 §2.3：读权限用模式，写权限不用——
      // 模式让授权范围变大，对读来说方便，对写来说**危险**）
      scopeArg: 'id',
      params: ['id', 'params'],
      // **返回的是结果对象**（契约 spec/04 §2.4：`{ok, verified, readback, reason, audit_id}`）
      // → 会话层**不把它塌成信封失败**（塌了 `confirm_id` 就没了 → 确认通道形同虚设）
      make: (services) => (_ctx, args) =>
        services.actions.invoke(String(args['id']), (args['params'] ?? {}) as Record<string, unknown>),
    },
    {
      // **列流程**（契约 §7.7：权限「无」——只列**用户批过的** ✓）
      name: 'workflows.list',
      summary: 'List the workflows the user has approved (only id / name / input declarations).',
      permission: 'read',
      params: [],
      make: (services) => () => services.workflows.list(),
    },
    {
      // **起一条流程**（契约 §7.7：写侧 ✓ —— 权限看**流程 id** ✓）
      name: 'workflows.run',
      summary: 'Run a workflow, **returning the run_id immediately**; poll `workflows.status` for progress.',
      permission: 'workflow',
      scopeArg: 'id',
      params: ['id', 'inputs'],
      make: (services) => (_ctx, args) =>
        services.workflows.run(
          String(args['id']),
          (args['inputs'] ?? {}) as Record<string, unknown>,
        ),
    },
    {
      /**
       * **看一次运行的状态**（契约 §7.7：读侧 ✓）。
       *
       * → **`scopeArg` 是空的** ✓：方法的参数是 **run id** ✓，
       *   而权限要看的是**这个 run 属于哪个流程** ✓ —— 那个映射**只有宿主知道** ✓
       *   → 所以归属校验**在实现里做** ✓（会话层这一层不判 ✓）。
       */
      name: 'workflows.status',
      summary: 'Inspect the status and stage timeline of a run.',
      permission: 'workflow',
      params: ['runId'],
      make: (services) => (_ctx, args) => services.workflows.status(String(args['runId'])),
    },
    {
      name: 'storage.get',
      summary: 'Read the persistent storage of this card (**one store per card**).',
      permission: 'none',
      params: ['key'],
      make: (services) => (_ctx, args) => services.storage.get(String(args['key'])),
    },
    {
      name: 'storage.set',
      summary: 'Write to the persistent storage of this card.',
      permission: 'none',
      params: ['key', 'value'],
      make: (services) => (_ctx, args) =>
        services.storage.set(String(args['key']), args['value']),
    },
    {
      name: 'storage.remove',
      summary: 'Delete one storage key.',
      permission: 'none',
      params: ['key'],
      make: (services) => (_ctx, args) => services.storage.remove(String(args['key'])),
    },
    {
      name: 'storage.keys',
      summary: 'List the storage keys of this card.',
      permission: 'none',
      params: [],
      make: (services) => () => services.storage.keys(),
    },
    {
      name: 'storage.clear',
      summary: 'Clear the storage of this card.',
      permission: 'none',
      params: [],
      make: (services) => () => services.storage.clear(),
    },
    {
      name: 'log',
      summary: 'Write one entry into the runtime log of this card (**the eyes of the agent for self-testing can see it**).',
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
