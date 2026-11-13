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
  for (const api of apis) {
    const [ns, fn] = splitName(api.name);
    const list = groups.get(ns) ?? [];
    if (fn === '') {
      // 没有方法名 → 这个「方法」自己就是一个命名空间上的函数
      list.push(`  ${ns}: (${api.params.join(', ')}) => ask(${JSON.stringify(api.name)}, { ${argsOf(api)} }),`);
      groups.set(ns, list);
      continue;
    }
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

  return `${BRIDGE_SOURCE_MARKER}
(() => {
  'use strict';
  const INSTANCE_ID = ${JSON.stringify(instanceId)};
  let port = null;
  let seq = 0;
  const pending = new Map();
  const subs = new Map();

  function ask(method, args) {
    if (port === null) return Promise.resolve({ ok: false, reason: 'not_connected' });
    const id = 'r' + (++seq);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      port.postMessage({ id: id, method: method, args: args, instanceId: INSTANCE_ID });
    });
  }

  function subscribe(method, argName, value, cb) {
    if (typeof cb !== 'function') return Promise.resolve({ ok: false, reason: 'bad_callback' });
    const subId = 's' + (++seq);
    subs.set(subId, cb);
    const args = { subscriptionId: subId };
    args[argName] = value;
    return ask(method, args);
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'cockpit-port') return;
    port = event.ports && event.ports[0];
    if (!port) return;
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
      resolve(payload);
    };
  });

  function namespace(target) {
    return new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop];
        return () => Promise.resolve({ ok: false, reason: 'unknown_method' });
      },
    });
  }

  const cockpit = {};
${namespaces}
  window.cockpit = cockpit;

  parent.postMessage({ type: 'cockpit-hello', instanceId: INSTANCE_ID }, '*');
})();
`;
}

/** 把位置参数拼成对象字面量：`{ key: key, value: value }` */
function argsOf(api: CardApiDef): string {
  return api.params.map((p) => `${p}: ${p}`).join(', ');
}
