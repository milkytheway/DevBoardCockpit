import { describe, it, expect } from 'vitest';
import type { CardInstanceInfo } from '../../src/shared/ipc-contract';
import type { RuntimeStatus } from '../../src/shared/runtime-status';
import { secondaryGroupsFor, type SecondaryContext } from '../../src/renderer/shell/nav';
import { slotKey } from '../../src/renderer/shell/layout-utils';

/**
 * 二级侧边栏的**数据**（`nav.ts`）。
 *
 * ── 为什么它是纯数据，值得单测 ──
 *
 * 「哪些行、在什么状态、点了会发生什么」全是数据 → 一眼看得出对不对，
 * 不用起应用。而这里恰恰出过一条**静默失效**：
 *
 * 「已在主区」曾经按 **cardId** 判，而布局的键是 **(cardId, connectionId)**——
 * 同一张卡在两条连接上是两个实例、各占一个格子。
 * → 换了连接之后，旧连接的单位还留在文件里，
 * 目录说「已在主区」而主区里没有它；
 * 再点只会去移除（按当前连接键过滤 → 什么也没移除）→
 * **这张卡在新连接上再也摆不进去**。
 */

function card(cardId: string, connectionId: string | null): CardInstanceInfo {
  return {
    instanceId: `${cardId}@${connectionId ?? 'none'}`,
    cardId,
    url: `cockpit://card/${cardId}@${connectionId ?? 'none'}/index.html`,
    connectionId,
    degraded: false,
  };
}

const RUNTIME: RuntimeStatus = { state: 'idle', profileId: null, detail: null };

function context(overrides: Partial<SecondaryContext> = {}): SecondaryContext {
  return {
    runtime: RUNTIME,
    connections: [],
    cards: [],
    placedSlotKeys: [],
    sessions: [],
    activeSessionId: null,
    activity: [],
    activityFilter: 'all',
    onActivityFilter: () => undefined,
    onPlaceCard: () => undefined,
    onRemoveCard: () => undefined,
    onOpenSession: () => undefined,
    onSelectSession: () => undefined,
    onCloseSession: () => undefined,
    ...overrides,
  };
}

function cardItems(ctx: SecondaryContext) {
  const group = secondaryGroupsFor('workbench', ctx).find((g) => g.id === 'cards');
  expect(group).toBeDefined();
  return group!.items;
}

describe('外壳 · 卡片目录（按实例键判「已在主区」）', () => {
  it('摆进主区的那张卡：提示是「已在主区」', () => {
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-a')],
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint).toContain('已在主区');
    expect(items[0]?.tone).toBe('active');
  });

  it('**同一张卡在另一条连接上**：不算「已在主区」（它在新连接上还没摆）', () => {
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-b')],
        // 旧连接的单位还留在布局文件里
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint).toContain('点击摆进主区');
    expect(items[0]?.tone).toBe('default');
  });

  it('摆好的卡再点一次是「撤下」——提示里写出来（不写就是一次静默的删除）', () => {
    const items = cardItems(
      context({
        cards: [card('cpu-curve', 'conn-a')],
        placedSlotKeys: [slotKey('cpu-curve', 'conn-a')],
      }),
    );
    expect(items[0]?.hint).toContain('撤下');
  });

  it('卡片行带稳定的 e2e 钩子（不认 class 名）', () => {
    const items = cardItems(context({ cards: [card('cpu-curve', 'conn-a')] }));
    expect(items[0]?.cardId).toBe('cpu-curve');
  });
});

describe('外壳 · 终端页的会话', () => {
  it('会话行有关闭按钮（串口与 SSH 的连接是独占的，没地方关就一直占着）', () => {
    const ctx = context({
      sessions: [{ sessionId: 's-1', profileId: 'board-serial', label: '板子 · 串口' }],
      activeSessionId: 's-1',
    });
    const group = secondaryGroupsFor('terminal', ctx).find((g) => g.id === 'sessions');
    expect(group).toBeDefined();
    const item = group!.items[0]!;
    expect(item.sessionId).toBe('s-1');
    expect(item.onClose).toBeTypeOf('function');
    expect(item.onSelect).toBeTypeOf('function');
  });

  it('文件页的会话行也有关闭按钮', () => {
    const ctx = context({
      sessions: [{ sessionId: 's-2', profileId: 'board-adb', label: '板子 · ADB' }],
    });
    const group = secondaryGroupsFor('files', ctx).find((g) => g.id === 'sessions');
    expect(group).toBeDefined();
    expect(group!.items[0]?.onClose).toBeTypeOf('function');
  });
});
