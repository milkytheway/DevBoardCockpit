import { describe, it, expect } from 'vitest';
import { buildGroupCommand, splitSections } from '../../src/main/tags/fetch';

/**
 * The composition and the segmentation of a poll group.
 *
 * Contract `docs/spec/02-board-pack.md` §1.2: **one poll group = one round
 * trip**. All the readers of the group compose one shell command, it is
 * fetched in one go, and the output of every reader is separated by a
 * **marker**.
 *
 * Why there are markers:
 *
 * "One round trip" means that **one output holds the data of several
 * readers**. Without the separation the data of A would be counted as the
 * data of B, and **two numbers swapping on the monitor panel are harder to
 * find than no monitor at all.**
 *
 * The protocol:
 *
 * Every reader has **a pair** of markers (start / end):
 *
 * ```
 * echo '<S1>'; <frag1>; echo '<E1>'; echo '<S2>'; <frag2>; echo '<E2>'
 * ```
 *
 * The output:
 *
 * ```
 * S1
 * <the output of frag1>
 * E1
 * S2
 * <the output of frag2>
 * E2
 * ```
 *
 * **A pair and not a single marker**: with a single marker the marker of the
 * next reader appearing inside the output of the previous one would split it
 * in the wrong place (RF-4). With a pair **the scan starts behind the end of
 * the previous section**, so a "next start marker" that fell into the output
 * of the previous section is simply skipped.
 *
 * **The markers have to be random**: 128 bits of hexadecimal — the
 * probability that one of them appears in the output of a reader is
 * practically zero.
 */

const readers = [
  { id: 'cpu', fragment: 'cat -- /proc/stat' },
  { id: 'gpu', fragment: 'cat -- /sys/class/devfreq/fb000000.gpu/load' },
  { id: 'npu', fragment: 'cat -- /sys/kernel/debug/rknpu/load' },
];

