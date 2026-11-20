/**
 * The generator of the theme tokens.
 *
 * `src/shared/theme/seed.ts` is the **only authority** of the theme (the
 * values that were picked by hand). This script generates from it:
 *
 *   1. `src/renderer/theme/tokens.generated.css` (the CSS variables of the
 *      application shell)
 *
 * **Why it exists**: if `tokens.css` were edited by hand there would be
 * **two sources of truth** (one in the seed, one in the CSS) — a change of
 * the skin changes the seed, the CSS does not follow, and then "the same
 * token is two different colours in two places".
 * With this script `--check` can answer one concrete question:
 * "**is the generated CSS still the same as the seed?**"
 *
 * Usage:
 *   npx tsx scripts/gen-theme.ts          # generate
 *   npx tsx scripts/gen-theme.ts --check  # only check, exit code 1 when it differs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { allThemesCss } from '../src/shared/theme/map';

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'src', 'renderer', 'theme', 'tokens.generated.css');

function main(): void {
  const check = process.argv.includes('--check');
  const expected = allThemesCss();

  if (check) {
    if (!existsSync(OUT)) {
      console.error(`✗ the generated artefact was not found: ${OUT}`);
      console.error('  Run npm run gen:theme to generate it.');
      process.exit(1);
    }
    const actual = readFileSync(OUT, 'utf8');
    if (actual !== expected) {
      console.error('✗ the theme CSS and the seed differ:');
      console.error(`  ${OUT} and src/shared/theme/seed.ts do not match`);
      console.error('  Run npm run gen:theme to generate it again.');
      process.exit(1);
    }
    console.log('✓ the theme CSS and the seed are the same');
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, expected, 'utf8');
  console.log(`generated: ${OUT}`);
}

// The CLI only runs when it is run directly; when it is imported it only exports the functions
if (process.argv[1] && process.argv[1].endsWith('gen-theme.ts')) {
  main();
}
