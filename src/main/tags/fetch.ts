import { randomBytes } from 'node:crypto';

/**
 * The composition and the splitting of a poll group.
 *
 * Contract `docs/spec/02-board-pack.md` section 1.2:
 * one poll group = one round trip. All the readers of the group are composed
 * into one shell command, fetched in one go, and the output of each reader is
 * separated by a marker.
 *
 * ── Why there are markers ──
 *
 * "One round trip" means that one output carries the data of several readers.
 * Without a separator the data of A would be counted as the data of B — two
 * numbers silently swapping places on a dashboard is harder to find than no
 * dashboard at all.
 *
 * ── The protocol ──
 *
 * Every reader has a pair of markers (start / end):
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
 * A pair and not a single marker: with a single marker, the marker of the
 * next reader appearing inside the output of the previous one would cut in
 * the wrong place (RF-4). With a pair the scan starts after the end of the
 * previous section — a "next start marker" that falls inside the output of
 * the previous section is skipped by construction.
 *
 * The marker is a random 128 bits: the probability that it appears in the
 * output of a reader is about zero. Randomness has a second benefit: the
 * markers of two round trips are necessarily different — on a serial line
 * only one command is in flight, and colliding markers would let two
 * sections claim each other.
 */

/** One reader to be composed into one command */
export interface GroupReaderPlan {
  /** The id of the reader (used to match the result of the split) */
  id: string;
  /** The fetch fragment (the product of the kind's `fetch()`) */
  fragment: string;
}

/** The pair of markers of one reader */
export interface ReaderMarkers {
  readerId: string;
  /** The start marker of the section */
  start: string;
  /** The end marker of the section */
  end: string;
}

/** The composed command and its marker table */
export interface GroupCommand {
  /** The composed command (one line) */
  command: string;
  /** The marker table, one entry per input in the same order */
  markers: ReaderMarkers[];
}

/**
 * Build one random marker.
 *
 * Why not the `buildMarker` of plan 1: that one is `__DBC<pid>_<ms>__` —
 * two markers built in the same process and the same millisecond collide.
 * The fetch needs one marker per reader inside the same command, so this one
 * builds its own: a random number plus a serial number.
 */
function makeMarker(tag: 'S' | 'E'): string {
  return `__DBCG${tag}_${randomBytes(16).toString('hex')}__`;
}

/**
 * Compose the readers of a group into one command.
 *
 * It has to be a single line — one round trip on a serial line carries one
 * command (fact S6).
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

/** One split-out section */
export interface SplitSection {
  /** The text as it was received */
  text: string;
  /**
   * Whether this section is complete (both the start and the end marker
   * arrived).
   *
   * Incomplete = the board only answered half — this data must not be
   * published as complete data (contract section 2.1.1: "it was read but the
   * value is broken" is an `error`).
   */
  complete: boolean;
}

/**
 * Split the output of one round trip into one section per reader, by marker.
 *
 * @returns readerId → that section.
 *   `null` = the marker never appeared (this section did not run);
 *   `complete: false` = there was a start but no end (the board only
 *   answered half).
 *   These two have to stay apart — the first is "not read", the second is
 *   "read half".
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
      // This section did not run. The position does not move — the later sections can still be split out.
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

    // A start but no end: this section was truncated (the board only
    // answered half).
    //
    // Cut it at the start marker of the next reader — without that cut this
    // section would swallow the data of every later reader, while those
    // sections would report "not read": the data would be counted under
    // another reader's name.
    //
    // But it is marked as incomplete — the caller may not publish half a
    // section as complete data (contract section 2.1.1: a truncated value
    // is "broken", report `error`, not `ok`).
    const next = markers[i + 1];
    const boundary = next === undefined ? -1 : output.indexOf(next.start, bodyStart);
    const text = boundary >= 0 ? output.slice(bodyStart, boundary) : output.slice(bodyStart);
    out.set(m.readerId, { text: text.trim(), complete: false });
    pos = boundary >= 0 ? boundary : bodyStart;
  }

  return out;
}