describe('buildGroupCommand · it composes one command', () => {
  it('every reader has its own pair of markers', () => {
    const group = buildGroupCommand(readers);
    expect(group.markers).toHaveLength(3);
    for (const m of group.markers) {
      expect(m.start.length).toBeGreaterThan(10);
      expect(m.end.length).toBeGreaterThan(10);
      expect(m.start).not.toBe(m.end);
    }
  });

  it('the markers of different readers differ from each other', () => {
    const group = buildGroupCommand(readers);
    const all = group.markers.flatMap((m) => [m.start, m.end]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('the command holds the data snippet and the markers of every reader', () => {
    const group = buildGroupCommand(readers);
    for (const r of readers) {
      expect(group.command).toContain(r.fragment);
    }
    for (const m of group.markers) {
      expect(group.command).toContain(m.start);
      expect(group.command).toContain(m.end);
    }
  });

  it('**the command is one line** (one round trip over a serial port can only carry one command, fact S6)', () => {
    const group = buildGroupCommand(readers);
    expect(group.command.includes('\n')).toBe(false);
  });

  it('the markers of two compositions differ (every round trip has to be unique)', () => {
    const a = buildGroupCommand(readers);
    const b = buildGroupCommand(readers);
    const aAll = a.markers.flatMap((m) => [m.start, m.end]);
    const bAll = b.markers.flatMap((m) => [m.start, m.end]);
    expect(aAll.some((m) => bAll.includes(m))).toBe(false);
  });
});

describe('splitSections · it segments by the markers', () => {
  /** Composes an output according to the protocol */
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

  it('every reader gets its own section', () => {
    const group = buildGroupCommand(readers);
    const output = outputOf(group, ['STAT', 'GPU', 'NPU']);
    const sections = splitSections(output, group.markers);
    expect(sections.get('cpu')).toEqual({ text: 'STAT', complete: true });
    expect(sections.get('gpu')).toEqual({ text: 'GPU', complete: true });
    expect(sections.get('npu')).toEqual({ text: 'NPU', complete: true });
  });

  it('an empty section is an **empty string**, not null (null means "the marker never appeared")', () => {
    const group = buildGroupCommand(readers);
    const output = outputOf(group, ['STAT', '', 'NPU']);
    const sections = splitSections(output, group.markers);
    expect(sections.get('gpu')).toEqual({ text: '', complete: true });
    expect(sections.get('cpu')?.text).toBe('STAT');
  });

  it('the marker never appeared → null (this section did not run)', () => {
    const group = buildGroupCommand(readers);
    const output = outputOf(group, ['STAT', null, 'NPU']);
    const sections = splitSections(output, group.markers);
    expect(sections.get('gpu')).toBeNull();
    expect(sections.get('cpu')?.text).toBe('STAT');
    // When the missing one is **not** the last, the following ones are split out
// as well
    expect(sections.get('npu')?.text).toBe('NPU');
  });

  it('not a single byte in the output → everything is null', () => {
    const group = buildGroupCommand(readers);
    const sections = splitSections('', group.markers);
    for (const id of ['cpu', 'gpu', 'npu']) {
      expect(sections.get(id)).toBeNull();
    }
  });

  it('**a start without an end** → it does not swallow the data of the following readers and it is marked incomplete', () => {
    // "The board only answered half": the end marker of the section in the middle
// never arrived.
    // **The old behaviour**: the section was taken to the end of the output → it
// swallowed the data of all the following readers,
    // while the following sections reported "not read" — **the data was counted
// under another reader**.
    const group = buildGroupCommand(readers);
    const [cpu, gpu, npu] = group.markers;
    const output = [
      cpu!.start,
      'STAT',
      gpu!.start,
      'GPU',
      gpu!.end,
      npu!.start,
      'NPU',
      npu!.end,
    ].join('\n');
    const sections = splitSections(output, group.markers);
    // cpu got **its own** section (without the data of gpu), but it is **marked
// incomplete**
    expect(sections.get('cpu')?.text).toBe('STAT');
    expect(sections.get('cpu')?.complete).toBe(false);
    // The following sections are split out **as well**
    expect(sections.get('gpu')?.text).toBe('GPU');
    expect(sections.get('npu')?.text).toBe('NPU');
  });

  it('**the last section is truncated** → it is marked incomplete', () => {
    const group = buildGroupCommand(readers);
    const [cpu, gpu, npu] = group.markers;
    const output = [
      cpu!.start,
      'STAT',
      cpu!.end,
      gpu!.start,
      'GPU',
      gpu!.end,
      npu!.start,
      'NPU',
    ].join('\n');
    const sections = splitSections(output, group.markers);
    expect(sections.get('npu')?.text).toBe('NPU');
    expect(sections.get('npu')?.complete).toBe(false);
    expect(sections.get('gpu')?.complete).toBe(true);
  });

  it('**the output of one section contains the start marker of the next one and the split is still right** (RF-4)', () => {
    const group = buildGroupCommand(readers);
    const stray = group.markers[1]!.start;
    const output = outputOf(group, [`STAT${stray}GHOST`, 'GPU', 'NPU']);
    const sections = splitSections(output, group.markers);
    // The cpu got **its own complete content** (including that ghost marker)
    expect(sections.get('cpu')?.text).toBe(`STAT${stray}GHOST`);
    // The gpu still got its own section — **no data of the cpu mixed into it**
    expect(sections.get('gpu')?.text).toBe('GPU');
    expect(sections.get('npu')?.text).toBe('NPU');
  });

  it('the last section is split out even without a trailing newline', () => {
    const group = buildGroupCommand(readers);
    const m = group.markers;
    const output = `${m[0]!.start}\nA\n${m[0]!.end}\n${m[1]!.start}\nB\n${m[1]!.end}`;
    const sections = splitSections(output, group.markers);
    expect(sections.get('cpu')?.text).toBe('A');
    expect(sections.get('gpu')?.text).toBe('B');
    expect(sections.get('npu')).toBeNull();
  });

  it('the order of the readers is the given one, not the lexicographic order of the markers', () => {
    const group = buildGroupCommand([
      { id: 'z', fragment: 'cat z' },
      { id: 'a', fragment: 'cat a' },
    ]);
    const output = outputOf(group, ['ZZZ', 'AAA']);
    const sections = splitSections(output, group.markers);
    expect(sections.get('z')?.text).toBe('ZZZ');
    expect(sections.get('a')?.text).toBe('AAA');
  });
});
