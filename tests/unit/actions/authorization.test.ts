import { describe, it, expect } from 'vitest';
import { authorize, type GrantedActions } from '../../../src/main/actions/authorization';
import type { ActionDef } from '../../../src/main/tags/schema';

/**
 * 授权 —— 契约 `docs/spec/02-board-pack.md` §5.5 + `spec/04` §2.4.1。
 *
 * ── **只有两条判据**（**2026-11-16 砍完** ✓ · ADR-D48 ✓）──
 *
 * | 情形 | 行为 |
 * |---|---|
 * | 动作**在授权集里** + 参数**落在 `guard` 域内** | **直接执行**（仍记审计） |
 * | 动作**没被授权** | **拒绝** |
 * | 参数**超出 `guard` 域** | **拒绝**（**不是「问不问」** ✓） |
 * | `destructive` | **直接执行**（**危险等级只是信息** ✓ —— **闸在设置里的统一权限区** ✓） |
 *
 * → **没有第三档了** ✓（`needs_confirmation` 那一档没了 ✓ —— ADR-D48 ✓）。
 */
const ACTION: ActionDef = {
  id: 'backlight.set',
  label: '设置背光',
  danger: 'reversible',
  params: { value: { type: 'integer', min: 0, max: 255 } },
  guard: { value: { min: 16, max: 255 } },
  command: 'echo {value} > /sys/class/backlight/backlight/brightness',
  readback: { kind: 'file_equals', path: '/sys/class/backlight/backlight/brightness', expect: '{value}' },
};

const GRANTED: GrantedActions = {
  actions: { 'backlight.set': { value: { min: 16, max: 255 } } },
};

describe('授权 · 两条判据', () => {
  it('reversible + 域内 + 已授权 → ok（直接执行）', () => {
    const result = authorize(ACTION, { value: 100 }, GRANTED);
    expect(result.verdict).toBe('ok');
  });

  it('动作**没被授权** → denied', () => {
    const result = authorize(ACTION, { value: 100 }, { actions: {} });
    expect(result.verdict).toBe('denied');
  });

  it('destructive → ok（**直接执行**，不再问人 ✓ —— **危险等级只是信息** ✓）', () => {
    const destructive: ActionDef = { ...ACTION, danger: 'destructive' };
    const result = authorize(destructive, { value: 100 }, GRANTED);
    expect(result.verdict).toBe('ok');
  });

  it('reversible 但参数**超出 guard** → denied（**不是「问人」** ✓）', () => {
    const result = authorize(ACTION, { value: 5 }, GRANTED);
    expect(result.verdict).toBe('denied');
  });

  it('**超出域时说得出是哪个参数** ✓（人看得懂 ✓）', () => {
    const result = authorize(ACTION, { value: 5 }, GRANTED);
    expect(result.param).toBe('value');
    expect(result.detail ?? '').toContain('value');
  });

  it('**结果只有两档** ✓（`needs_confirmation` 那一档没了 ✓ —— ADR-D48 ✓）', () => {
    const verdicts = new Set<string>();
    verdicts.add(authorize(ACTION, { value: 100 }, GRANTED).verdict);
    verdicts.add(authorize(ACTION, { value: 5 }, GRANTED).verdict);
    verdicts.add(authorize(ACTION, { value: 100 }, { actions: {} }).verdict);
    verdicts.add(authorize({ ...ACTION, danger: 'destructive' }, { value: 100 }, GRANTED).verdict);
    expect([...verdicts].sort()).toEqual(['denied', 'ok']);
  });
});

describe('授权 · 参数域的判据', () => {
  it('没有声明 guard → 用参数自己声明的域（0..255 全域）', () => {
    const noGuard: ActionDef = { ...ACTION, guard: undefined };
    const granted: GrantedActions = { actions: { 'backlight.set': undefined } };
    const result = authorize(noGuard, { value: 5 }, granted);
    expect(result.verdict).toBe('ok');
  });

  it('越出参数自己声明的域 → denied（**guard 只是更窄的那一档** ✓）', () => {
    const noGuard: ActionDef = { ...ACTION, guard: undefined };
    const granted: GrantedActions = { actions: { 'backlight.set': undefined } };
    const result = authorize(noGuard, { value: 999 }, granted);
    expect(result.verdict).toBe('denied');
  });

  it('**授权集把域收得更窄** → 按更窄的那一档判 ✓（人授过的优先 ✓）', () => {
    const granted: GrantedActions = { actions: { 'backlight.set': { value: { min: 200, max: 255 } } } };
    expect(authorize(ACTION, { value: 100 }, granted).verdict).toBe('denied');
    expect(authorize(ACTION, { value: 220 }, granted).verdict).toBe('ok');
  });

  it('**字符串参数不走 min/max** ✓（套到 string 上只会得到「永远超出」这种假拒绝 ✓）', () => {
    const note: ActionDef = {
      ...ACTION,
      id: 'note.set',
      params: { text: { type: 'string', maxLength: 64 } },
      guard: undefined,
      command: 'echo {text} > /tmp/note',
    };
    const granted: GrantedActions = { actions: { 'note.set': undefined } };
    expect(authorize(note, { text: 'x; reboot' }, granted).verdict).toBe('ok');
  });
});
