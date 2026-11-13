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
    expect(names).toContain('notify');
  });

  it('**M5 没有写侧**（actions.invoke 属 M6）', () => {
    expect(apiByName().has('actions.invoke')).toBe(false);
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
