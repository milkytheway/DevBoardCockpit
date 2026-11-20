import { describe, it, expect } from 'vitest';
import { discoverArtifacts, matchesPattern } from '../../../src/main/workflows/discover';
import type { FileEntry } from '../../../src/shared/ipc-contract';

/**
 * The discovery of the artefacts — **it looks by the rules, it does not
 * hard-code a file name**.
 *
 * Why the rules have to be strict:
 *
 * A build directory is full of intermediate artefacts (`.o` / `.cmd` /
 * `.order` / `.mod.c`) — miss one exclusion rule and an **intermediate file
 * may be sent to the board as an artefact** (the `modprobe` on the board
 * fails while the workflow may still report success).
 */
function entry(name: string): FileEntry {
  return { name, path: `build/${name}`, isDirectory: false, sizeBytes: 1, modifiedAt: null };
}

const DIR = {
  hello: entry('hello.ko'),
  obj: entry('hello.o'),
  cmd: entry('hello.cmd'),
  order: entry('hello.order'),
  modc: entry('hello.mod.c'),
  dir: { name: 'sub', path: 'build/sub', isDirectory: true, sizeBytes: null, modifiedAt: null },
};

describe('the discovery of the artefacts · the matching of the file name', () => {
  it('the `*` wildcard', () => {
    expect(matchesPattern('hello.ko', '*.ko')).toBe(true);
    expect(matchesPattern('hello.o', '*.ko')).toBe(false);
    expect(matchesPattern('hello.ko', 'hello.*')).toBe(true);
  });

  it('**without a `*` it is an exact match**', () => {
    expect(matchesPattern('hello.ko', 'hello.ko')).toBe(true);
    expect(matchesPattern('hello.ko', 'hello')).toBe(false);
  });

  it('`.` is not a wildcard (the dot of a regular expression has to be escaped)', () => {
    expect(matchesPattern('helloxko', '*.ko')).toBe(false);
  });
});

describe('the discovery of the artefacts · finding and excluding', () => {
  const list = async (): Promise<FileEntry[]> => [DIR.hello, DIR.obj, DIR.cmd, DIR.order, DIR.modc, DIR.dir];

  it('it is found by the pattern, **the ones of the exclusion list are not**', async () => {
    const found = await discoverArtifacts({ list: async () => list() }, {
      dir: 'build',
      pattern: '*.ko',
      exclude: ['*.o', '*.cmd', '*.order', '*.mod.c'],
    });
    expect(found).toEqual(['build/hello.ko']);
  });

  it('**a file that the pattern matched but that the exclusion list dropped** does not count either', async () => {
    // The pattern is widened to `hello.*` → the `.o` and the `.cmd` match as well →
    // **only then does the exclusion list really do its work**
    const found = await discoverArtifacts({ list: async () => list() }, {
      dir: 'build',
      pattern: 'hello.*',
      exclude: ['*.o', '*.cmd'],
    });
    expect(found).not.toContain('build/hello.o');
    expect(found).not.toContain('build/hello.cmd');
    // What was not excluded is still there
    expect(found).toContain('build/hello.ko');
  });

  it('**a directory is not an artefact**', async () => {
    const found = await discoverArtifacts({ list: async () => list() }, { dir: 'build', pattern: '*' });
    expect(found).not.toContain('build/sub');
  });

  it('when **several** are found they are sorted by name (the result has to be reproducible)', async () => {
    const found = await discoverArtifacts({ list: async () => list() }, { dir: 'build', pattern: 'hello.*' });
    expect(found).toHaveLength(5);
    // **The order is stable** (the same input → the same order)
    expect(found).toEqual([...found].sort());
    // The directory is not in it
    expect(found).not.toContain('build/sub');
  });

  it('when there is none → **an empty array** (not "give any one of them")', async () => {
    const found = await discoverArtifacts({ list: async () => list() }, { dir: 'build', pattern: '*.xyz' });
    expect(found).toEqual([]);
  });
});
