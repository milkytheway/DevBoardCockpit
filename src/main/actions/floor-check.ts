import { matchDangerFloorArgv, tokenizeCommand, type FloorMatch } from '../tags/floor';

/**
 * The runtime re-check of the danger floor — contract
 * `docs/spec/02-board-pack.md` §5.2.1.
 *
 * ── How it differs from the validator's check ──
 *
 * | | What it inspects | When |
 * |---|---|---|
 * | The validator (rule 16) | The command template | At pack install time |
 * | Here | The encoded final command | Before every execution |
 *
 * The difference is the parameter values: the template `rm -rf {dir}` is
 * clean, while when the value of `dir` is `/` the final command is
 * `rm -rf /`.
 * → Checking dangerous actions in the template alone is not enough (§5.3 says
 *   exactly this).
 *
 * ── Disposition ──
 *
 * A hit → treat it as `destructive` (it goes through the confirmation
 * channel, not an outright refusal) —
 * §5.2.1: "before the runtime executes an action, it compares the command
 * against the floor table. Any hit means the action is treated as
 * destructive".
 *
 * No hit ≠ safe (§5.2): a pattern that is not in the table is governed by the
 * pack's declaration, but a warning must be recorded.
 */
export interface FloorVerdict extends FloorMatch {
  /** A hit → treat it as `destructive`; no hit → `ok` */
  verdict: 'ok' | 'destructive';
  /** The warning when nothing was hit (not matching the floor does not mean safe) */
  warning: string | null;
}

/**
 * Run the argv against the floor.
 *
 * It does not tokenize again — the words passed in are exactly the ones the
 * shell will see (tokenization is done by `tokenizeCommand`, which the
 * encoder and this module share).
 */
export function checkFloorArgv(argv: string[]): FloorVerdict {
  const match = matchDangerFloorArgv(argv);
  if (match.matched) {
    return { ...match, verdict: 'destructive', warning: null };
  }
  return {
    ...match,
    verdict: 'ok',
    warning:
      'the command hits none of the danger floor rules — **not matching does not mean safe**: ' +
      'a pattern that is not in the table follows what the pack declares, but this one has to go into the audit log',
  };
}

/**
 * Run a final command (after encoding) against the floor.
 *
 * @param command The encoded command (the product of `actions/encoder`).
 */
export function checkFloor(command: string): FloorVerdict {
  return checkFloorArgv(tokenizeCommand(command));
}
