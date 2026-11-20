/**
 * Small helpers shared by the kinds.
 *
 * Why argument access has to stay gentle: a pack's arguments are data, not
 * code. A missing one is treated as an empty string — a genuinely missing
 * required argument is reported by the validator (rule 9), and the fetching
 * fragment must not throw, because that would turn "the pack is wrong" into
 * "the fetch crashed". The two have to stay apart.
 */

/** Read a string argument */
export function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** Read a map argument (`type_map`) */
export function argMap(args: Record<string, unknown>, key: string): Record<string, string> {
  const v = args[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
    if (typeof item === 'string') out[k] = item;
  }
  return out;
}
