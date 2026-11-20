import { quotePath } from '../../util/shell-quote';
import { argStr } from './util';
import { error, isBlank, missing, ok } from './parse-util';
import type { ReaderKind } from './types';

/**
 * `script` — the escape hatch (contract section 3.3).
 *
 * The script must print JSON; the keys are the sample names it provides.
 * It is therefore the only kind whose sample names are not a fixed list.
 *
 * The script runs on the board. It lives in the pack directory on the host,
 * but it has to read board state, so the runtime has to push it onto the
 * board first (into a session directory under `/tmp`); every later poll only
 * runs it by path.
 *
 * → The fetch therefore uses the remote path (the `remote_path` the runtime
 *   supplies), not the host path written in the pack.
 *
 * ⚠️ It runs arbitrary code on the board. The validator raises a warning for
 * it (rule 19) and its execution is written to the audit log (last paragraph
 * of section 3.3).
 */

export const SCRIPT: ReaderKind = {
  id: 'script',
  params: {
    /** The path on the host (as declared by the pack) */
    path: { type: 'string', required: true },
    interpreter: { type: 'string', required: true },
    format: { type: 'string', required: false, values: ['json'] },
  },
  samples: ['value'],
  unboundedSamples: true,
  // The fetch uses the remote path the runtime pushed onto the board (contract section 3.3)
  needsRemotePath: true,
  fetch(args) {
    // The remote path (after the push) wins; without it, fall back to the host
    // path — falling back is still better than doing nothing, because during
    // real-device acceptance it at least shows that the script was not pushed.
    const remote = argStr(args, 'remote_path');
    const target = remote.length > 0 ? remote : argStr(args, 'path');
    return `${quotePath(argStr(args, 'interpreter'))} ${quotePath(target)}`;
  },
  parse(raw, _args, _ctx) {
    if (isBlank(raw)) {
      return missing('the script produced no output (was it not pushed? did it fail?)');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return error('parse_error', 'the script output is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return error('parse_error', 'the script output is not a JSON object');
    }

    const samples: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Only scalar values count — a nested object or array is not a sample
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        samples[key] = value;
      }
    }
    if (Object.keys(samples).length === 0) {
      return error('parse_error', 'the script output has no usable sample at all');
    }
    return ok(samples);
  },
};
