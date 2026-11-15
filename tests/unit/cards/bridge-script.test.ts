import { describe, it, expect } from 'vitest';
import { cardApis, apiByName } from '../../../src/main/cards/api-registry';
import { bridgeScriptFor } from '../../../src/main/cards/bridge-script';

/**
 * 卡片 API 的**单一真源**。
 *
 * ── 为什么必须是「一份」 ──
 *
 * 宿主实现与注入给卡片的 bridge 脚本，**如果各写一份**，
 * 它们迟早对不上——卡片调 `cockpit.tags.get` 而宿主只有 `cockpit.tagsGet`，
 * 症状是「卡片说方法不存在」，而**没人查得出是哪边错了**。
 *
 * → 所以：**注册表是唯一的清单**，bridge 脚本由它**生成** ✓。
 * 加一个新方法只改注册表一处。
 */
describe('卡片 API 注册表', () => {
  it('有 M5 需要的那些方法', () => {
    const names = [...apiByName().keys()].sort();
    expect(names).toContain('capabilities');
    expect(names).toContain('tags.get');
    expect(names).toContain('tags.subscribe');
    expect(names).toContain('tags.subscribePattern');
    expect(names).toContain('tags.list');
    expect(names).toContain('degradation');
    expect(names).toContain('storage.get');
    expect(names).toContain('log');
  });

  it('**`notify` 不在已实现清单里**（宿主通道还没接上；列了 = 卡片以为通知发出去了）', () => {
    const names = [...apiByName().keys()];
    expect(names).not.toContain('notify');
  });

  it('**写侧自 M6 起有了**（actions.invoke 在清单里）', () => {
    expect(apiByName().has('actions.invoke')).toBe(true);
    // 写权限按**动作 id** 判（契约 §2.3：读权限用模式，写权限不用）
    expect(apiByName().get('actions.invoke')?.permission).toBe('write');
    expect(apiByName().get('actions.invoke')?.scopeArg).toBe('id');
  });

  it('**流程侧自计划 7 起有了**（契约 §7.7 的三行 ✓）', () => {
    const byName = apiByName();
    expect(byName.has('workflows.list')).toBe(true);
    expect(byName.has('workflows.run')).toBe(true);
    expect(byName.has('workflows.status')).toBe(true);
    // **流程的写权限是它自己那一维** ✓（**不许混进 permissions.write** ✓ —— 契约 §2.3 ✓）
    expect(byName.get('workflows.run')?.permission).toBe('workflow');
    // **权限看流程 id** ✓
    expect(byName.get('workflows.run')?.scopeArg).toBe('id');
  });

  it('读方法的权限是 read，存储与日志是 none', () => {
    const byName = apiByName();
    expect(byName.get('tags.get')?.permission).toBe('read');
    expect(byName.get('tags.list')?.permission).toBe('read');
    expect(byName.get('storage.set')?.permission).toBe('none');
    expect(byName.get('log')?.permission).toBe('none');
    expect(byName.get('capabilities')?.permission).toBe('none');
  });

  it('读方法说清楚「权限看哪个参数」', () => {
    const byName = apiByName();
    expect(byName.get('tags.get')?.scopeArg).toBe('name');
    expect(byName.get('tags.subscribePattern')?.scopeArg).toBe('pattern');
  });

  it('每个方法名都合法（点分、不为空）', () => {
    for (const api of cardApis()) {
      expect(api.name).toMatch(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)*$/);
    }
  });
});

