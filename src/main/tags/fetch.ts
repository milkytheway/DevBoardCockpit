import { randomBytes } from 'node:crypto';

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
 * **marker 是随机的 128 位**：读者输出里出现它的概率约等于零。
 * 随机性还有一个好处：**两次往返的 marker 必然不同**——
 * 串口上「一次只有一条命令在飞」，marker 撞车会让两段输出互相认领。
 */

/** 要合成进一条命令的一个 reader */
export interface GroupReaderPlan {
  /** reader 的 id（用来对回 split 的结果） */
  id: string;
  /** 取数片段（kind 的 `fetch()` 产物） */
  fragment: string;
}

/** 一个 reader 的一对 marker */
export interface ReaderMarkers {
  readerId: string;
  /** 段开始标记 */
  start: string;
  /** 段结束标记 */
  end: string;
}

/** 合成出来的一条命令与它的 marker 表 */
export interface GroupCommand {
  /** 合成出来的命令（**一行**） */
  command: string;
  /** 与输入顺序一一对应的 marker 表 */
  markers: ReaderMarkers[];
}

/**
 * 造一个随机 marker。
 *
 * **为什么不用计划 1 的 `buildMarker`**：那个是
 * `__DBC<pid>_<毫秒>__`——**同一个进程、同一个毫秒里造两次就撞了**。
 * 取数要给同一条命令里的每个 reader 各造一个，
 * 所以这里另造一套：带随机数 + 序号。
 */
function makeMarker(tag: 'S' | 'E'): string {
  return `__DBCG${tag}_${randomBytes(16).toString('hex')}__`;
}

/**
 * 把一个组的 reader 合成成**一条**命令。
 *
 * **必须是一行**——串口一次往返只能是一行命令（事实 S6）。
 */
export function buildGroupCommand(readers: GroupReaderPlan[]): GroupCommand {
  const markers: ReaderMarkers[] = readers.map((r) => ({
    readerId: r.id,
    start: makeMarker('S'),
    end: makeMarker('E'),
  }));

  const parts: string[] = [];
  readers.forEach((r, i) => {
    const m = markers[i]!;
    parts.push(`echo '${m.start}'`);
    parts.push(r.fragment);
    parts.push(`echo '${m.end}'`);
  });

  return { command: parts.join('; '), markers };
}

/** 切出来的一段 */
export interface SplitSection {
  /** 收到的原文 */
  text: string;
  /**
   * 这一段**完整吗**（开始与结束标记都到了）。
   *
   * **不完整 = 板子只回了一半**——这段数据**不能当成完整数据发布**
   * （契约 §2.1.1：「读出来了但值坏了」是 `error`）。
   */
  complete: boolean;
}

/**
 * 把一次往返的输出按 marker 切成每个 reader 的一段。
 *
 * @returns readerId → 那一段。
 *   **`null` = marker 没出现**（这一段没跑起来）；
 *   **`complete: false` = 有开始没结束**（板子只回了一半）。
 *   这两件事**必须分得开**——前者是「没读到」，后者是「读到了一半」。
 */
export function splitSections(
  output: string,
  markers: ReaderMarkers[],
): Map<string, SplitSection | null> {
  const out = new Map<string, SplitSection | null>();
  let pos = 0;

  for (const [i, m] of markers.entries()) {
    const start = output.indexOf(m.start, pos);
    if (start < 0) {
      // 这一段没跑起来。**pos 不动**——后面那几段照样切得出来。
      out.set(m.readerId, null);
      continue;
    }

    const bodyStart = start + m.start.length;
    const end = output.indexOf(m.end, bodyStart);
    if (end >= 0) {
      out.set(m.readerId, { text: output.slice(bodyStart, end).trim(), complete: true });
      pos = end + m.end.length;
      continue;
    }

    // **有开始、没有结束**：这一段被截断了（板子只回了一半）。
    //
    // 切到**下一个 reader 的开始标记**为止——
    // **不切的话，这一段会把后面 reader 的数据全吞进来**，
    // 而后面那几段反而报「没读到」：**数据被算到了别的 reader 名下**。
    //
    // 但它**标记为不完整**——调用方不许把半截数据当成完整数据发布
    // （契约 §2.1.1：截断的值是「坏了」，报 `error`，不是 `ok`）。
    const next = markers[i + 1];
    const boundary = next === undefined ? -1 : output.indexOf(next.start, bodyStart);
    const text = boundary >= 0 ? output.slice(bodyStart, boundary) : output.slice(bodyStart);
    out.set(m.readerId, { text: text.trim(), complete: false });
    pos = boundary >= 0 ? boundary : bodyStart;
  }

  return out;
}
