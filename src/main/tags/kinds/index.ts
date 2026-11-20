import { PROC_STAT } from './proc-stat';
import { MEMINFO } from './meminfo';
import { DEVFREQ_LOAD } from './devfreq-load';
import { RKNPU_LOAD } from './rknpu-load';
import { THERMAL_ZONE } from './thermal-zone';
import { FILE_READ } from './file-read';
import { EXEC_REGEX } from './exec-regex';
import { SCRIPT } from './script';
import type { ReaderKind } from './types';

/**
 * The reader kind registry.
 *
 * Contract: `docs/spec/02-board-pack.md` section 2.4 — this table is part of
 * the contract, and the implementation supplies its machine-readable form.
 *
 * The list is closed: v1 has exactly these 8 (the table in section 2.4).
 * Adding a kind is a contract change that needs a review, not something to
 * slip in on the side.
 *
 * Rules 6 (does the sample exist), 8 (is a parameter name misspelled) and
 * 9 (is a required parameter missing) all consult this table, so it has to
 * exist before the validator does.
 */

export type { ReaderKind, ParamSpec, ReaderContext, ParseResult } from './types';

/** Every kind (in the order of the table in contract section 2.4) */
export const READER_KINDS: readonly ReaderKind[] = [
  PROC_STAT,
  MEMINFO,
  DEVFREQ_LOAD,
  RKNPU_LOAD,
  THERMAL_ZONE,
  FILE_READ,
  EXEC_REGEX,
  SCRIPT,
];

const BY_ID = new Map<string, ReaderKind>(READER_KINDS.map((k) => [k.id, k]));

/** The id of every kind (the order of contract section 2.4) */
export function kindIds(): string[] {
  return READER_KINDS.map((k) => k.id);
}

/**
 * Look up one kind by id.
 *
 * A miss returns undefined and does not throw: "this kind does not exist" is
 * the validator's business (rules 6/8), and the runtime must not fall over
 * here.
 */
export function getKind(id: string): ReaderKind | undefined {
  return BY_ID.get(id);
}
