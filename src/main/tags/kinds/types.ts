import type { ParseResult } from './parse-util';

/**
 * The shape of a reader kind.
 *
 * Contract: `docs/spec/02-board-pack.md` section 2.4 (the list of built-in
 * reader kinds for v1).
 *
 * Every kind declares three things: which arguments it accepts, which
 * samples it produces and how it fetches from the board. A closed list means
 * a closed mental model for the AI, so an agent writing a card does not
 * have to guess.
 */

/** The declaration of one argument */
export interface ParamSpec {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'glob' | 'map';
  /** Required (rule 9) */
  required?: boolean;
  /** The list of allowed values for `type: enum` */
  values?: string[];
  default?: unknown;
  /**
   * At least one of this group has to be given.
   *
   * The `path`/`glob` of `file_read` are of this kind (contract section 2.4
   * names `path`/`glob`) — not "one required and one optional" but "one of
   * the two".
   */
  oneOf?: string[];
}

/**
 * The context handed to the parser.
 *
 * Parsing is a pure function (N1): the same input gives the same output.
 * The only state allowed is "the history between two samples" (the previous
 * counters of `proc_stat`), and that state is handed in by the runtime — it
 * may not hide in a module-level variable, or two connections would pollute
 * each other's history.
 */
export interface ReaderContext {
  state: Record<string, unknown>;
}

/** One reader kind */
export interface ReaderKind {
  id: string;
  /** The argument schema: name → declaration. Rules 8/9 consult it */
  params: Record<string, ParamSpec>;
  /**
   * The sample patterns this kind can produce.
   *
   * Rule 6 compares the `provides[].sample` of a pack against them — so
   * what is stored here are patterns (`zone.*`), not concrete names.
   */
  samples: string[];
  /**
   * The number of segments in a sample name is not fixed (contract section
   * 3.3, last paragraph: only `script`).
   *
   * The samples of `script` come from the keys of the JSON the script
   * prints, so its samples cannot be written as a fixed list.
   */
  unboundedSamples?: boolean;
  /**
   * Two samples are needed (contract section 2.4: only `proc_stat`).
   *
   * The first read yields `pending`, not 0 (rule 5).
   */
  needsTwoSamples?: boolean;
  /**
   * The fetch fragment of this kind has to use the remote path supplied by
   * the runtime (`args['remote_path']`).
   *
   * `script` is the only one: the script lives on the host and has to be
   * pushed into `/tmp` on the board before it can run (contract section
   * 3.3). While the runtime has not supplied a remote path yet, it must not
   * build a command that is bound to fail — it reports honestly that the
   * script was not pushed.
   */
  needsRemotePath?: boolean;
  /**
   * The fetch: the shell fragment that gets the data back from the board.
   *
   * It has to be a single line — one round trip on a serial line carries
   * one command (fact S6).
   */
  fetch(args: Record<string, unknown>): string;
  /**
   * The parse: turn the text the board returned into samples.
   *
   * A pure function (N1): the same input gives the same output.
   * Not readable is not 0 (N2): when it cannot be parsed → `unavailable`;
   * never fill in 0, never return NaN.
   */

  parse(raw: string, args: Record<string, unknown>, ctx: ReaderContext): ParseResult;
}

export type { ParseResult };
