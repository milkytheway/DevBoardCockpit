import type { FileEntry } from '../../shared/ipc-contract';

/**
 * The discovery of the artefacts — by rule, not by a hard-coded file
 * name.
 *
 * ── Why it cannot be hard-coded ──
 *
 * `hello.ko` written into the workflow pack → a different project name
 * means the pack has to be changed ✗; and what "the compiler produced" is
 * the compiler's business, the workflow pack must not decide it ✓.
 * → The pack only says "look for `*.ko`", and whatever is found is what
 *   it is ✓.
 *
 * ── The rules ──
 *
 * | Field | Meaning |
 * |---|---|
 * | `pattern` | what is wanted (matched against the file name: `*.ko` / `meminfo`) |
 * | `exclude` | what is not wanted (the same matching; `*.o` / `*.mod.c`) |
 *
 * → The exclude list has to be there: a build directory is full of
 *   intermediate artefacts (`.o` / `.cmd` / `.order`), and missing one of
 *   them may send an intermediate file as the artefact ✗.
 */

/** The matching of a file name (only the `*` wildcard is supported — enough and unambiguous) */
export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** The entry point of the discovery (it lists a remote directory — the HAL has that capability ✓) */
export interface DiscoverDeps {
  /** List one remote directory */
  list: (dir: string) => Promise<FileEntry[]>;
}

/**
 * Look for the artefacts in one directory, by the rules.
 *
 * @returns the paths that were found (sorted by name — the result has to
 *   be reproducible ✓)
 */
export async function discoverArtifacts(
  deps: DiscoverDeps,
  opts: { dir: string; pattern: string; exclude?: string[] },
): Promise<string[]> {
  const entries = await deps.list(opts.dir);
  const excluded = opts.exclude ?? [];
  const found = entries
    .filter((entry) => !entry.isDirectory)
    .filter((entry) => matchesPattern(entry.name, opts.pattern))
    .filter((entry) => !excluded.some((rule) => matchesPattern(entry.name, rule)))
    .map((entry) => entry.path)
    .sort();
  return found;
}
