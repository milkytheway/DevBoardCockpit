import { describe, it, expect } from 'vitest';
import {
  permissionCovers,
  requiresSatisfied,
  effectiveWrite,
  type CardPermissions,
} from '../../../src/main/cards/permissions';

/**
 * 卡片的权限集。
 *
 * ── 契约 §2.2 的一句话 ──
 *
 * > `requires` 里的每一项，必须被 `permissions` 里的**某一项**覆盖。
 *
 * **注意是「覆盖」不是「相等」**——这让卡片既能声明精确需求，
 * 又能申请一个更宽的读权限（反过来不成立）。
 */
describe('卡片的读权限覆盖', () => {
  it('通配模式能覆盖具体的 tag（契约 §2.2 的例子）', () => {
    expect(permissionCovers({ read: ['cpu.core.*.usage'], write: [] }, 'cpu.core.3.usage')).toBe(
      true,
    );
  });

  it('反过来不成立：具体的权限覆盖不了通配', () => {
    expect(permissionCovers({ read: ['cpu.core.3.usage'], write: [] }, 'cpu.core.*.usage')).toBe(
      false,
    );
  });

  it('不相关的 tag 覆盖不了', () => {
    expect(permissionCovers({ read: ['cpu.usage'], write: [] }, 'mem.usage')).toBe(false);
  });

  it('段数不同就是覆盖不了（cpu.core.*.usage 盖不住 cpu.usage）', () => {
    expect(permissionCovers({ read: ['cpu.core.*.usage'], write: [] }, 'cpu.usage')).toBe(false);
  });
});

describe('requires 与 permissions 的关系', () => {
  it('每一项都被覆盖 → 满足', () => {
    expect(
      requiresSatisfied(['cpu.core.3.usage'], { read: ['cpu.core.*.usage'], write: [] }),
    ).toBe(true);
  });

  it('有一项没被覆盖 → 不满足', () => {
    expect(requiresSatisfied(['mem.usage'], { read: ['cpu.core.*.usage'], write: [] })).toBe(false);
  });

  it('空的 requires 恒满足', () => {
    expect(requiresSatisfied([], { read: [], write: [] })).toBe(true);
  });
});

describe('有效写权限（契约 §2.4）', () => {
  it('是 permissions.write 与已授权的交集', () => {
    const perms: CardPermissions = { read: [], write: ['a.set', 'b.set'] };
    expect(effectiveWrite(perms, ['a.set'])).toEqual(['a.set']);
  });

  it('没授权的写权限不生效', () => {
    expect(effectiveWrite({ read: [], write: ['a.set'] }, [])).toEqual([]);
  });
});
