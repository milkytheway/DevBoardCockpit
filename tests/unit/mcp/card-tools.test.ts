import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCard, uninstallCard } from '../../../src/main/mcp/card-tools';
import type { CardRegistry } from '../../../src/main/cards/registry';

/**
 * Installing and uninstalling a card (contract `spec/04` §2.3).
 *
 * Why the consent has to be bound to the hash of the manifest:
 *
 * Between `validate_card(path)` and `install_card(path)` the file **may be
 * swapped**, including **by another process**. If the consent were bound to
 * the card id alone, the user would approve the manifest of A while B is
 * installed. Binding the hash pins **the thing the operator approved** and
 **the thing that is actually installed** together.
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
      name: 'demo card',
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

/** A fake registry (**only these three methods** — they are the ones installing a card needs) */
function fakeRegistry(dirs: string[]): CardRegistry {
  const known = new Map<string, string>();
  // **what comes in is a path** — the key is the directory name (the host indexes
// by directory name)
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
  it('**it is copied to the user card root** (**not the built-in directory** — the built-in one is read-only)', () => {
    writeCard(srcDir);
    const result = installCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]) },
      srcDir,
    );
    expect(result.installed).toBe(true);
    expect(existsSync(join(cardsDir, 'demo', 'manifest.json'))).toBe(true);
  });

  it('**the directory has no manifest → `invalid`** (**it is not installed**)', () => {
    mkdirSync(srcDir, { recursive: true });
    const result = installCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]) },
      srcDir,
    );
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('invalid');
    // **not a single file was added to the directory** (**it is not an "empty card
// was installed"**)
    expect(readdirSync(cardsDir)).toEqual([]);
  });

  it('**the board pack does not offer the action to be written → it is not installed** (**the board pack decides**)', () => {
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
    // **it was not installed**
    expect(existsSync(join(cardsDir, 'demo'))).toBe(false);
  });

  it('**all the declared actions are there → it is installed directly** (**installing a card no longer asks for consent**)', () => {
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

  // ── **The id is a path segment** ✓ ──
  //
  // → The host deletes a whole directory tree here ✓ (rmSync recursive ✓)
  //   and the id comes out of a file the agent wrote ✓ → an id that may
  //   carry ".." ✓ is **a deletion outside the card root** ✓.
  it('**an id that climbs out of the card root is refused** (**nothing outside is deleted** ✓)', () => {
    // → The thing that must survive ✓ (the parent of the card root ✓ —
    //   that is the user data directory ✓).
    const precious = join(dir, 'precious');
    mkdirSync(precious, { recursive: true });
    writeFileSync(join(precious, 'keep.txt'), 'keep', 'utf8');

    for (const id of ['..', '../..', '../../..', 'a/../../b']) {
      writeCard(srcDir, { id });
      const result = installCard(
        { cardsRoot: cardsDir, registry: fakeRegistry([]) },
        srcDir,
      );
      expect(result.installed, `the id "${id}" must be refused`).toBe(false);
      expect(result.reason).toBe('invalid');
    }
    // → **Nothing outside the card root was touched** ✓
    expect(existsSync(join(precious, 'keep.txt'))).toBe(true);
    expect(readdirSync(cardsDir)).toEqual([]);
  });

  it('**an id that is not a name is refused** (the parser refuses it ✓ — the shape is closed ✓)', () => {
    for (const id of ['Demo', 'demo card', 'demo.card', 'demo_card', '']) {
      writeCard(srcDir, { id });
      const result = installCard(
        { cardsRoot: cardsDir, registry: fakeRegistry([]) },
        srcDir,
      );
      expect(result.installed, `the id "${id}" must be refused`).toBe(false);
    }
    expect(readdirSync(cardsDir)).toEqual([]);
  });

  it('**a source that is far too big is refused** (**the copy is a denial of service otherwise** ✓)', () => {
    writeCard(srcDir);
    // → A file that is bigger than the limit ✓ → the install is refused ✓
    //   **before** anything is copied ✓.
    writeFileSync(join(srcDir, 'huge.bin'), Buffer.alloc(17 * 1024 * 1024), 'utf8');
    const result = installCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]) },
      srcDir,
    );
    expect(result.installed).toBe(false);
    expect(result.detail).toContain('too big');
    expect(readdirSync(cardsDir)).toEqual([]);
  });

  it('**offline → the check of the actions is skipped and the card is degraded** ✓ (**the two entry points say the same thing** ✓)', () => {
    writeCard(srcDir, { permissions: { read: ['cpu.usage'], write: ['system.reboot'] } });
    const result = installCard(
      {
        cardsRoot: cardsDir,
        registry: fakeRegistry([]),
        // → **No board pack** ✓ → nothing could be verified ✓.
        packActions: () => [],
        hasBoardPack: () => false,
      },
      srcDir,
    );
    expect(result.installed).toBe(true);
    expect(result.degraded).toBe(true);
    expect(existsSync(join(cardsDir, 'demo', 'manifest.json'))).toBe(true);
  });

  it('**online → a missing action is still a refusal** ✓ (the board pack decides ✓)', () => {
    writeCard(srcDir, { permissions: { read: ['cpu.usage'], write: ['system.reboot'] } });
    const result = installCard(
      {
        cardsRoot: cardsDir,
        registry: fakeRegistry([]),
        packActions: () => [],
        hasBoardPack: () => true,
      },
      srcDir,
    );
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('invalid');
  });
});

describe('MCP · uninstall_card', () => {
  it('**the user card directory is removed**', () => {
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

  it('**the card does not exist → `not_found`**', () => {
    const result = uninstallCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]) },
      'nope',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('**a built-in card cannot be deleted** (**`denied`** — it lives in the application directory)', () => {
    const result = uninstallCard(
      { cardsRoot: cardsDir, registry: fakeRegistry([]), builtinIds: ['cpu-usage'] },
      'cpu-usage',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('denied');
  });
});
