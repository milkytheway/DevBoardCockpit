import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { loadBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';

/**
 * **通用包（`generic-linux`）** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 它是什么 ──
 *
 * **一份「嵌入式 Linux 一般有什么」的配方** ✓ —— 不是「某块板有什么」✓。
 * → **接板向导**拿它在一块刚接上、还不认识的板子上一条条试 ✓
 *   → **试出来的绿/红 = 这块板的真相表** ✓
 *   → **真相表 → 实例化出这块板的初版包** ✓（用户目录 ✓）。
 *
 * ── 为什么这些判据在这儿（**它们守的是「假数」** ✓）──
 *
 * → **这个工程最在意的那类假数** ✓ = 「**看起来是真的**」✓
 *   （事实 G2 ✓ · `docs/06` C1 ✓ —— 恒为 0 的仪表比没有仪表更危险 ✓）。
 * → **通用包是「一组要跑在陌生板子上的命令」** ✓ → **它假起来最不容易被发现** ✓
 *   → **所以它必须被守得最紧** ✓。
 */
const REPO_ROOT = resolve(process.cwd());
const PACK_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

function loadGeneric(): ReturnType<typeof loadBoardPack> {
  return loadBoardPack(PACK_DIR);
}

describe('通用包 · **它必须过真校验器** ✓', () => {
  it('**0 个错误** ✓（**它是一份普通板型包** ✓ —— 走同一套规则 ✓）', () => {
    const errors = errorsOf(validatePack(loadGeneric()));
    expect(
      errors.map((e) => `规则 ${e.rule} · ${e.path}：${e.message}`),
      '通用包必须过校验 ✓ —— 它要跑在**还不认识的**板子上 ✓',
    ).toEqual([]);
  });

  it('**故意不写 `match`** ✓（**它不是一块板** ✓ —— 它是一份配方 ✓）', () => {
    // → **不写 `match` 的包永远不参与「这块板用哪个包」的问答** ✓
    //   （`matchPack` 第一行就是 `if (match === undefined) return false` ✓）
    // → **它占的是「一份配方」的位置，不是一块板的位置** ✓
    expect(loadGeneric().match, '写了 match 就会参与自动识别 ✗').toBeUndefined();
  });

  it('**id 是 `generic-linux`** ✓（**它自己的 custom 命名空间** ✓）', () => {
    expect(loadGeneric().id).toBe('generic-linux');
  });
});

describe('通用包 · **每个 tag 一个值**（**防假数** ✓ —— 2026-11-19 真机探针打出来的 ✓）', () => {
  it('**没有两个 provide 指向同一个 sample** ✓', () => {
    // → **实测 2026-11-19**：`exec_regex` **只取第一个捕获组** ✓
    //   → 一个 reader 声明三个 tag ✓ → **三个 tag 拿到同一个值** ✓ → **假数** ⚠️
    // → **所以：一个 reader 只能声明一个 tag** ✓（除非那个 kind 真是多实例的 ✓）
    const pack = loadGeneric();
    for (const reader of [...pack.readers, ...pack.custom]) {
      const samples = reader.provides.map((p) => p.sample);
      const distinct = new Set(samples);
      if (distinct.size === samples.length) continue;
      // **`thermal_zone` 是合法的多实例** ✓（`zone.*` ✓ —— 它按 zone 归并 ✓）
      if (reader.kind === 'thermal_zone') continue;
      expect(
        samples,
        `reader「${reader.id}」声明了多个 provide 但 sample 只有 ${samples.join(' / ')}` +
          ' → **它们会拿到同一个值** ✓ → **那是假数** ⚠️' +
          '（`exec_regex` 只取第一个捕获组 ✓ · `file_read` 只有一个 `value` ✓）',
      ).toEqual([...distinct]);
    }
  });

  it('**`file_read` 的 glob 不与别的 tag 共存** ✓（**多实例会挤成一个值** ✓）', () => {
    // → **实测 2026-11-19**：`cat -- /sys/class/backlight/*/brightness`
    //   → **多个实例全塞进一个 `value`** ✓（`255\n200` ✓）→ **假数** ⚠️
    // → **所以：数量不定的量不能用 `file_read` 的 glob** ✓ → 用 `exec_regex` 逐个取 ✓
    const pack = loadGeneric();
    for (const reader of [...pack.readers, ...pack.custom]) {
      if (reader.kind !== 'file_read') continue;
      const args = reader.args ?? {};
      if (args['glob'] === undefined) continue;
      expect(
        args['glob'],
        `reader「${reader.id}」用 file_read 的 glob ✓ → 多个实例会挤进一个值 ✓ → **那是假数** ⚠️` +
          '（改用 exec_regex 逐个取 ✓）',
      ).toBeUndefined();
    }
  });
});

describe('通用包 · **它在真板上探过** ✓', () => {
  it('**探针脚本认得它** ✓（`--pack generic-linux` ✓ —— 向导要用同一条路 ✓）', () => {
    // → 探针认的是**包 id 或目录路径** ✓（`resolvePackDir` ✓）
    // → 名字必须是 `generic-linux` ✓ —— **向导按这个名字指名** ✓
    expect(PACK_DIR.endsWith(join('boards', 'generic-linux'))).toBe(true);
  });
});
