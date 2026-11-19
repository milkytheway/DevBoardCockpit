/**
 * The structure and the states of a tag reading.
 *
 * Contract: `docs/spec/01-tag-contract.md` section 2.1 (the model of the
 * five states) and section 2.1.1 (the structure of a reading and the table
 * of reason codes).
 *
 * The definition lives in shared: main produces the readings and the
 * renderer consumes them — both sides have to use one definition and must
 * not each keep a copy (that is exactly where reading drift comes from).
 */

/** The five states of a reading (contract section 2.1) */
export type TagStatus = 'ok' | 'stale' | 'unavailable' | 'error' | 'pending';

/**
 * The reason codes for an unavailable reading (the closed enumeration of
 * contract section 2.1.1).
 *
 * No codes may be invented (N3): the specifics are carried by `detail`, and
 * no new code is added for every variant of a path — that table is kept
 * minimal on purpose.
 *
 * `not_found` means "the thing you asked about does not exist" — the action
 * side uses the same code with the same meaning (the `not_found` of
 * contract section 2.4), so that the AI is never given two dialects it
 * would have to translate between (implementation-layer decision record
 * ADR-D27).
 */
export type ReasonCode =
  | 'not_found'
  | 'device_absent'
  | 'service_down'
  | 'link_busy_terminal'
  | 'parse_error'
  | 'out_of_domain'
  | 'timeout';

/** The complete set of reason codes (for validation and tests) */
export const REASON_CODES: readonly ReasonCode[] = [
  'not_found',
  'device_absent',
  'service_down',
  'link_busy_terminal',
  'parse_error',
  'out_of_domain',
  'timeout',
];

/** One tag reading (contract section 2.1.1) */
export interface TagReading {
  tag: string;
  /** With `unavailable` there is no value; with `ok` the value is always present */
  value: number | string | boolean | null;
  unit: string;
  status: TagStatus;
  /** The machine-readable closed enumeration */
  reason?: ReasonCode;
  /** Free text for humans. May contain a hint on how to fix it */
  detail?: string;
  /** The moment this sample finished (milliseconds UTC) */
  at: number;
  /** A monotonically increasing sequence number within the same tag */
  seq: number;
}
