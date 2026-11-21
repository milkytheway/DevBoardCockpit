/**
 * **The version of the tag must be the version of the package.**
 *
 * ── The kind of bug it prevents ──
 *
 * → The tag decides the name of the release ✓ and the name of the installer
 *   comes from the package ✓ (`${productName}-${version}-setup.exe` ✓) →
 *   when the two disagree ✓ the release says one version ✓ and the file
 *   carries another ✓ → and nobody notices until a user downloads the wrong
 *   one ✗.
 * → So the criterion runs **before the build** ✓ (a mismatch is cheaper than
 *   a wrong release ✓).
 *
 * Usage: `npm run release:check -- [tag]`
 *   → without a tag it checks that the version looks like a release version
 *     ✓ (`x.y.z` ✓ — a manual run has no tag ✓).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// → **`process.cwd()` and not `__dirname`** ✓ — this project is
//   `"type": "module"` ✓ (the same rule as the other scripts ✓).
const ROOT = process.cwd();

/** The version a tag names ✓ (`v0.1.0` → `0.1.0` ✓) */
export function versionOfTag(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/**
 * Do the tag and the package agree? ✓
 *
 * @returns `null` when they do ✓ · the sentence why when they do not ✓.
 */
export function checkReleaseVersion(
  version: string,
  tag: string | undefined,
): string | null {
  if (tag === undefined || tag.length === 0) {
    // → A manual run ✓ → the version has to look like a release version ✓
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      return `the version "${version}" is not a release version (x.y.z)`;
    }
    return null;
  }
  const wanted = versionOfTag(tag);
  if (wanted !== version) {
    return `the tag "${tag}" names the version ${wanted}, the package says ${version}`;
  }
  return null;
}

/** The version of the package ✓ */
export function packageVersion(root: string = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
  return String(pkg.version ?? '');
}

function main(): void {
  const tag = process.argv[2] ?? process.env['GITHUB_REF_NAME'];
  const version = packageVersion();
  const problem = checkReleaseVersion(version, tag);
  if (problem !== null) {
    console.error(`✗ ${problem}`);
    console.error('  The name of the installer comes from the package — one of them has to change.');
    process.exit(1);
  }
  if (tag !== undefined && tag.length > 0) {
    console.log(`[release] the tag "${tag}" and the package agree ✓ (${version})`);
  } else {
    console.log(`[release] the version ${version} is a release version ✓`);
  }
}

// → Only when it is run as a program ✓ (the test imports it ✓).
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-release-version.ts')) {
  main();
}