describe('bridge 脚本的生成', () => {
  const script = bridgeScriptFor(cardApis(), 'inst-42');

  it('定义 window.cockpit', () => {
    expect(script).toContain('window.cockpit');
  });

  it('**每个注册的方法都在里面**（单一真源的兑现）', () => {
    for (const api of cardApis()) {
      const [ns, fn] = api.name.split('.');
      expect(script).toContain(ns ?? '');
      expect(script).toContain(fn ?? '');
    }
  });

  it('**没有** require / import（它跑在沙箱 iframe 里，没有 Node）', () => {
    expect(script).not.toMatch(/\brequire\s*\(/);
    expect(script).not.toMatch(/\bimport\s/);
  });

  it('握手时带上 instanceId（宿主据此认人，RF-1 的防线）', () => {
    expect(script).toContain('inst-42');
    expect(script).toContain('cockpit-hello');
  });

  it('不认识的方法回 unknown_method，**不发出去**', () => {
    expect(script).toContain('unknown_method');
  });

  it('是一个自包含的 IIFE（不往全局漏东西）', () => {
    expect(script).toContain('(() => {');
    expect(script).toContain('})();');
  });
});

/**
 * bridge 脚本**真的跑起来**。
 *
 * ── 为什么不能只测「脚本文本里有这句话」 ──
 *
 * 脚本文本的断言只能证明「代码被生成出来了」，
 * 证明不了「**卡片拿到的是不是它要的东西**」。
 *
 * ── 这条曾经真的错着 ──
 *
 * 契约 `spec/03` §7.7 写的用法是：
 * ```js
 * const caps = await cockpit.capabilities();
 * // { apiVersion: 'devboard/v1', methods: […], connection: {…}, tags: […] }
 * ```
 * 而 bridge 把**整个传输信封**（`{ id, ok, value }`）交给了卡片 →
 * 卡片拿到的是 `{ id: 'r1', ok: true, value: {…} }` →
 * `caps.methods` 是 **undefined** → 卡片以为宿主不支持任何方法。
 *
 * → 所以 bridge 必须**解包**：成功给 `value`，失败给 `{ ok:false, reason }`。
 */
interface FakePort {
  postMessage: (m: unknown) => void;
  onmessage: ((m: { data: unknown }) => void) | null;
}

function runBridge(
  instanceId: string,
  opts: { deliverPort?: boolean } = {},
): {
  cockpit: Record<string, unknown>;
  port: FakePort;
  hello: unknown[];
  sent: unknown[];
  /** 端口晚点到了就调它 */
  deliverPort: () => void;
} {
  const script = bridgeScriptFor(cardApis(), instanceId);
  const listeners: ((e: unknown) => void)[] = [];
  const sent: unknown[] = [];
  const hello: unknown[] = [];
  const fakeWindow: Record<string, unknown> = {
    addEventListener: (type: string, cb: (e: unknown) => void) => {
      if (type === 'message') listeners.push(cb);
    },
  };
  const fakeParent = { postMessage: (m: unknown) => void hello.push(m) };
  // `window` 与 `parent` 作为**参数**传进去，遮住全局
  new Function('window', 'parent', script)(fakeWindow, fakeParent);
  const port: FakePort = { postMessage: (m) => sent.push(m), onmessage: null };
  // 宿主把 port 递给卡片
  const deliver = (): void => {
    listeners[0]?.({ data: { type: 'cockpit-port' }, ports: [port] });
  };
  if (opts.deliverPort !== false) deliver();
  return {
    cockpit: fakeWindow['cockpit'] as never,
    port,
    hello,
    sent,
    deliverPort: deliver,
  };
}

/** 从发出去的消息里取请求 id（bridge 的序号会先给订阅 id 让一步） */
function idOf(sent: unknown[]): string {
  const first = sent[0] as { id?: string } | undefined;
  if (first?.id === undefined) throw new Error('bridge 没有发出请求');
  return first.id;
}

describe('bridge 脚本 · 卡片真正看到的东西', () => {
  it('握手时把 instanceId 报给宿主（RF-1 的凭据）', () => {
    const { hello } = runBridge('inst-42');
    expect(hello).toEqual([{ type: 'cockpit-hello', instanceId: 'inst-42' }]);
  });

  it('**成功 → 卡片拿到的是「值」，不是传输信封**', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const pending = (cockpit['capabilities'] as () => Promise<unknown>)();
    const caps = { apiVersion: 'devboard/v1', methods: ['tags.get'], connection: null, tags: [] };
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: caps } });
    await expect(pending).resolves.toEqual(caps);
  });

  it('**失败 → 卡片拿到 { ok:false, reason }**（契约 §7.7：不抛异常）', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const tags = cockpit['tags'] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const pending = tags['get']?.('cpu.usage');
    port.onmessage?.({ data: { id: idOf(sent), ok: false, reason: 'unknown_method' } });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unknown_method' });
  });

  it('订阅被拒 → 卡片能看到 reason（**不是**静默接受）', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const tags = cockpit['tags'] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const pending = tags['subscribe']?.('cpu.usage', () => undefined);
    port.onmessage?.({ data: { id: idOf(sent), ok: false, reason: 'too_many_subscriptions' } });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'too_many_subscriptions' });
  });
});

