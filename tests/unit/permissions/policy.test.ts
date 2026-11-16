import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PermissionStore,
  defaultAllowed,
  type PermissionOperation,
} from '../../../src/main/permissions/policy';

/**
 * **统一权限区**（设置页的那张表 ✓ · ADR-D47 ✓）。
 *
 * ── 三条判据 ──
 *
 * | # | 判据 | 为什么 |
 * |---|---|---|
 * | 1 | **卡片写板子：默认禁止** ✓ | **这堵住 C2** ✓ —— **宿主分不出「人点了按钮」与「卡片自己调的」** ✗ → **默认不给** ✓ |
 * | 2 | **卡片触发流程：默认允许** ✓ | **流程包的批准账才是那道闸** ✓ —— 「编译上板」那张卡**点一下就执行** ✓ |
 * | 3 | **agent：默认允许** ✓ | **它另有人的确认** ✓（destructive ✓ · `confirm_action` ✓）—— **别把它也关了** ✗ |
 */
function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'perm-')), 'permissions.json');
}

const OPS: readonly PermissionOperation[] = [
  { op: 'action:backlight.set', label: '设置背光亮度', kind: 'action' },
  { op: 'action:system.reboot', label: '重启板子', kind: 'action' },
  { op: 'workflow:hello-kernel.build-run', label: '编译内核模块', kind: 'workflow' },
  { op: 'host:install_card', label: '装卡', kind: 'host' },
];

describe('统一权限区', () => {
  it('**卡片写板子：默认禁止** ✓（**C2 就堵在这里** ✓）', () => {
    const store = new PermissionStore(tmpFile());
    expect(store.allows('card', 'action:backlight.set')).toBe(false);
    expect(store.allows('card', 'action:system.reboot')).toBe(false);
  });

  it('**卡片触发流程：默认允许** ✓（**流程包的批准账才是那道闸** ✓）', () => {
    const store = new PermissionStore(tmpFile());
    expect(store.allows('card', 'workflow:hello-kernel.build-run')).toBe(true);
  });

  it('**agent：默认允许** ✓（**它另有人点头** ✓）', () => {
    const store = new PermissionStore(tmpFile());
    expect(store.allows('agent', 'action:backlight.set')).toBe(true);
    expect(store.allows('agent', 'action:system.reboot')).toBe(true);
  });

  it('**宿主操作：默认允许** ✓', () => {
    const store = new PermissionStore(tmpFile());
    expect(store.allows('card', 'host:install_card')).toBe(true);
  });

  it('**人可以在设置里打开** ✓（**一次** ✓ · **不再有弹窗** ✓）', () => {
    const store = new PermissionStore(tmpFile());
    store.set('card', 'action:backlight.set', true);
    expect(store.allows('card', 'action:backlight.set')).toBe(true);
    // **别的动作不受影响** ✓（**一行一个开关** ✓）
    expect(store.allows('card', 'action:system.reboot')).toBe(false);
  });

  it('**关掉也存得住** ✓（**重启还在** ✓ —— **机器专属的授权状态** ✓）', () => {
    const file = tmpFile();
    const store = new PermissionStore(file);
    store.set('card', 'action:system.reboot', true);
    store.set('agent', 'action:system.reboot', false);
    // **重开一遍** ✓
    const again = new PermissionStore(file);
    expect(again.allows('card', 'action:system.reboot')).toBe(true);
    expect(again.allows('agent', 'action:system.reboot')).toBe(false);
  });

  it('**账坏了就用默认** ✓（**默认里卡片写板子是禁止** ✓ —— 安全的那一边 ✓）', () => {
    const file = tmpFile();
    const store = new PermissionStore(file);
    store.set('card', 'action:backlight.set', true);
    // **把账写坏** ✓
    writeFileSync(file, '{ 这不是 json', 'utf8');
    const again = new PermissionStore(file);
    expect(again.allows('card', 'action:backlight.set')).toBe(false);
    expect(again.allows('card', 'workflow:x')).toBe(true);
  });

  it('**设置页那张表：显式的与默认的合成** ✓', () => {
    const store = new PermissionStore(tmpFile());
    store.set('card', 'action:backlight.set', true);
    const rows = store.rows(OPS);
    expect(rows.map((r) => r.op)).toEqual(OPS.map((o) => o.op));
    const row = rows.find((r) => r.op === 'action:backlight.set');
    expect(row?.card).toBe(true);
    expect(row?.agent).toBe(true);
    // **没设过的还是默认** ✓
    const other = rows.find((r) => r.op === 'action:system.reboot');
    expect(other?.card).toBe(false);
  });

  it('**默认表本身是自洽的** ✓（**改一处就红** ✓）', () => {
    expect(defaultAllowed('card', 'action:x')).toBe(false);
    expect(defaultAllowed('card', 'workflow:x')).toBe(true);
    expect(defaultAllowed('card', 'host:x')).toBe(true);
    expect(defaultAllowed('agent', 'action:x')).toBe(true);
  });

  it('**账是 JSON** ✓（**人看得懂** ✓）', () => {
    const file = tmpFile();
    const store = new PermissionStore(file);
    store.set('card', 'action:x', true);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { card: Record<string, boolean> };
    expect(parsed.card['action:x']).toBe(true);
  });
});
