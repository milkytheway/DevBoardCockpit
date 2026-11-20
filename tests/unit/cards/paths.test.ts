import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveInsideCard, mimeFor } from '../../../src/main/cards/paths';
import { join, resolve, sep } from 'node:path';

/**
 * The resolution of paths inside the card directory and the protection
 * against traversal.
 *
 * Why this is a security boundary:
 *
 * A card is **an arbitrary web page written by an AI**. It can request
 * `cockpit://card/<id>/<path>`. If the path is not held, the card can read
 * **the file system of the host**, and that is the one thing this product
 * must never allow.
 *
 * What has to be blocked: `..`, absolute paths, Windows drive letters,
 * `%2e%2e` (a URL-encoded `..`) and empty segments.
 */
describe('the resolution of paths inside the card directory', () => {
  // **It has to be resolved**: `join('/cards', …)` is a **root-relative** path on
// Windows
  // (`\cards\cpu-usage`), while the `resolve()` of the implementation adds the
// drive letter → the assertion would fail.
  // → The fixture and the implementation use the **same** base (both after
// `resolve`).
  const root = resolve(join('/cards', 'cpu-usage'));

  it('an ordinary relative path → it stays inside the directory', () => {
    expect(resolveInsideCard(root, 'index.html')).toBe(join(root, 'index.html'));
  });

  it('`..` that leaves the directory → null', () => {
    expect(resolveInsideCard(root, '../secret.txt')).toBeNull();
    expect(resolveInsideCard(root, 'a/../../b.txt')).toBeNull();
  });

  it('an absolute path → null (even when it points inside the directory)', () => {
    expect(resolveInsideCard(root, '/etc/passwd')).toBeNull();
  });

  it('a URL-encoded `..` → null (**it is decoded before the decision**)', () => {
    expect(resolveInsideCard(root, '%2e%2e/secret.txt')).toBeNull();
    expect(resolveInsideCard(root, '%2E%2E/secret.txt')).toBeNull();
  });

  it('a `..` inside the directory (it does not leave) → allowed', () => {
    expect(resolveInsideCard(root, 'sub/../index.html')).toBe(join(root, 'index.html'));
  });

  it('an empty path → null', () => {
    expect(resolveInsideCard(root, '')).toBeNull();
  });

  it('it ends with `/` (that is a directory, not a file) → null', () => {
    expect(resolveInsideCard(root, 'sub/')).toBeNull();
  });

  it('the resolved path is always under the root (**the criterion is not a string comparison**)', () => {
    const resolved = resolveInsideCard(root, 'a/b/../c.js');
    expect(resolved).not.toBeNull();
    expect(resolved?.startsWith(root + sep)).toBe(true);
  });
});

/**
 * Creates a **directory link**: on Windows a junction (an ordinary user can
 * create one, no developer mode needed), on the other platforms an ordinary
 * symbolic link to a directory.
 *
 * Why not a symbolic link to a file: on Windows that needs administrator or
 * developer mode, and without it the call fails with EPERM, while a junction
 * is a directory reparse point of NTFS that an ordinary user can create. The
 * junction exercises the same code path.
 */
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Whether this machine can create a directory link (if not, it is skipped rather than failed) */
function canLinkDir(): boolean {
  const base = mkdtempSync(join(tmpdir(), 'card-link-probe-'));
  try {
    mkdirSync(join(base, 'target'), { recursive: true });
    linkDir(join(base, 'target'), join(base, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const LINK_OK = canLinkDir();

describe('symbolic links (a soft link is the most common way around)', () => {
  function scene(): { root: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), 'card-link-'));
    const root = join(base, 'card');
    mkdirSync(root, { recursive: true });
    // **a file of the host**: outside the card directory
    writeFileSync(join(base, 'secret.txt'), 'SECRET-HOST-FILE', 'utf8');
    return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it.skipIf(!LINK_OK)('a soft link pointing **outside** the card directory → null (lexically inside the directory, outside after realpath)', () => {
    const { root, cleanup } = scene();
    try {
      linkDir(join(root, '..'), join(root, 'link'));
      expect(resolveInsideCard(root, 'link/secret.txt')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it.skipIf(!LINK_OK)('a soft link pointing at a directory **outside the directory** → null', () => {
    const { root, cleanup } = scene();
    try {
      const outsideDir = join(root, '..', 'outside');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'x.txt'), 'X', 'utf8');
      linkDir(outsideDir, join(root, 'outdir'));
      expect(resolveInsideCard(root, 'outdir/x.txt')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it.skipIf(!LINK_OK)('a soft link pointing **inside the card directory** → allowed (an alias of the same code is not an escape)', () => {
    const { root, cleanup } = scene();
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'real.txt'), 'ok', 'utf8');
      linkDir(join(root, 'sub'), join(root, 'alias'));
      expect(resolveInsideCard(root, 'alias/real.txt')).not.toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('the MIME types', () => {
  it('js is text/javascript (**the wrong one makes the module script rejected**)', () => {
    expect(mimeFor('x.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('x.mjs')).toBe('text/javascript; charset=utf-8');
  });

  it('html / css / json / images each get their own type', () => {
    expect(mimeFor('x.html')).toBe('text/html; charset=utf-8');
    expect(mimeFor('x.css')).toBe('text/css; charset=utf-8');
    expect(mimeFor('x.json')).toBe('application/json; charset=utf-8');
    expect(mimeFor('x.svg')).toBe('image/svg+xml');
    expect(mimeFor('x.png')).toBe('image/png');
  });

  it('an unknown one → binary (**it does not guess**)', () => {
    expect(mimeFor('x.bin')).toBe('application/octet-stream');
  });
});
