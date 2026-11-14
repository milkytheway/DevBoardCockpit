import type { CardApiDef } from './api-registry';

/**
 * 从注册表**生成**注入给卡片的 bridge 脚本。
 *
 * ── 为什么是「生成」而不是「手写」 ──
 *
 * 宿主实现与 bridge 脚本**各写一份**的话，它们迟早对不上：
 * 卡片调 `cockpit.tags.get`，宿主那边只有 `tagsGet`，
 * 症状是「卡片说方法不存在」，而**没人查得出是哪边错了**。
 *
 * → 注册表是唯一的清单，这里把它**变成代码** ✓。
 *
 * ── 生成的脚本跑在哪 ──
 *
 * 卡片的 iframe 里（**不透明源**）：
 * - **没有 Node** → 不能有 `require` / `import`
 * - **不能联网** → 不能拉任何外部脚本
 * - 唯一的出口是 `postMessage` → 宿主
 */
export const BRIDGE_SOURCE_MARKER = '/* cockpit-bridge:v1 */';

/** 全名拆成「命名空间 / 方法名」 */
function splitName(name: string): [string, string] {
  const at = name.indexOf('.');
  if (at < 0) return [name, ''];
  return [name.slice(0, at), name.slice(at + 1)];
}

/**
 * 生成 bridge 脚本。
 *
 * @param apis 卡片 API 全集（`cardApis()`）
 * @param instanceId 这个实例的 id —— **握手时带上它**，宿主据此认人
 *        （否则卡片 A 导航到卡片 B 的 URL 就会借到 A 的权限，RF-1）
 */
