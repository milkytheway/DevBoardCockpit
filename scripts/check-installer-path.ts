/**
 * **The path of the working tree has to be plain ASCII** — for the installer.
 *
 * ── The kind of bug it prevents ──
 *
 * → The NSIS installer **writes its temporary files through the path of the
 *   working tree** ✓ → under a path with Chinese characters ✓ (or a
 *   full-width comma ✓) it fails with
 *   *"Error writing temporary file. Make sure your temp folder is valid."* ✓
 *   → **the message points at the wrong thing** ✓ (the temp folder is fine ✓
 *   · the disk is fine ✓ — measured 2026-11-22 ✓) → and **the failure comes
 *   after** the artefact was written ✓ → a **stub of 188 KB** is left behind ✓
 *   instead of the 84 MB installer ✓ → **and it looks like the build
 *   succeeded** ✓ (the file is there ✓ · it is just 200 times too small ✓).
 *
 * → The **same tree** ✓ (same node_modules ✓ · same source ✓) built from
 *   `C:\cbc-ascii-test` ✓ writes the whole installer ✓ (84.0 MB ✓ · measured
 *   2026-11-22 ✓) → **the path is the cause** ✓ ✓.
 *
 * → The **published release is not affected** ✓: the release workflow builds
 *   on a runner whose path is plain ASCII ✓ (`D:\a\DevBoardCockpit\...` ✓).
 *
 * → So this check **does not stop the build** ✓ (the application itself is
 *   perfectly happy with a Chinese path ✓ — it reads the profiles ✓ and the
 *   cards ✓) → it **says what is going to happen** ✓ so that the person does
 *   not spend an hour on the wrong suspicion ✓.
 */
import { resolve } from 'node:path';

/** The characters that break the NSIS installer ✓ (measured ✓) */
const NON_ASCII = /[^\x20-\x7E]/;

export interface PathReport {
  /** The path the tree lives in ✓ */
  path: string;
  /** Does it hold a character that is not plain ASCII ✓ */
  plainAscii: boolean;
  /** The characters that are in the way ✓ (empty when the path is plain ✓) */
  offenders: string[];
}

/**
 * What is in the path that the installer will not survive ✓.
 *
 * → The **whole path** ✓ (not only the last segment ✓) — the installer
 *   writes its temporary files under the tree ✓.
 */
export function reportPath(cwd: string = resolve('.')): PathReport {
  const offenders = new Set<string>();
  for (const ch of cwd) {
    if (NON_ASCII.test(ch)) offenders.add(ch);
  }
  return { path: cwd, plainAscii: offenders.size === 0, offenders: [...offenders] };
}

/**
 * The sentence for the person ✓ (empty when there is nothing to say ✓).
 */
export function pathWarning(report: PathReport): string {
  if (report.plainAscii) return '';
  const shown = report.offenders.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' · ');
  return [
    `the path of the working tree is not plain ASCII: ${report.path}`,
    `the characters in the way: ${shown}`,
    'the NSIS installer writes its temporary files through this path and will fail with',
    '"Error writing temporary file. Make sure your temp folder is valid."',
    'the application itself is fine — only the installer needs a plain path.',
    'build from a path made of ASCII letters only (for example C:\\work\\DevBoardCockpit) to get the installer.',
    'the published release is not affected: the release workflow builds on a runner with a plain path.',
  ].join('\n');
}

function main(): void {
  const report = reportPath();
  const warning = pathWarning(report);
  if (warning.length > 0) {
    console.warn('⚠ the installer will not be written here:');
    console.warn(warning);
  }
}

// → Only when it is run as a program ✓ (the test imports it ✓).
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-installer-path.ts')) {
  main();
}
