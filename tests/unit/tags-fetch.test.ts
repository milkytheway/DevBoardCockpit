import { describe, it, expect } from 'vitest';
import { buildGroupCommand, splitSections } from '../../src/main/tags/fetch';

/**
 * poll group 的合成与分段。
 *
 * 契约 `docs/spec/02-board-pack.md` §1.2：
 * **一个 poll group = 一次往返**。同组的所有 reader 合成一条 shell 命令，
 * 一次取回，每个 reader 的输出用 **marker** 隔开。
 *
 * ── 为什么要有 marker ──
 *
 * 因为「一次往返」意味着**一份输出里混着好几个 reader 的数据**。
 * 不隔开的话，A 的数据会被算成 B 的——
 * **监控面板上两个数悄悄互换，比没有监控更难查。**
 *
 * ── 协议 ──
 *
 * 每个 reader 有**一对** marker（开始 / 结束）：
 *
 * ```
 * echo '<S1>'; <frag1>; echo '<E1>'; echo '<S2>'; <frag2>; echo '<E2>'
 * ```
 *
 * 输出：
 *
 * ```
 * S1
 * <frag1 的输出>
 * E1
 * S2
 * <frag2 的输出>
 * E2
 * ```
 *
 * **用一对而不是一个**：只用一个 marker 的话，
 * 下一个 reader 的 marker 出现在上一个 reader 的输出里就会切错（RF-4）。
 * 用一对之后，**扫描从上一段的结束处往后找**——
 * 落在上一段输出里的「下一个开始标记」自然被跳过。
 *
 * **marker 必须是随机的**：128 位十六进制——
 * 读者输出里出现它的概率约等于零。
 */

const readers = [
  { id: 'cpu', fragment: 'cat -- /proc/stat' },
  { id: 'gpu', fragment: 'cat -- /sys/class/devfreq/fb000000.gpu/load' },
  { id: 'npu', fragment: 'cat -- /sys/kernel/debug/rknpu/load' },
];

describe('buildGroupCommand · 合成一条命令', () => {
  it('每个 reader 都有自己的一对 marker', () => {
    const group = buildGroupCommand(readers);
    expect(group.markers).toHaveLength(3);
    for (const m of group.markers) {
      expect(m.start.length).toBeGreaterThan(10);
      expect(m.end.length).toBeGreaterThan(10);
      expect(m.start).not.toBe(m.end);
    }
  });

  it('不同 reader 的 marker 互不相同', () => {
    const group = buildGroupCommand(readers);
    const all = group.markers.flatMap((m) => [m.start, m.end]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('命令里含每个 reader 的取数片段与 marker', () => {
    const group = buildGroupCommand(readers);
    for (const r of readers) {
      expect(group.command).toContain(r.fragment);
    }
    for (const m of group.markers) {
      expect(group.command).toContain(m.start);
      expect(group.command).toContain(m.end);
    }
  });

  it('**命令是一行**（串口一次往返只能是一行命令，事实 S6）', () => {
    const group = buildGroupCommand(readers);
    expect(group.command.includes('\n')).toBe(false);
  });

  it('两次合成产出的 marker 不一样（每次往返都必须唯一）', () => {
    const a = buildGroupCommand(readers);
    const b = buildGroupCommand(readers);
    const aAll = a.markers.flatMap((m) => [m.start, m.end]);
    const bAll = b.markers.flatMap((m) => [m.start, m.end]);
    expect(aAll.some((m) => bAll.includes(m))).toBe(false);
  });
});

describe('splitSections · 按 marker 分段', () => {
  /** 按协议拼一份输出 */
  function outputOf(group: ReturnType<typeof buildGroupCommand>, bodies: (string | null)[]): string {
    const parts: string[] = [];
    group.markers.forEach((m, i) => {
      const body = bodies[i];
      if (body === null) return;
      parts.push(m.start);
      if (body.length > 0) parts.push(body);
      parts.push(m.end);
    });
    return parts.join('\n');
  }

  it('每个 reader 拿到自己那段', () => {
    const group = buildGroupCommand(readers);
    const output = outputOf(group, ['STAT', 'GPU', 'NPU']);
    const sections = splitSections(output, group.markers);
    expect(sections.get('cpu')).toBe('STAT');
    expect(sections.get('gpu')).toBe('GPU');
    expect(sections.get('npu')).toBe('NPU');
  });

  it('空 section 是**空串**，不是 null（null 是「marker 没出现」）', () => {
    const group = buildGroupCommand(readers);
    const output = outputOf(group, ['STAT', '', 'NPU']);
    const sections = splitSections(output, group.markers);
    expect(sections.get('gpu')).toBe('');
    expect(sections.get('cpu')).toBe('STAT');
  });

  it('marker 没出现 → null（这一段没跑起来）', () => {
    const group = buildGroupCommand(readers);
    const output = outputOf(group, ['STAT', null, 'NPU']);
    const sections = splitSections(output, group.markers);
    expect(sections.get('gpu')).toBeNull();
    expect(sections.get('cpu')).toBe('STAT');
    // 缺的**不是**最后一个时，后面的照样切得出来
    expect(sections.get('npu')).toBe('NPU');
  });

  it('输出里一个字都没有 → 全是 null', () => {
    const group = buildGroupCommand(readers);
    const sections = splitSections('', group.markers);
    for (const id of ['cpu', 'gpu', 'npu']) {
      expect(sections.get(id)).toBeNull();
    }
  });

  it('**上一段的输出里含下一段的开始标记，也不切错**（RF-4）', () => {
    const group = buildGroupCommand(readers);
    const stray = group.markers[1]!.start;
    const output = outputOf(group, [`STAT${stray}GHOST`, 'GPU', 'NPU']);
    const sections = splitSections(output, group.markers);
    // cpu 拿到的是**它自己的完整内容**（含那个幽灵标记）
    expect(sections.get('cpu')).toBe(`STAT${stray}GHOST`);
    // gpu 拿到的还是它自己的那段——**没有混进 cpu 的数据**
    expect(sections.get('gpu')).toBe('GPU');
    expect(sections.get('npu')).toBe('NPU');
  });

  it('最后一段没有换行结尾也切得出来', () => {
    const group = buildGroupCommand(readers);
    const m = group.markers;
    const output = `${m[0]!.start}\nA\n${m[0]!.end}\n${m[1]!.start}\nB\n${m[1]!.end}`;
    const sections = splitSections(output, group.markers);
    expect(sections.get('cpu')).toBe('A');
    expect(sections.get('gpu')).toBe('B');
    expect(sections.get('npu')).toBeNull();
  });

  it('reader 的顺序按给定的顺序，不按 marker 的字典序', () => {
    const group = buildGroupCommand([
      { id: 'z', fragment: 'cat z' },
      { id: 'a', fragment: 'cat a' },
    ]);
    const output = outputOf(group, ['ZZZ', 'AAA']);
    const sections = splitSections(output, group.markers);
    expect(sections.get('z')).toBe('ZZZ');
    expect(sections.get('a')).toBe('AAA');
  });
});
