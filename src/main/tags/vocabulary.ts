import { CORE_VOCABULARY } from '../../shared/generated/tag-vocabulary.generated';

/**
 * 能力词表与 tag 模式匹配。
 *
 * 契约：`docs/spec/02-board-pack.md` §10.3（能力词表与词义对照表）、
 * §1.1（sample 与 tag 两个命名空间）、§七 规则 1 / 25 / 26。
 * 决策：`docs/05` ADR-D24。
 *
 * ── 两套词，两个轴 ──
 *
 * | | 板级能力 | 连接级能力 |
 * |---|---|---|
 * | 回答 | 这块板能做什么 | **这条连接**能做什么 |
 * | 封闭词表 | `{shell, exec, stream, files}` | `{exec, pty, files, exitCode}` |
 * | 谁声明 | 板型包（`requires.capabilities`） | 运行时按 profile 协商 |
 *
 * **同名不同义**：串口传不了文件（事实 S7）但**板子**当然有文件通道——
 * 所以 `files` 在契约里是板子的属性，在实现里是连接的属性。
 * 这就是实现层那个类型叫 `ConnectionCapabilities` 而不是 `Capabilities` 的原因。
 */

/** 板级能力词表（封闭，契约 §10.3.1） */
export const BOARD_CAPABILITIES = ['shell', 'exec', 'stream', 'files'] as const;

/**
 * **运行时已实现**的板级能力（规则 26 的数据）。
 *
 * `stream` **不在**这里：Stream 的业务契约还没写（`spec/00` §七），
 * 声明了也给不出来——**规则 26 把它当错误拦下**。
 *
 * **这张表是数据，不是规则。** Stream 落地那天，
 * **改的是这张表，不是规则 26**。
 */
export const IMPLEMENTED_CAPABILITIES = ['shell', 'exec', 'files'] as const;

/** 这个词是不是板级能力词表里的一个（规则 25） */
export function isBoardCapability(value: string): boolean {
  return (BOARD_CAPABILITIES as readonly string[]).includes(value);
}

/** 这个能力当前**能不能交付**（规则 26） */
export function isImplementedCapability(value: string): boolean {
  return (IMPLEMENTED_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * tag 的模式匹配。
 *
 * `*` **只吃一段**，且**不吃空段**。
 *
 * **它同时用在两个命名空间上**——tag 与 sample 的模式规则一样，
 * 只是名字所在的命名空间不同（契约 §1.1）。规则 7
 * （「tag 与 sample 的 `*` 数量必须一致」）就靠这一点成立。
 */
export function matchTagPattern(pattern: string, name: string): boolean {
  const ps = pattern.split('.');
  const ns = name.split('.');
  // 段数必须一致（规则 7：「段数不必一致」说的是 tag 与 sample 之间，
  // 不是说 pattern 与 name 之间——**同一次匹配里**段数必须一样）
  if (ps.length !== ns.length) return false;
  for (let i = 0; i < ps.length; i += 1) {
    if (ps[i] === '*') {
      // 通配段不能匹配空段：`cpu.core..usage` 不是 `cpu.core.*.usage`
      if (ns[i].length === 0) return false;
      continue;
    }
    if (ps[i] !== ns[i]) return false;
  }
  return true;
}

/** 核心词表（从 YAML 生成的机器可读形态）——规则 1 与单位查它 */
export { CORE_VOCABULARY };

/**
 * 这个 tag 是不是**核心词表**里的（规则 1）。
 *
 * 核心词表里的条目是**模式**（`cpu.core.*.usage`），
 * 所以要拿模式去比，而不是拿字符串比。
 */
export function isCoreTag(name: string): boolean {
  return CORE_VOCABULARY.some((entry) => matchTagPattern(entry.pattern, name));
}

/**
 * 这个 tag 是不是**本包**的 custom 私有量（规则 1）。
 *
 * 命名空间是 `custom.<本包 id>.` —— **包 id 必须是自己的**，
 * 别的包的私有量不许借（那会让两个板型的语义混起来）。
 */
export function isCustomTag(name: string, packId: string): boolean {
  return name.startsWith(`custom.${packId}.`);
}

/**
 * 把一个具体的 sample 绑成 tag（契约 §1.1）。
 *
 * 「`*` 的位置一一对应」——指的是**第 i 个通配段**互相对应，
 * **不是同一个段号**：
 *
 * ```
 * tag:    cpu.core.*.usage   ← 第 0 个通配段在第 2 段
 * sample: core.*.usage       ← 第 0 个通配段在第 1 段
 * ```
 *
 * sample `core.3.usage` → tag `cpu.core.3.usage`。
 *
 * @returns 绑不上的话返回 null（**不猜**）。
 */
export function bindSampleToTag(
  tagPattern: string,
  samplePattern: string,
  concreteSample: string,
): string | null {
  const tagParts = tagPattern.split('.');
  const sampleParts = samplePattern.split('.');
  const concrete = concreteSample.split('.');

  if (concrete.length !== sampleParts.length) return null;

  // 字面段要逐位对上
  for (let i = 0; i < sampleParts.length; i += 1) {
    if (sampleParts[i] !== '*' && sampleParts[i] !== concrete[i]) return null;
  }

  // 收集 sample 的通配值（按出现顺序）
  const values: string[] = [];
  for (let i = 0; i < sampleParts.length; i += 1) {
    if (sampleParts[i] === '*') values.push(concrete[i]!);
  }

  // 填进 tag 的通配位（按出现顺序）
  const out = tagParts.slice();
  let k = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] !== '*') continue;
    const value = values[k];
    if (value === undefined) return null; // 通配数量不一致（规则 7）
    out[i] = value;
    k += 1;
  }
  if (k !== values.length) return null;

  return out.join('.');
}

/**
 * 一个 tag 的单位（从核心词表查）。
 *
 * **custom 命名空间的 tag 不在核心词表里** → 单位是 `-`（无量纲）。
 */
export function unitForTag(tag: string): string {
  const entry = CORE_VOCABULARY.find((e) => matchTagPattern(e.pattern, tag));
  return entry?.unit ?? '-';
}