describe('bridge 脚本 · 顶层方法就是函数', () => {
  it('**`cockpit.capabilities()` 能调**（契约 §7.7 的用法，不是 `cockpit.capabilities.capabilities()`）', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const pending = (cockpit['capabilities'] as () => Promise<unknown>)();
    const caps = { apiVersion: 'devboard/v1', methods: ['tags.get'], connection: null, tags: [] };
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: caps } });
    await expect(pending).resolves.toEqual(caps);
  });

  it('**`cockpit.log(level, message)` 能调**', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const pending = (cockpit['log'] as (...a: unknown[]) => Promise<unknown>)('error', 'hi');
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: { ok: true } } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('**`cockpit.degradation()` 能调**', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const pending = (cockpit['degradation'] as () => Promise<unknown>)();
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: [] } });
    await expect(pending).resolves.toEqual([]);
  });

  it('**不认识的名字仍然回 unknown_method**（不是 TypeError）', async () => {
    const { cockpit } = runBridge('inst-42');
    const pending = (cockpit['nope'] as () => Promise<unknown>)();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unknown_method' });
  });

  it('**命名空间里不认识的方法也是 unknown_method**（顶层与命名空间是两层 Proxy）', async () => {
    const { cockpit } = runBridge('inst-42');
    const tags = cockpit['tags'] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const pending = tags['nope']?.();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'unknown_method' });
  });

  it('**命名空间方法不受影响**（`cockpit.tags.get`）', async () => {
    const { cockpit, port, sent } = runBridge('inst-42');
    const tags = cockpit['tags'] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const pending = tags['get']?.('cpu.usage');
    port.onmessage?.({ data: { id: idOf(sent), ok: true, value: { tag: 'cpu.usage' } } });
    await expect(pending).resolves.toEqual({ tag: 'cpu.usage' });
  });
});

describe('bridge · 端口还没到的时候', () => {
  /**
   * ── 这条判据在防什么 ──
   *
   * 端口是**握手之后**才到的（页面 → iframe 的 postMessage），
   * 而卡片的脚本**先跑**、端口**后到**是常态
   *（尤其**热更新装进来的卡**：iframe 刚建好，脚本立刻跑，端口还在路上）。
   *
   * → 老行为：端口没到就立刻回 `not_connected`
   * → 卡片**静默地什么都不做** ✗（AI 写的卡片最常犯的错：加载时直接调 API）
   * → 新行为：**等它**（上限 10 秒），到了才真的发出去 ✓
   *
   * → 这条是 e2e 逮到的真 bug（`tests/e2e/action.test.ts`）。
   */
  it('调用要**等端口**，不是立刻回 not_connected', async () => {
    const bridge = runBridge('inst-late', { deliverPort: false });
    const cockpit = bridge.cockpit as {
      tags: { get(name: string): Promise<unknown> };
    };

    const pending = cockpit.tags.get('cpu.usage');
    // **还没发出去**（端口没到，发了也没人接）
    expect(bridge.sent).toHaveLength(0);

    // 端口到了 → **等着的那个调用真的发出去了**
    bridge.deliverPort();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.sent.length).toBe(1);

    // 把它答完，调用要真的 resolve
    const first = bridge.sent[0] as { id: string };
    bridge.port.onmessage?.({ data: { id: first.id, ok: true, value: 42 } });
    await expect(pending).resolves.toBe(42);
  });
});
