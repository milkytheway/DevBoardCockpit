import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrantStore } from '../../../src/main/cards/grants';
import { effectiveWrite } from '../../../src/main/cards/permissions';

/**
 * 「已授权的动作」这份账 —— 契约 `docs/spec/03-card-manifest.md` §3.3 / §2.4。
 *
 * **有效写权限 = manifest 声明的 ∩ 人授过的**。
 * 只看一条就会漏：
 * - 只看 manifest → **用户没点头的动作也能写**（AI 写的卡就能重启板子）；
 * - 只看授权 → manifest 没声明的动作也能写（宿主就没这个动作）。
 */
const dirs: string[] = [];

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'));
  dirs.push(dir);
  return join(dir, 'grants.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('授权账 · 有效写权限 = 声明 ∩ 人授', () => {
  it('只声明没授权 → 没有有效写权限', () => {
    const grants = new GrantStore(storePath());
    const declared = { read: [], write: ['system.reboot'] };
    expect(effectiveWrite(declared, grants.actionIds('card-a'))).toEqual([]);
  });

  it('授权了但 manifest 没声明 → 也没有（宿主就没这个动作）', () => {
    const grants = new GrantStore(storePath());
    grants.grant('card-a', 'system.reboot');
    const declared = { read: [], write: [] };
    expect(effectiveWrite(declared, grants.actionIds('card-a'))).toEqual([]);
  });

  it('两边都有 → 才有', () => {
    const grants = new GrantStore(storePath());
    grants.grant('card-a', 'system.reboot');
    const declared = { read: [], write: ['system.reboot'] };
    expect(effectiveWrite(declared, grants.actionIds('card-a'))).toEqual(['system.reboot']);
  });

  it('**每张卡各算各的**（A 卡的授权不给 B 卡）', () => {
    const grants = new GrantStore(storePath());
    grants.grant('card-a', 'system.reboot');
    expect(grants.actionIds('card-b')).toEqual([]);
  });
});

describe('授权账 · 存盘与收回', () => {
  it('批准后重启还在（存盘）', () => {
    const path = storePath();
    const grants = new GrantStore(path);
    grants.grant('card-a', 'backlight.set', { value: { min: 16, max: 255 } });
    const reopened = new GrantStore(path);
    expect(reopened.actionIds('card-a')).toEqual(['backlight.set']);
    expect(reopened.forCard('card-a')[0]?.domains).toEqual({ value: { min: 16, max: 255 } });
  });

  it('收回之后就没有了', () => {
    const path = storePath();
    const grants = new GrantStore(path);
    grants.grant('card-a', 'backlight.set');
    grants.revoke('card-a', 'backlight.set');
    expect(new GrantStore(path).actionIds('card-a')).toEqual([]);
  });

  it('**默认是「没有授权」**（读不出文件也当没有）', () => {
    const grants = new GrantStore(join(storePath(), 'nope.json'));
    expect(grants.actionIds('card-a')).toEqual([]);
  });

  it('同一个动作再批准一次只是刷新（幂等，不重复记）', () => {
    const path = storePath();
    const grants = new GrantStore(path);
    grants.grant('card-a', 'backlight.set');
    grants.grant('card-a', 'backlight.set');
    expect(grants.forCard('card-a')).toHaveLength(1);
  });
});
