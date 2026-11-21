/**
 * The self-check of the build artefacts.
 *
 * **The kind of bug it prevents**: a preload path is hardcoded in the main
 * process, while the build produces a different file name — **once the
 * application runs, `window.cockpit` is undefined and not a single API is
 * there**, and the error is completely invisible during development: the build
 * succeeds, the type check passes, the tests are all green, and it only shows
 * when the window is really opened.
 *
 * This project has stepped on that once: the main process pointed at
 * `../preload/index.js`, while electron-vite produced `index.mjs` because
 * `package.json` is `"type": "module"`.
 *
 * So: **after every build the file that the main process expects has to be
 * checked once.** The check is bound to `npm run build`, so it cannot be
 * skipped.
 *
 * Usage: npm run build (the build script calls it at the end)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRELOAD_FILE } from '../src/shared/build-layout';
import { FAKE_DEVICE_MARKER } from '../src/main/hal/fake/device';

interface Check {
  what: string;
  ok: boolean;
  detail: string;
}

/**
 * Finds every file that **holds a marker** (relative paths).
 *
 * A directory that does not exist → an empty array (not an error: a build
 * that produced nothing is the business of another check).
 */
function findFilesWithMarker(dir: string, marker: string): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      if (statSync(full).isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (!/\.(js|cjs|mjs)$/.test(entry)) continue;
      if (readFileSync(full, 'utf8').includes(marker)) hits.push(relative);
    }
  };
  walk(dir, '');
  return hits;
}

function main(): void {
  const root = process.cwd();
  const outDir = join(root, 'out');
  const checks: Check[] = [];

  // ── Are the three parts of the artefact there ───────────────────
  for (const seg of ['main', 'preload', 'renderer']) {
    const dir = join(outDir, seg);
    checks.push({
      what: `out/${seg} exists`,
      ok: existsSync(dir),
      detail: dir,
    });
  }

  // ── The file name of the preload ───────────────────────────────
  const preloadDir = join(outDir, 'preload');
  const produced = existsSync(preloadDir)
    ? readdirSync(preloadDir).filter((f) => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.mjs'))
    : [];
  const preloadPath = join(preloadDir, PRELOAD_FILE);

  checks.push({
    what: `the preload artefact is ${PRELOAD_FILE} (that is what the main process expects)`,
    ok: existsSync(preloadPath),
    detail: produced.length
      ? `the build produced: ${produced.join(', ')}`
      : 'out/preload holds no artefact at all',
  });

  // ── The preload directory holds **only** that one artefact ─────────
  // With this step a "stale artefact fools the self-check" is impossible:
  // the index.mjs of the previous build turns this one red.
  const strays = produced.filter((f) => f !== PRELOAD_FILE);
  checks.push({
    what: `the preload directory holds only ${PRELOAD_FILE} (no stale artefact)`,
    ok: strays.length === 0,
    detail: strays.length === 0 ? 'clean' : `mixed in: ${strays.join(', ')}`,
  });

  // ── The main artefact really refers to it ───────────────────────
  const mainBundle = join(outDir, 'main', 'index.js');
  if (existsSync(mainBundle)) {
    const src = readFileSync(mainBundle, 'utf8');
    checks.push({
      what: 'the preload file name the main artefact refers to is right',
      ok: src.includes(PRELOAD_FILE),
      detail: src.includes(PRELOAD_FILE)
        ? `it refers to ${PRELOAD_FILE}`
        : `the main artefact does not hold ${PRELOAD_FILE} — the code and the build do not match`,
    });
  } else {
    checks.push({
      what: 'the preload file name the main artefact refers to is right',
      ok: false,
      detail: 'out/main/index.js does not exist',
    });
  }

  // ── Is the preload artefact really CommonJS ────────────────────────
  // The `.cjs` suffix only guarantees "Node interprets it as CJS";
  // but if the build produced ESM syntax (`import`), Electron cannot load it
  // either. So the content is looked at: there may be no top level `import`.
  if (existsSync(preloadPath)) {
    const preloadSrc = readFileSync(preloadPath, 'utf8');
    const looksEsm = /^\s*import\s[\s{*'"]/m.test(preloadSrc);
    checks.push({
      what: 'the preload artefact is CommonJS (a sandbox preload cannot run ESM)',
      ok: !looksEsm,
      detail: looksEsm
        ? 'the artefact holds a top level import — that is ESM, a sandbox preload cannot load it'
        : 'there is no top level import, it is CommonJS',
    });
  }

  // ── Is the entry HTML of the renderer there (loadFile points at it) ──
  const rendererHtml = join(outDir, 'renderer', 'index.html');
  checks.push({
    what: 'the entry HTML of the renderer exists',
    ok: existsSync(rendererHtml),
    detail: rendererHtml,
  });

  // ── The fake device **ships** with the application ───────────────────
  //
  // **The user decided it on 2026-11-21** ✓ (the fake board is useful
  // without the hardware ✓) → the judgement of the release preparation
  // ("synthetic data may not enter the production package") is **overturned**
  // ✓.
  //
  // → The **interface says so** ✓ (the terminal banner ✓ · the board name ✓)
  //   and **the real boards come first** ✓ (`hal/fake/wiring.ts` ✓).
  // → So the marker **has** to be there ✓ — that is what is checked here ✓
  //   (a build that quietly lost the fake device would be a different
  //   application than the one that was reviewed ✓).
  const fakeHits = findFilesWithMarker(outDir, FAKE_DEVICE_MARKER);
  checks.push({
    what: 'the fake device ships with the application (the user decided it on 2026-11-21 ✓ — the interface labels it as synthetic data ✓)',
    ok: fakeHits.length > 0,
    detail:
      fakeHits.length > 0
        ? `the marker "${FAKE_DEVICE_MARKER}" is in: ${fakeHits.slice(0, 5).join(', ')}`
        : `the marker "${FAKE_DEVICE_MARKER}" was not found — the fake device did not make it into the build`,
  });

  // ── The summary ─────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error('✗ the build artefact self-check failed:');
    for (const c of failed) console.error(`  - ${c.what}\n      ${c.detail}`);
    console.error('\n  Two common causes:');
    console.error('  ① the preload path that is hardcoded in the main process does not match the file name the build produces');
    console.error('     — this kind of error is invisible during development: once the window is open `window.cockpit` is undefined and the application has no API at all.');
    console.error('  ② something for debugging (the fake device) got into the production package');
    console.error('     — synthetic data in the production package makes the user take the false readings for real ones.');
    process.exit(1);
  }

  console.log(`✓ the build artefact self-check passed (preload = ${PRELOAD_FILE}, a sandbox preload has to be CommonJS)`);
}

main();
