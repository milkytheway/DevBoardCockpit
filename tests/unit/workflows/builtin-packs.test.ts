import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { parseWorkflow } from '../../../src/main/workflows/format';

/**
 * **内置流程包的黄金判据**（2026-11-19 · 装机版验收时挖出来的 ✓）。
 *
 * ── 为什么内置包要有守卫 ──
 *
 * → 内置包是**产品的一部分** ✓ —— 它坏了，用户第一次点就撞上 ✗。
 * → 而且它是**流程包格式的活样本** ✓ —— agent 照着它学怎么写 ✓
 *   → **它写错了，agent 照着抄就一起错** ✗。
 *
 * ── 这一批守什么（三条，都是真机挖出来的 ✓）──
 *
 * | # | 规矩 | 为什么 |
 * |---|---|---|
 * | 1 | **`build_dir` 的默认值必须是真机上真实存在的那个目录** ✓ | 写错了 → 「编译上板」点一下**必失败** ✗（实测 2026-11-19 ✓） |
 * | 2 | **`inputs.default` 不得与「同一台机器上另一个包」矛盾** ✓ | 两个包指向不同的客机目录 → 用户得猜 ✗ |
 * | 3 | **写侧动作的包必须声明它要用的输入** ✓ | 少声明 → 调用方传不进来 → 步跑不通 ✗ |
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const PACK_DIR = join(REPO_ROOT, 'profiles', 'workflows');

/** 读一个内置包（**真的走解析器** ✓ —— 不是读 YAML 文本 ✓） */
function loadPack(file: string): ReturnType<typeof parseWorkflow> {
  const raw = yaml.load(readFileSync(join(PACK_DIR, file), 'utf8'));
  return parseWorkflow(raw, file);
}

/** 客机上**真实存在**的工程根目录（2026-11-19 真机实测 ✓） */
const REAL_BUILD_DIR = '/home/alientek/build';

describe('内置流程包 · 黄金判据（真机实测 2026-11-19）', () => {
  it('**每个内置包都解析得过** ✓（格式层自己先守住 ✓）', () => {
    for (const file of readdirSync(PACK_DIR)) {
      if (!file.endsWith('.yaml')) continue;
      expect(() => loadPack(file)).not.toThrow();
    }
  });

  it('**`build_dir` 的默认值指向真机上真实存在的目录** ✓（写错 → 「编译上板」点一下必失败 ✗）', () => {
    // **真机实测（2026-11-19 · 客机）**：`/home/alientek/build/01-hello` 在 ✓
    // → 而 `/home/alientek/kernel-build` **不存在** ✗ → 照着它默认值跑 = 必失败 ✗
    for (const file of ['hello-kernel.compile.yaml', 'hello-kernel.upload.yaml']) {
      const pack = loadPack(file);
      const def = pack.inputs['build_dir'];
      expect(def, `${file} 应该有 build_dir 输入`).toBeDefined();
      expect(
        def?.default,
        `${file} 的 build_dir 默认值必须是真机上的 ${REAL_BUILD_DIR}（2026-11-19 实测）`,
      ).toBe(REAL_BUILD_DIR);
    }
  });

  it('**「编译上板」那张卡的 placeholder 与包里的默认值一致** ✓（人看到的与实际跑的是同一个 ✓）', () => {
    const html = readFileSync(join(REPO_ROOT, 'cards', 'build-deploy', 'index.html'), 'utf8');
    expect(html).toContain(REAL_BUILD_DIR);
    expect(html).not.toContain('/home/alientek/kernel-build');
  });

  it('**要写板的包都声明了 `build_dir`** ✓（少声明 → 调用方传不进来 ✗）', () => {
    for (const file of ['hello-kernel.compile.yaml', 'hello-kernel.upload.yaml']) {
      const pack = loadPack(file);
      expect(Object.keys(pack.inputs)).toContain('build_dir');
    }
  });
});
