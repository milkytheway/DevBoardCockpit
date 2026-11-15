import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsentQueue } from '../../../src/main/cards/consent';
import { installCard, uninstallCard } from '../../../src/main/mcp/card-tools';
import type { CardRegistry } from '../../../src/main/cards/registry';
import type { GrantStore } from '../../../src/main/cards/grants';

/**
 * **装卡与卸卡**（契约 `spec/04` §2.3 ✓ · ADR-D40 ✓）。
 *
 * ── 为什么同意要绑 manifest 哈希 ──
 *
 * `validate_card(path)` 与 `install_card(path)` 之间，**文件可能被换掉** ✓
 * —— 包括**被另一个进程换掉** ✓。
 * → 若授权只绑「卡片 id」✓，**用户批准的是 A 的 manifest，装上去的却是 B** ✗。
 * → 绑哈希把「人批准的那份东西」与「实际装上的那份东西」**钉在一起** ✓。
 */
let dir: string;
let cardsDir: string;
let srcDir: string;

function manifestJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      apiVersion: 'devboard/v1',
      kind: 'Card',
      id: 'demo',
      name: '演示卡',
      version: '1.0.0',
      entry: 'index.html',
      permissions: { read: ['cpu.usage'], write: [] },
      ...over,
    },
    null,
    2,
  );
}

function writeCard(dirPath: string, manifest: Record<string, unknown> = {}): void {
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, 'manifest.json'), manifestJson(manifest), 'utf8');
  writeFileSync(join(dirPath, 'index.html'), '<html></html>', 'utf8');
}

/** 假注册表（**只给这三个方法** ✓ —— 装卡要用的就这几个 ✓） */
function fakeRegistry(dirs: string[]): CardRegistry {
  const known = new Map<string, string>();
  // **传进来的是路径** ✓ —— 键取目录名 ✓（宿主就是按目录名索引的 ✓）
  for (const d of dirs) known.set(d.split(/[\\/]/).pop() as string, d);
  return {
    cards: () =>
      [...known.entries()].map(([cardId, dir]) => ({
        cardId,
        dir,
        manifest: {
          apiVersion: 'devboard/v1',
          kind: 'Card' as const,
          id: cardId,
          name: cardId,
          version: '1.0.0',
          entry: 'index.html',
          permissions: { read: [], write: [] },
        },
        issues: [],
        rootKind: 'user' as const,
        revision: 'r1',
      })),
    dirOf: (cardId: string) => known.get(cardId) ?? null,
    refresh: () => [],
  } as unknown as CardRegistry;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-install-'));
  cardsDir = join(dir, 'cards');
  srcDir = join(dir, 'src');
  mkdirSync(cardsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP · install_card', () => {
  it('**复制到用户卡片根** ✓（**不是内置目录** ✓ —— 内置是只读的 ✓）', () => {
    writeCard(srcDir);
    const result = installCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]), grants: fakeGrants() },
      srcDir,
    );
    expect(result.installed).toBe(true);
    expect(existsSync(join(cardsDir, 'demo', 'manifest.json'))).toBe(true);
  });

  it('**目录里没有 manifest → `invalid`** ✓（**不装** ✓）', () => {
    mkdirSync(srcDir, { recursive: true });
    const result = installCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]), grants: fakeGrants() },
      srcDir,
    );
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('invalid');
  });

  it('**要新授权 → `needs_consent` + consent_id + 待批清单** ✓（**不装** ✓）', () => {
    writeCard(srcDir, { permissions: { read: ['cpu.usage'], write: ['system.reboot'] } });
    const result = installCard(
      {
        cardsRoot: cardsDir,
        registry: fakeRegistry([]),
        grants: fakeGrants(),
        pending: new ConsentQueue(),
        packActions: () => [{ id: 'system.reboot', danger: 'destructive' as const, label: '重启板子' }],
      },
      srcDir,
    );
    expect(result.installed).toBe(false);
    expect(result.needs_consent).toBe(true);
    expect(result.consent_id).toBeTruthy();
    expect(result.pending?.length).toBe(1);
    expect(result.pending?.[0]?.action).toBe('system.reboot');
    expect(result.pending?.[0]?.danger).toBe('destructive');
    // **没装** ✓
    expect(existsSync(join(cardsDir, 'demo'))).toBe(false);
  });

  it('**人批了 → 同一个 consent_id 能装上** ✓（**一次性** ✓ —— 用过就作废 ✓）', () => {
    writeCard(srcDir, { permissions: { read: ['cpu.usage'], write: ['system.reboot'] } });
    const pending = new ConsentQueue();
    const deps = {
      cardsRoot: cardsDir,
      registry: fakeRegistry([]),
      grants: fakeGrants(),
      pending,
      packActions: () => [{ id: 'system.reboot', danger: 'destructive' as const, label: '重启板子' }],
    };
    const first = installCard(deps, srcDir);
    expect(first.needs_consent).toBe(true);
    // **人点头** ✓
    expect(pending.approve(first.consent_id as string)).toBe(true);
    const second = installCard(deps, srcDir);
    expect(second.installed).toBe(true);
    // **凭据一次性** ✓ —— 再用同一个就不算了 ✓
    const third = installCard(deps, srcDir);
    expect(third.needs_consent).toBe(true);
  });

  it('**文件在批与装之间变了 → 同意作废** ✓（**这是绑哈希的全部理由** ✓）', () => {
    writeCard(srcDir, { permissions: { read: ['cpu.usage'], write: ['system.reboot'] } });
    const pending = new ConsentQueue();
    const deps = {
      cardsRoot: cardsDir,
      registry: fakeRegistry([]),
      grants: fakeGrants(),
      pending,
      packActions: () => [{ id: 'system.reboot', danger: 'destructive' as const, label: '重启板子' }],
    };
    const first = installCard(deps, srcDir);
    pending.approve(first.consent_id as string);
    // **另一个进程把 manifest 换了** ✓
    writeCard(srcDir, { permissions: { read: ['cpu.usage'], write: ['system.reboot', 'backlight.set'] } });
    const second = installCard(deps, srcDir);
    // **旧的批准不算数** ✓ → **重新征求** ✓
    expect(second.needs_consent).toBe(true);
    expect(second.installed).toBe(false);
  });
});

