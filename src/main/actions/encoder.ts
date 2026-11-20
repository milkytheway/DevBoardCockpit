import { makeError } from '../../shared/errors';
import { quoteShellValue, PLACEHOLDER } from '../util/shell-quote';
import type { PackParam } from '../tags/schema';

/**
 * Parameter encoding — contract `docs/spec/02-board-pack.md` §4.6, the
 * "injection barrier".
 *
 * ── Why this belongs to the runtime ──
 *
 * A board-side session runs as root (measured around facts A1/S1 in
 * `docs/02-device-facts.md`). A single `--model 'x; reboot'` turns "start the pipeline" into
 * "reboot the board" — and `reboot` is not in the command template, so
 * matching the template against the danger floor cannot stop it at all
 * (§5.3 says exactly this).
 *
 * → Parameter values are encoded by type before they are injected; the pack
 *   only declares types and ranges and is not responsible for escaping (ten
 *   pack authors would write ten escaping schemes, nine of them wrong).
 *
 * ── The runtime validates once more (§4.6 rule 4) ──
 *
 * It trusts neither the pack's own description nor the caller's: a value
 * declared as `integer` that arrives as `'30'` is not let through.
 */

/** The result of encoding */
export interface EncodedParams {
  /** The encoded command (directly executable) */
  command: string;
  /** The encoded fragment of each parameter — the audit has to record the parameters (`spec/02` §5.4) */
  encoded: Record<string, string>;
}

/** The parameter is invalid */
function invalid(param: string, message: string): Error {
  return makeError('IPC_INVALID_PAYLOAD', `parameter "${param}" ${message}`, {
    detail: { param },
  });
}

/** The value falls outside min/max → reject it */
function checkRange(param: string, value: number, spec: PackParam): void {
  if (spec.min !== undefined && value < spec.min) {
    throw invalid(param, `is out of range (minimum ${spec.min})`);
  }
  if (spec.max !== undefined && value > spec.max) {
    throw invalid(param, `is out of range (maximum ${spec.max})`);
  }
}

/**
 * Encode one parameter value by type.
 *
 * | type | Encoding |
 * |---|---|
 * | `integer` / `number` | A decimal literal, with no quotes and no other characters |
 * | `boolean` | `true` / `false` |
 * | `enum` | Must be one of the `values`, injected as is |
 * | `string` | Wrapped in single quotes, `'` escaped as `'\''`, length not over `maxLength` |
 */
function encodeValue(param: string, spec: PackParam, raw: unknown): string {
  switch (spec.type) {
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw invalid(param, 'must be an integer');
      }
      checkRange(param, raw, spec);
      return String(raw);
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw invalid(param, 'must be a number');
      }
      checkRange(param, raw, spec);
      return String(raw);
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        throw invalid(param, 'must be a boolean');
      }
      return raw ? 'true' : 'false';
    }
    case 'enum': {
      if (typeof raw !== 'string') {
        throw invalid(param, 'must be a string');
      }
      const values = spec.values ?? [];
      if (!values.includes(raw)) {
        throw invalid(param, `must be one of these values: ${values.join(' / ')}`);
      }
      return raw;
    }
    case 'string': {
      if (typeof raw !== 'string') {
        throw invalid(param, 'must be a string');
      }
      if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
        throw invalid(param, `is longer than maxLength (at most ${spec.maxLength} characters)`);
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(raw)) {
        throw invalid(param, `does not match pattern (${spec.pattern})`);
      }
      return quoteShellValue(raw, 'parameter value');
    }
  }
}

/**
 * Encode the parameters by type.
 *
 * @param schema The parameters declared in the pack (type + range).
 * @param values The values given by the caller.
 * @returns The encoded fragment of each parameter.
 * @throws The parameter is invalid (`IPC_INVALID_PAYLOAD`) — it is rejected
 *   before the execution.
 */
export function encodeParams(
  schema: Record<string, PackParam>,
  values: Record<string, unknown>,
): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const has = Object.prototype.hasOwnProperty.call(values, name);
    const raw = has ? values[name] : spec.default;
    if (raw === undefined) {
      throw invalid(name, 'is missing (and there is no default)');
    }
    encoded[name] = encodeValue(name, spec, raw);
  }
  // An extra parameter → reject it: the caller slipped in a parameter that
  // was never declared, which means it believes that parameter exists (a
  // typo? or deliberately smuggling one in?) — neither should be let through.
  for (const name of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(schema, name)) {
      throw invalid(name, 'is not declared');
    }
  }
  return encoded;
}

/**
 * Replace `{param}` in the command template with the encoded fragment.
 *
 * The quotes are part of the encoding — the fragment goes in as is (`{model}`
 * → `'x'`).
 *
 * @throws The template contains an undeclared placeholder
 *   (`IPC_INVALID_PAYLOAD`).
 */
export function renderCommand(template: string, encoded: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = encoded[name];
    if (value === undefined) {
      throw makeError('IPC_INVALID_PAYLOAD', `the placeholder "{${name}}" in the command template is not declared`, {
        detail: { param: name },
      });
    }
    return value;
  });
}

/**
 * One shot: validate → encode → render.
 *
 * @returns The command plus the encoded fragment of each parameter (the
 *   audit has to record the parameters).
 */
export function buildCommand(
  template: string,
  schema: Record<string, PackParam>,
  values: Record<string, unknown>,
): EncodedParams {
  const encoded = encodeParams(schema, values);
  return { command: renderCommand(template, encoded), encoded };
}
