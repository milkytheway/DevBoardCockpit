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
  /** The port arrived → resolve it (if it never arrives we keep waiting, but there is an upper bound) */
  let portWaiters = [];
  const PORT_TIMEOUT_MS = 10000;
  let seq = 0;
  const pending = new Map();
  const subs = new Map();

  /**
   * Wait for the port.
   *
   * ── Why it must not answer not_connected as soon as the port is missing ──
   *
   * The port arrives after the handshake (page → iframe postMessage), while
   * the card's script runs first — the port arriving later is the normal case
   * (especially for a card installed by hot reload: the iframe is just built,
   * the script runs immediately, and the port is still on its way).
   *
   * → Answering not_connected right away means the card silently does nothing.
   *   (The most common mistake in an AI-written card: it calls the API while loading.)
   * → So we wait for it; only when the upper bound passes without the port do we
   *   answer not_connected.
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
    // The port is already there → send it right away (the old behaviour is unchanged: the request is on its way immediately)
    if (port !== null) return post(method, args);
    // The port has not arrived yet → wait for it (a card installed by hot reload hits this most often)
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
      // The host refused it (no permission / too many subscriptions) → do not keep the callback here either:
      // otherwise the table on the card side only ever grows (RF-4: a card must not eat all its own memory)
      if (res && res.ok === false) subs.delete(subId);
      return res;
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'cockpit-port') return;
    port = event.ports && event.ports[0];
    if (!port) return;
    // The port arrived → wake up the calls that are waiting (the port is what they were waiting for)
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
      // Unwrap: the card must get the value, not the transport envelope.
      //
      // The usage in contract §7.7 is:
      //   const caps = await cockpit.capabilities();
      //   // { apiVersion: 'devboard/v1', methods: […], … }
      // Handing the envelope ({ id, ok, value }) to the card would leave
      // caps.methods undefined, and the card would think the host supports nothing.
      resolve(payload.ok ? payload.value : { ok: false, reason: payload.reason || 'failed' });
    };
  });

  function namespace(target) {
    return new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        // Same here: then must not be a function (a thenable makes await hang forever)
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
  // The top level is wrapped in a Proxy as well: an unknown name answers unknown_method (instead of a TypeError)
  window.cockpit = new Proxy(cockpit, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      // then is the thenable hook: returning a function would make await cockpit hang forever
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