export function bridgeScriptFor(apis: CardApiDef[], instanceId: string): string {
  const groups = new Map<string, string[]>();
  /** **顶层方法**（`capabilities` / `degradation` / `log` / `notify`） */
  const topLevel: string[] = [];
  for (const api of apis) {
    const [ns, fn] = splitName(api.name);
    if (fn === '') {
      // ── 顶层方法**自己就是一个函数** ──
      // 契约 §7.7 的用法是 `cockpit.log(level, message)`、`cockpit.capabilities()`——
      // **不是** `cockpit.log.log(...)`。
      // （原来把它们放进了「同名命名空间」里 → 卡片按契约写就 TypeError。）
      topLevel.push(
        `  ${ns}: (${api.params.join(', ')}) => ask(${JSON.stringify(api.name)}, { ${argsOf(api)} }),`,
      );
      continue;
    }
    const list = groups.get(ns) ?? [];
    const params = api.params;
    if (api.subscribable === true) {
      const argName = api.scopeArg ?? params[0] ?? 'name';
      const cb = params.includes('cb') ? 'cb' : 'callback';
      list.push(
        `  ${fn}: (${[...params.filter((p) => p !== cb), cb].join(', ')}) => ` +
          `subscribe(${JSON.stringify(api.name)}, ${JSON.stringify(argName)}, ${argName}, ${cb}),`,
      );
    } else {
      list.push(
        `  ${fn}: (${params.join(', ')}) => ask(${JSON.stringify(api.name)}, { ${argsOf(api)} }),`,
      );
    }
    groups.set(ns, list);
  }

  const namespaces = [...groups.entries()]
    .map(([ns, lines]) => `cockpit.${ns} = namespace({\n${lines.join('\n')}\n});`)
    .join('\n');
  const direct = topLevel.length
    ? `  Object.assign(cockpit, {\n${topLevel.join('\n')}\n  });`
    : '';

  return `${BRIDGE_SOURCE_MARKER}
(() => {
  'use strict';
  const INSTANCE_ID = ${JSON.stringify(instanceId)};
  let port = null;
  /** 端口到了就 resolve 它（没到就一直等——但**有上限**） */
  let portWaiters = [];
  const PORT_TIMEOUT_MS = 10000;
  let seq = 0;
  const pending = new Map();
  const subs = new Map();

  /**
   * 等端口。
   *
   * ── 为什么不能「端口没到就立刻回 not_connected」──
   *
   * 端口是**握手之后**才到的（页面 → iframe 的 postMessage），
   * 而卡片的脚本**先跑**、端口**后到**是常态
   *（尤其**热更新装进来的卡**：iframe 刚建好，脚本立刻跑，端口还在路上）。
   *
   * → 立刻回 not_connected = 卡片**静默地什么都不做** ✗
   *   （AI 写的卡片最常犯的错：加载时直接调 API）。
   * → 所以**等它**；等到上限还没来，才回 not_connected ✓。
   */
  function whenPort() {
    if (port !== null) return Promise.resolve(port);
    return new Promise((resolve) => {
      portWaiters.push(resolve);
      setTimeout(() => {
        const index = portWaiters.indexOf(resolve);
        if (index >= 0) portWaiters.splice(index, 1);
        resolve(null);
      }, PORT_TIMEOUT_MS);
    });
  }

  function post(method, args) {
    const id = 'r' + (++seq);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      port.postMessage({ id: id, method: method, args: args, instanceId: INSTANCE_ID });
    });
  }

  function ask(method, args) {
    // **端口已经在 → 同步发出去**（老行为不变：请求当场就在路上）
    if (port !== null) return post(method, args);
    // 端口还没到 → **等它**（热更新装进来的卡最常踩这个）
    return whenPort().then((p) => {
      if (p === null) return { ok: false, reason: 'not_connected' };
      return post(method, args);
    });
  }

  function subscribe(method, argName, value, cb) {
    if (typeof cb !== 'function') return Promise.resolve({ ok: false, reason: 'bad_callback' });
    const subId = 's' + (++seq);
    subs.set(subId, cb);
    const args = { subscriptionId: subId };
    args[argName] = value;
    return ask(method, args).then((res) => {
      // 宿主拒了（没权限 / 订阅数超限）→ **本地也别留着这个回调**：
      // 否则卡片这边的表只增不减（RF-4：一张卡不能把自己的内存吃满）
      if (res && res.ok === false) subs.delete(subId);
      return res;
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'cockpit-port') return;
    port = event.ports && event.ports[0];
    if (!port) return;
    // **端口到了 → 唤醒在等的那些调用**（它们等的就是这个）
    const waiters = portWaiters;
    portWaiters = [];
    for (const resolve of waiters) resolve(port);
    port.onmessage = (message) => {
      const payload = message.data || {};
      if (payload.type === 'push' && payload.subscriptionId) {
        const cb = subs.get(payload.subscriptionId);
        if (cb) cb(payload.value);
        return;
      }
      const resolve = pending.get(payload.id);
      if (!resolve) return;
      pending.delete(payload.id);
      // **解包**：卡片要拿到的是「值」，不是传输信封。
      //
      // 契约 §7.7 的用法是：
      //   const caps = await cockpit.capabilities();
      //   // { apiVersion: 'devboard/v1', methods: […], … }
      // 直接把信封（{ id, ok, value }）交给卡片的话，
      // caps.methods 是 undefined → 卡片以为宿主什么都不支持。
      resolve(payload.ok ? payload.value : { ok: false, reason: payload.reason || 'failed' });
    };
  });

  function namespace(target) {
    return new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        // 同上：then 不能是函数（thenable 会让 await 永远挂着）
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch' || prop === 'finally') {
          return undefined;
        }
        return () => Promise.resolve({ ok: false, reason: 'unknown_method' });
      },
    });
  }

  const cockpit = {};
${direct}
${namespaces}
  // **顶层也包一层 Proxy**：不认识的名字回 unknown_method（而不是 TypeError）
  window.cockpit = new Proxy(cockpit, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      // then 是 **thenable** 的钩子：返回函数会让 await cockpit 永远挂着
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch' || prop === 'finally') {
        return undefined;
      }
      return () => Promise.resolve({ ok: false, reason: 'unknown_method' });
    }
  });

  parent.postMessage({ type: 'cockpit-hello', instanceId: INSTANCE_ID }, '*');
})();
`;
}

/** 把位置参数拼成对象字面量：`{ key: key, value: value }` */
function argsOf(api: CardApiDef): string {
  return api.params.map((p) => `${p}: ${p}`).join(', ');
}
