import type { ReasonCode } from '../../../shared/tag-reading';

/**
 * Parsing helpers shared by the kinds.
 *
 * Why these helpers exist: the parsers of the 8 kinds all have to deal with
 * the same boundary cases (empty input, wrong format, a counter that went
 * backwards) — written once per kind, 8 copies would certainly end up with
 * 7 different answers.
 */

/**
 * The resource is not there right now (the path does not exist, the device
 * was unplugged, the mount is gone) — contract section 2.1.1.
 *
 * The boundary against `error()`: "the resource is not there" versus "the
 * resource is there but cannot be read". The boundary reaches the card
 * directly: `unavailable` should send the user to mount debugfs, not report
 * "reading the NPU failed".
 */
export function unavailable(reason: ReasonCode, detail: string): ParseResult {
  return { status: 'unavailable', reason, detail };
}

/**
 * It was read, but what came back is broken (parse failure, out of domain,
 * wrong type) — contract section 2.1.1.
 *
 * The contract names it: an out-of-domain value is an `error` and may not be
 * clamped into the legal range and passed off as `ok` (that would be lying).
 */
export function error(
  reason: Extract<ReasonCode, 'parse_error' | 'out_of_domain'>,
  detail: string,
): ParseResult {
  return { status: 'error', reason, detail };
}

/**
 * The output is empty → the resource is not there.
 *
 * The fetch fragment is `cat -- <path>`: when the file does not exist stdout
 * has not a single character (the error goes to stderr, which `2>/dev/null`
 * swallows). In practice "empty" means "the path does not exist".
 */
export function missing(detail: string): ParseResult {
  return { status: 'unavailable', reason: 'device_absent', detail };
}

/** Whether the output is empty */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** The parse succeeded */
export function ok(samples: Record<string, number | string | boolean>): ParseResult {
  return { status: 'ok', samples };
}

/**
 * Take the leading run of integers and stop at the first non-digit.
 *
 * The approach of the predecessor project (`leading_ints` in
 * `core/metrics.py`): on some kernels `/proc/stat` mixes counters and named
 * fields, and a blind `int()` over the whole tail blows up.
 */
export function leadingInts(tokens: string[]): number[] {
  const out: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) break;
    out.push(Number(token));
  }
  return out;
}

/**
 * Whether a percentage is out of domain (not clamped into the range).
 *
 * The contract, section 2.1.1: "an implementation that meets an
 * out-of-domain value must report `error`; it must not clamp it into the
 * legal range and pass it off as `ok` (that would be lying), and it must not
 * treat it as `0` (that would be an even worse lie)."
 */
export function outOfRange(value: number): boolean {
  return !Number.isFinite(value) || value < 0 || value > 100;
}

/** The shape of a parse result (it lives here because the kinds and the helpers refer to each other) */
export type ParseResult =
  | { status: 'ok'; samples: Record<string, number | string | boolean> }
  | { status: 'pending' }
  | { status: 'unavailable'; reason: ReasonCode; detail: string }
  | { status: 'error'; reason: ReasonCode; detail: string };
