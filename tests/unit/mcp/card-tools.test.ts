import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCard, uninstallCard } from '../../../src/main/mcp/card-tools';
import type { CardRegistry } from '../../../src/main/cards/registry';

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
      { cardsRoot: cardsDir, registry: fakeRegistry([]) },
      srcDir,
    );
    expect(result.installed).toBe(true);
    expect(existsSync(join(cardsDir, 'demo', 'manifest.json'))).toBe(true);
  });

  it('**目录里没有 manifest → `invalid`** ✓（**不装** ✓）', () => {
    mkdirSync(srcDir, { recursive: true });
    const result = installCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]) },
      srcDir,
    );
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('invalid');
    // **目录里一个文件都没多** ✓（**不是「装了个空卡」** ✓）
    expect(readdirSync(cardsDir)).toEqual([]);
  });

  it('**要写的动作板型包里没有 → 不装** ✓（**板型包说了算** ✓ —— ADR-D46 ✓）', () => {
    writeCard(srcDir, { permissions: { read: ['cpu.usage'], write: ['system.reboot'] } });
    const result = installCard(
      {
        cardsRoot: cardsDir,
        registry: fakeRegistry([]),
        packActions: () => [{ id: 'backlight.set', danger: 'reversible' as const }],
      },
      srcDir,
    );
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(result.detail).toContain('system.reboot');
    // **没装** ✓
    expect(existsSync(join(cardsDir, 'demo'))).toBe(false);
  });

  it('**声明的动作都在 → 直接装** ✓（**装卡不再要「同意」** ✓ —— ADR-D46 ✓）', () => {
    writeCard(srcDir, { permissions: { read: ['cpu.usage'], write: ['system.reboot'] } });
    const result = installCard(
      {
        cardsRoot: cardsDir,
        registry: fakeRegistry([]),
        packActions: () => [{ id: 'system.reboot', danger: 'destructive' as const }],
      },
      srcDir,
    );
    expect(result.installed).toBe(true);
    expect(existsSync(join(cardsDir, 'demo', 'manifest.json'))).toBe(true);
  });
});

describe('MCP · uninstall_card', () => {
  it('**删掉用户卡片目录** ✓', () => {
    writeCard(srcDir);
    const target = join(cardsDir, 'demo');
    writeCard(target);
    const result = uninstallCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([target]) },
      'demo',
    );
    expect(result.ok).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('**卡不存在 → `not_found`** ✓', () => {
    const result = uninstallCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]) },
      'nope',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('**内置卡删不掉** ✓（**`denied`** ✓ —— 它在应用目录里 ✓）', () => {
    const result = uninstallCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]), builtinIds: ['cpu-usage'] },
      'cpu-usage',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('denied');
  });
});
