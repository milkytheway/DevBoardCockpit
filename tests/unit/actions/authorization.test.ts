import { describe, it, expect } from 'vitest';
import {
  authorize,
  ConfirmationStore,
  type GrantedActions,
} from '../../../src/main/actions/authorization';
import type { ActionDef } from '../../../src/main/tags/schema';
import { checkFloor } from '../../../src/main/actions/floor-check';

/**
 * 授权与确认 —— 契约 `docs/spec/02-board-pack.md` §5.5 + `spec/04` §2.4.1。
 *
 * ── 授权粒度 = 动作 id + 可选参数域 ──
 *
 * | 情形 | 行为 |
 * |---|---|
 * | `reversible` 且参数落在 `guard` 域内 | **直接执行**（仍记审计） |
 * | `reversible` 但参数**超出** `guard` | 走一次确认（与 destructive 同一条通道） |
 * | `destructive` | **必须有人在 GUI 里点确认** |
 * | 动作没被授权 | 拒绝 |
 *
 * **超出 guard 不是拒绝**——guard 是「装卡时批准的那一档」，
 * 超出它只是**超出了批准范围**，要人再点一次。
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

describe('授权 · 四种情形', () => {
  it('reversible + 域内 + 已授权 → ok（直接执行）', () => {
    const result = authorize(ACTION, { value: 100 }, GRANTED, checkFloor('echo 100 > /tmp/x'));
    expect(result.verdict).toBe('ok');
  });

  it('动作**没被授权** → denied', () => {
    const result = authorize(ACTION, { value: 100 }, { actions: {} }, checkFloor('echo 100 > /tmp/x'));
    expect(result.verdict).toBe('denied');
  });

  it('destructive → needs_confirmation（**必须有人在 GUI 里点**）', () => {
    const destructive: ActionDef = { ...ACTION, danger: 'destructive' };
    const result = authorize(destructive, { value: 100 }, GRANTED, checkFloor('echo 100 > /tmp/x'));
    expect(result.verdict).toBe('needs_confirmation');
  });

  it('reversible 但参数**超出 guard** → needs_confirmation（不是拒绝）', () => {
    const result = authorize(ACTION, { value: 5 }, GRANTED, checkFloor('echo 5 > /tmp/x'));
    expect(result.verdict).toBe('needs_confirmation');
  });

  it('**地板命中** → 当成 destructive（走确认，不是直接执行）', () => {
    // 命令本身是 `reversible` 的动作，但编码后的命令命中了地板
    const result = authorize(ACTION, { value: 100 }, GRANTED, checkFloor('rm -rf /'));
    expect(result.verdict).toBe('needs_confirmation');
  });

  it('地板没命中 → 不影响授权（还是 ok）', () => {
    const result = authorize(ACTION, { value: 100 }, GRANTED, checkFloor('echo 100 > /tmp/x'));
    expect(result.verdict).toBe('ok');
  });
});

describe('授权 · 参数域的判据', () => {
  it('没有声明 guard → 用参数自己声明的域（0..255 全域）', () => {
    const noGuard: ActionDef = { ...ACTION, guard: undefined };
    const granted: GrantedActions = { actions: { 'backlight.set': undefined } };
    const result = authorize(noGuard, { value: 5 }, granted, checkFloor('echo 5 > /tmp/x'));
    expect(result.verdict).toBe('ok');
  });

  it('越出参数自己声明的域 → needs_confirmation（装卡时没批准过这一档）', () => {
    const noGuard: ActionDef = { ...ACTION, guard: undefined };
    const granted: GrantedActions = { actions: { 'backlight.set': undefined } };
    const result = authorize(noGuard, { value: 999 }, granted, checkFloor('echo 999 > /tmp/x'));
    expect(result.verdict).toBe('needs_confirmation');
  });
});

describe('确认凭据 · confirm_id', () => {
  const packId = 'rk3588-atk';
  const contract = 'devboard/v1';

  it('**签发 ≠ 有效**：没被人点过，用不了（契约 spec/04 §2.4.1 ✓）', () => {
    const store = new ConfirmationStore();
    const token = store.issue('backlight.set', { value: 100 }, packId, contract, 1_000, 'cmd-A');
    // **签发只是「递了个请求」**（契约：「没有人点，confirm_id 永远无效」✓）
    expect(store.consume(token, 'backlight.set', { value: 100 }, packId, contract, 1_500, 'cmd-A')).toBe(false);
    // **人点了之后**才可用 ✓
    expect(store.approve(token, 1_200)).toBe(true);
    expect(store.consume(token, 'backlight.set', { value: 100 }, packId, contract, 1_500, 'cmd-A')).toBe(true);
  });

  it('**第二次用不行**（一次性）', () => {
    const store = new ConfirmationStore();
    const token = store.issue('backlight.set', { value: 100 }, packId, contract, 1_000, 'cmd-A');
    store.approve(token, 1_200);
    expect(store.consume(token, 'backlight.set', { value: 100 }, packId, contract, 1_500, 'cmd-A')).toBe(true);
    expect(store.consume(token, 'backlight.set', { value: 100 }, packId, contract, 1_500, 'cmd-A')).toBe(false);
  });

  it('动作不同 → 不行', () => {
    const store = new ConfirmationStore();
    const token = store.issue('backlight.set', { value: 100 }, packId, contract, 1_000, 'cmd-A');
    store.approve(token, 1_200);
    expect(store.consume(token, 'other.action', { value: 100 }, packId, contract, 1_500, 'cmd-A')).toBe(false);
  });

  it('参数不同 → 不行（凭据绑的是**这一次**的参数）', () => {
    const store = new ConfirmationStore();
    const token = store.issue('backlight.set', { value: 100 }, packId, contract, 1_000, 'cmd-A');
    store.approve(token, 1_200);
    expect(store.consume(token, 'backlight.set', { value: 200 }, packId, contract, 1_500, 'cmd-A')).toBe(false);
  });

  it('**最终命令不同 → 不行**（凭据要绑「这一步的最终命令」✓ —— 契约 spec/05 §7.5-3 ✓）', () => {
    const store = new ConfirmationStore();
    // **签发时那条命令** ✓
    const token = store.issue(
      'backlight.set',
      { value: 100 },
      packId,
      contract,
      1_000,
      'sha256-of-cmd-A',
    );
    store.approve(token, 1_200);
    // **命令变了 → 那张凭据认不出来** ✓（独立评审 40 的 I-5 ✓）
    expect(
      store.consume(token, 'backlight.set', { value: 100 }, packId, contract, 1_500, 'sha256-of-cmd-B'),
    ).toBe(false);
    // **命令没变 → 用得了** ✓
    expect(
      store.consume(token, 'backlight.set', { value: 100 }, packId, contract, 1_500, 'sha256-of-cmd-A'),
    ).toBe(true);
  });

  it('板型包或契约版本不同 → 不行', () => {
    const store = new ConfirmationStore();
    const token = store.issue('backlight.set', { value: 100 }, packId, contract, 1_000, 'cmd-A');
    store.approve(token, 1_200);
    expect(store.consume(token, 'backlight.set', { value: 100 }, 'other-pack', contract, 1_500, 'cmd-A')).toBe(false);
    expect(store.consume(token, 'backlight.set', { value: 100 }, packId, 'devboard/v2', 1_500, 'cmd-A')).toBe(false);
  });

  it('超过 5 分钟 → 不行', () => {
    const store = new ConfirmationStore();
    const token = store.issue('backlight.set', { value: 100 }, packId, contract, 1_000, 'cmd-A');
    expect(
      store.consume(
        token,
        'backlight.set',
        { value: 100 },
        packId,
        contract,
        1_000 + 5 * 60_000 + 1,
        'cmd-A',
      ),
    ).toBe(false);
  });

  it('没签发过的凭据 → 不行', () => {
    const store = new ConfirmationStore();
    expect(store.consume('nonsense', 'backlight.set', { value: 100 }, packId, contract, 1_500, 'cmd-A')).toBe(
      false,
    );
  });
});
