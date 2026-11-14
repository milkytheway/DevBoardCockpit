import { describe, it, expect } from 'vitest';
import { discoverArtifacts, matchesPattern } from '../../../src/main/workflows/discover';
import type { FileEntry } from '../../../src/shared/ipc-contract';

/**
 * 产物发现 —— **按规则找，不写死文件名**。
 *
 * ── 为什么规则要严 ──
 *
 * 编译目录里满是中间产物（`.o` / `.cmd` / `.order` / `.mod.c`）——
 * 漏一条排除规则，就可能**把中间文件当产物送到板子上** ✗
 * （板子上的 `modprobe` 会失败，而流程可能还报成功 ✗）。
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

describe('产物发现 · 文件名匹配', () => {
  it('`*` 通配', () => {
    expect(matchesPattern('hello.ko', '*.ko')).toBe(true);
    expect(matchesPattern('hello.o', '*.ko')).toBe(false);
    expect(matchesPattern('hello.ko', 'hello.*')).toBe(true);
  });

  it('**没有 `*` 就是精确匹配**', () => {
    expect(matchesPattern('hello.ko', 'hello.ko')).toBe(true);
    expect(matchesPattern('hello.ko', 'hello')).toBe(false);
  });

  it('`.` 不当通配（正则里的点要转义）', () => {
    expect(matchesPattern('helloxko', '*.ko')).toBe(false);
  });
});

describe('产物发现 · 找与排除', () => {
  const list = async (): Promise<FileEntry[]> => [DIR.hello, DIR.obj, DIR.cmd, DIR.order, DIR.modc, DIR.dir];

  it('按 pattern 找到，**排除表里的不要**', async () => {
    const found = await discoverArtifacts({ list: async () => list() }, {
      dir: 'build',
      pattern: '*.ko',
      exclude: ['*.o', '*.cmd', '*.order', '*.mod.c'],
    });
    expect(found).toEqual(['build/hello.ko']);
  });

  it('**目录不算产物**', async () => {
    const found = await discoverArtifacts({ list: async () => list() }, { dir: 'build', pattern: '*' });
    expect(found).not.toContain('build/sub');
  });

  it('找到**多个**时按名字排序（结果要可复现 ✓）', async () => {
    const found = await discoverArtifacts({ list: async () => list() }, { dir: 'build', pattern: 'hello.*' });
    expect(found).toHaveLength(5);
    // **排序稳定**（同样的输入 → 同样的顺序 ✓）
    expect(found).toEqual([...found].sort());
    // 目录不在里面
    expect(found).not.toContain('build/sub');
  });

  it('一个都没有 → **空数组**（不是「随便给一个」✓）', async () => {
    const found = await discoverArtifacts({ list: async () => list() }, { dir: 'build', pattern: '*.xyz' });
    expect(found).toEqual([]);
  });
});
