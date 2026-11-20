/**
 * The validation command of the board packs (`npm run validate:profiles`).
 *
 * **This command was referred to 30 times in the documentation, and it did
 * not exist.** Everybody who copied the documentation got
 * `npm ERR! Missing script` — "the contract says it has to be there, the
 * implementation never wrote it" is the easiest kind of debt to overlook.
 *
 * It does two things:
 * 1. **Load** every pack (the structure is checked: an unknown field is an
 *    error);
 * 2. **Validate** every pack (the rules of contract §7).
 *
 * **An error → exit code 1.** The warnings are printed as well, but they do
 * not change the exit code — a warning is a "you better know this" and an
 * error is a "this pack cannot be used".
 *
 * Usage:
 *   npm run validate:profiles
 *   npm run validate:profiles -- profiles/boards/rk3588-atk   # check one pack only
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoardPack } from '../src/main/tags/pack';
import { validatePack, errorsOf, warningsOf } from '../src/main/tags/validator';
import type { ValidationIssue } from '../src/main/tags/validator';

// **`process.cwd()` and not `__dirname`**: this project is `"type": "module"`,
// and there is no `__dirname` in ESM. The other two scripts of the repository
// (gen-vocabulary / check-build) do the same — when npm runs a script the cwd
// is the root of the package.
const REPO = process.cwd();
const BOARDS_DIR = join(REPO, 'profiles/boards');

/** Finds the directories of the packs that have to be validated */
function packDirs(explicit: string[]): string[] {
  if (explicit.length > 0) {
    return explicit.map((p) => (p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : join(REPO, p)));
  }
  if (!existsSync(BOARDS_DIR)) return [];
  return readdirSync(BOARDS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(BOARDS_DIR, e.name))
    .filter((d) => existsSync(join(d, 'board.yaml')))
    .sort();
}

/** How one issue is printed for a human */
function format(issue: ValidationIssue): string {
  return `  rule ${issue.rule} · ${issue.path}\n    ${issue.message}`;
}

function main(): number {
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const dirs = packDirs(explicit);

  if (dirs.length === 0) {
    console.error(`no board pack was found (the scan covered ${BOARDS_DIR})`);
    return 1;
  }

  let errorCount = 0;
  let warningCount = 0;

  for (const dir of dirs) {
    const name = dir.split(/[\\/]/).pop() ?? dir;
    console.log(`=== ${name} ===`);

    let pack;
    try {
      pack = loadBoardPack(dir);
    } catch (err) {
      // A failure to load = the structure is wrong (the unknown field half of the rules 10 / 24)
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ it does not load: ${message}`);
      errorCount += 1;
      continue;
    }

    const issues = validatePack(pack);
    const errs = errorsOf(issues);
    const warns = warningsOf(issues);

    for (const issue of warns) {
      console.log(format(issue));
    }
    for (const issue of errs) {
      console.error(format(issue));
    }

    errorCount += errs.length;
    warningCount += warns.length;

    if (errs.length === 0) {
      console.log(
        `  ✓ ${pack.readers.length} readers, ${pack.custom.length} private readers, ` +
          `${pack.actions.length} actions, ${pack.poll_groups.length} poll groups`,
      );
    }
    console.log('');
  }

  if (errorCount > 0) {
    console.error(`✗ ${dirs.length} packs, ${errorCount} errors, ${warningCount} warnings`);
    return 1;
  }
  console.log(`✅ ${dirs.length} packs, 0 errors, ${warningCount} warnings`);
  return 0;
}

process.exit(main());