describe('MCP · uninstall_card', () => {
  it('**删掉用户卡片目录** ✓', () => {
    writeCard(srcDir);
    const target = join(cardsDir, 'demo');
    writeCard(target);
    const result = uninstallCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([target]), grants: fakeGrants() },
      'demo',
    );
    expect(result.ok).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('**授权账一并清掉** ✓（**否则装回来就带着旧的授权** ✗）', () => {
    const grants = fakeGrants();
    const target = join(cardsDir, 'demo');
    writeCard(target);
    uninstallCard({ cardsRoot: cardsDir, registry: fakeRegistry([target]), grants }, 'demo');
    expect(grants.revoked).toContain('demo');
  });

  it('**卡不存在 → `not_found`** ✓', () => {
    const result = uninstallCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]), grants: fakeGrants() },
      'nope',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('**内置卡删不掉** ✓（**`denied`** ✓ —— 它在应用目录里 ✓）', () => {
    const result = uninstallCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]), grants: fakeGrants(), builtinIds: ['cpu-usage'] },
      'cpu-usage',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('denied');
  });
});

/** 假授权账（**记下谁被撤了** ✓ —— 判据要看这个 ✓） */
function fakeGrants(): GrantStore & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    forCard: () => [],
    actionIds: () => [],
    workflowIds: () => [],
    grant: () => undefined,
    revoke: (cardId: string) => {
      revoked.push(cardId);
    },
    revokeAll: (cardId: string) => {
      revoked.push(cardId);
    },
    revokeWorkflow: () => undefined,
    grantWorkflow: () => undefined,
  } as unknown as GrantStore & { revoked: string[] };
}
