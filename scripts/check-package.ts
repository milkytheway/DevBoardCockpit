/**
 * **The self-check of the packaged artefact** (`npm run check:package`).
 *
 * ── The kind of bug it prevents ──
 *
 * After the packaging `app.getAppPath()` = **the root of the asar** (not the
 * source directory).
 * → `cards/` (the built-in cards), `profiles/` (the connection profiles, the
 * board packs, the workflow packs) **have to be carried into the asar by the
 * `files` of electron-builder**, otherwise the installed application **has
 * not one single built-in card** — and that is completely invisible during
 * development: `npm run build` is green, the tests are all green, **it only
 * breaks once it is installed**.
 *
 * → So "is the packaging configuration right" **has to be a criterion that
 * runs**, not a paragraph of comments.
 *
 * ── Why it reads the header of the asar itself ──
 *
 * → The header of an asar is a piece of JSON (the file list) → reading it
 *   needs no extra dependency (`@electron/asar` has to be installed first —
 *   and this script has to run **before the install**).
 *
 * Usage: `npm run check:package` (after `npm run dist`)
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
 * **Do the built-in cards in the asar and `cards/` match** (a **pure
 * function** — easy to test).
 *
 * → The criterion = **the two sides are identical** (**not "at least one"** —
 *   "≥1" **does not catch a stale asar**: ten cards today, six in the old
 *   asar → it still reports "there are cards" ✗).
 * → **What is compared is the set** — the order does not matter.
 * → **An empty expectation → it fails** ("not one card in `cards/`" is wrong
 *   in itself).
 */
export function compareCards(
  expected: string[],
  inAsar: string[],
): { ok: boolean; missing: string[]; extra: string[] } {
  const missing = expected.filter((c) => !inAsar.includes(c));
  const extra = inAsar.filter((c) => !expected.includes(c));
  return { ok: expected.length > 0 && missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * **Is the code in the package the one on the disk** (a **pure function** —
 * easy to test).
 *
 * ── Why this one exists (**it was hammered out by a real event**) ──
 *
 * → **2026-11-19**: the operator installed the build → I looked at it
 *   → **the package was running the code from before the fix** ⚠️
 *   (the installer at **00:55**, the fix was only committed at **21:38** →
 *   **the package was 21 hours older than the fix** ⚠️).
 * → **The consequence**: in the installed build every card that can write to
 *   the board **permanently showed "degraded"** ⚠️
 *   → while **everything was green during the development and in the
 *   sandbox** → **it is only visible once it is installed**.
 * → **`check:package` could not see that** ⚠️ → it verified "are the cards
 *   there" → **it could not verify "is the code the newest one"** ⚠️
 *   → **so it was the one that got through** ⚠️.
 *
 * ── How the criterion is defined ──
 *
 * → **Equal byte by byte** — the timestamps are not compared (**the
 *   timestamps are changed by `cp`** → unreliable).
 * → **One side missing → it fails** — **"it is skipped when it is missing" is
 *   not allowed** (that would void the criterion).
 */
export function compareBundle(
  inAsar: Buffer | undefined,
  onDisk: Buffer | undefined,
): { ok: boolean; detail: string } {
  if (inAsar === undefined) {
    return { ok: false, detail: 'the asar holds no out/main/index.js — the package carries no main artefact' };
  }
  if (onDisk === undefined) {
    return {
      ok: false,
      detail: 'there is no out/main/index.js on the disk — run `npm run build` once and check again',
    };
  }
  if (!inAsar.equals(onDisk)) {
    return {
      ok: false,
      detail:
        `**the package is stale** (${inAsar.length} bytes in the asar · ${onDisk.length} bytes on the disk) ` +
        '→ **build it again** (`npm run dist`) → **otherwise the installed build runs the old code**',
    };
  }
  return { ok: true, detail: `identical (${inAsar.length} bytes)` };
}

/** The header of the asar: the file list (path → {size, offset, ...}) */
interface AsarHeader {
  files: Record<string, { size: number; offset: string; files?: Record<string, unknown> }>;
}

/**
 * Reads the header of the asar.
 *
 * ── The layout of an asar (the header) ──
 *
 * ```
 * 0  : UInt32 = 4              (the length of the payload of the pickle)
 * 4  : UInt32 = the length of the header pickle (the content of the files
 *              starts at 8 + it)
 * 8  : UInt32 = the length of the payload
 * 12 : UInt32 = the length of the JSON string in bytes
 * 16 : the JSON string
 * ```
 */
function readAsarHeader(asarPath: string): AsarHeader {
  const buf = readFileSync(asarPath);
  const headerPickleSize = buf.readUInt32LE(4);
  const headerStringSize = buf.readUInt32LE(12);
  const json = buf.subarray(16, 16 + headerStringSize).toString('utf8');
  if (headerPickleSize <= 0) throw new Error(`the length of the asar header is wrong: ${headerPickleSize}`);
  return JSON.parse(json) as AsarHeader;
}

/** Flattens the nested list of the asar header into a list of paths */
function flatten(header: AsarHeader, prefix = ''): string[] {
  const out: string[] = [];
  for (const [name, entry] of Object.entries(header.files)) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    out.push(path);
    if (entry.files !== undefined) {
      out.push(...flatten({ files: entry.files } as AsarHeader, path));
    }
  }
  return out;
}

/** Takes the bytes of one file out of the asar (by the offset in the header) */
function readAsarFile(asarPath: string, header: AsarHeader, filePath: string): Buffer | undefined {
  const parts = filePath.split('/');
  let entry = header.files[parts[0] as string];
  for (const part of parts.slice(1)) {
    if (entry?.files === undefined) return undefined;
    entry = entry.files[part] as { size: number; offset: string };
  }
  if (entry === undefined || typeof entry.offset !== 'string') return undefined;
  // **Only the bytes after the header are the content of the files** (the start of the content = 8 + the length of the header pickle)
  const buf = readFileSync(asarPath);
  const contentBase = 8 + buf.readUInt32LE(4);
  const start = contentBase + Number(entry.offset);
  return buf.subarray(start, start + entry.size);
}

function main(): void {
  const root = process.cwd();
  const releaseDir = join(root, 'release');
  const checks: Check[] = [];

  // ── Is the artefact there ───────────────────────────────────────
  // **The directory name carries the platform** (`win-unpacked` /
  // `linux-unpacked` / `mac-arm64-unpacked`)
  // → find the **first** `*-unpacked` (the check works on every platform)
  const unpackedDirs = existsSync(releaseDir)
    ? readdirSync(releaseDir)
        .filter((d) => d.endsWith('-unpacked'))
        .map((d) => join(releaseDir, d))
    : [];

  // **Which one is checked** — **it has to be the one of this build**
  // (fixed on 2026-11-19).
  //
  // → It used to take `unpackedDirs[0]` ✗ — that is **the order of
  //   `readdirSync`** ✗ (alphabetical → **`linux-unpacked` comes before
  //   `win-unpacked`**)
  // → So **when it packaged on Windows it checked the old package that a
  //   previous run had left in the Linux sandbox** ✗
  //   → six cards in the old package, ten today → it reported "**four are
  //   missing**" ✗
  //   → while **all ten are in the Windows package of this run** → **the
  //   self-check judged the right one wrong** ✗
  //   → **the user is sent in the wrong direction** ✗ (off to look at the
  //   `files` configuration — and it is fine)
  //
  // → **The one of the current platform comes first** → otherwise the **most
  //   recently modified** one (that is the one that was built last)
  const platformTag =
    process.platform === 'win32'
      ? 'win-'
      : process.platform === 'darwin'
        ? 'mac-'
        : 'linux-';
  const samePlatform = unpackedDirs.filter((d) => d.includes(platformTag));
  const unpackedDir =
    samePlatform[0] ??
    unpackedDirs
      .slice()
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ??
    join(releaseDir, 'win-unpacked');
  const asarPath = join(unpackedDir, 'resources', 'app.asar');
  const hasUnpacked = existsSync(unpackedDir);
  const hasAsar = existsSync(asarPath);
  checks.push({
    what: 'the packaged artefact exists (release/*-unpacked)',
    ok: hasUnpacked,
    detail: hasUnpacked ? unpackedDir : 'electron-builder has not run yet',
  });
  checks.push({
    what: 'app.asar exists',
    ok: hasAsar,
    detail: hasAsar ? asarPath : 'app.asar was not found',
  });

  if (!hasAsar) {
    console.error('✗ the self-check of the packaged artefact failed:');
    for (const c of checks.filter((c) => !c.ok)) console.error(`  - ${c.what}\n      ${c.detail}`);
    console.error('\n  Run `npm run dist:dir` first (no installer, it only produces the directory), then run this check.');
    process.exit(1);
  }

  const header = readAsarHeader(asarPath);
  const paths = flatten(header);

  // ── Are the three parts of the artefact in the asar ────────────
  for (const needed of ['out/main/index.js', `out/preload/${PRELOAD_FILE}`, 'out/renderer/index.html']) {
    checks.push({
      what: `the asar holds ${needed}`,
      ok: paths.includes(needed),
      detail: paths.includes(needed) ? 'it is there' : 'it is not there — is `files` short of it?',
    });
  }

  // ── Are the **built-in cards** there (the most common one after the
  //    packaging) ───────────────────────────────────────────────────
  //
  // → **The criterion is "the cards in the asar are exactly the cards of
  //   `cards/`"**, **not "at least one"**
  //   — "≥1" **does not catch a stale asar** (ten cards today, six in the
  //   old asar → it still reports "there are cards" ✗).
  // → **The expectation comes from the source directory** — **no hard coded
  //   number** (a hard coded one rots as the cards come and go).
  const cardManifests = paths.filter((p) => /^cards\/[^/]+\/manifest\.json$/.test(p));
  const inAsar = cardManifests.map((p) => p.split('/')[1]).sort();
  const sourceCardsDir = join(root, 'cards');
  const expectedCards = existsSync(sourceCardsDir)
    ? readdirSync(sourceCardsDir)
        .filter((d) => statSync(join(sourceCardsDir, d)).isDirectory())
        .filter((d) => existsSync(join(sourceCardsDir, d, 'manifest.json')))
        .sort()
    : [];
  const { ok: cardsOk, missing, extra } = compareCards(expectedCards, inAsar);
  checks.push({
    what: `the built-in cards in the asar are the cards of cards/ (${expectedCards.length})`,
    ok: cardsOk,
    detail:
      expectedCards.length === 0
        ? 'there is not one card in the cards/ directory — that is wrong'
        : missing.length > 0 || extra.length > 0
          ? `they do not match — **${missing.length} are missing** (${missing.join(', ') || 'none'})` +
            ` · **${extra.length} are too many** (${extra.join(', ') || 'none'})` +
            ` → **is the asar stale? Build it again**`
          : `all ${inAsar.length} are right: ${inAsar.join(', ')}`,
  });

  // ── Is the **data that ships with the application** there ─────────
  for (const needed of [
    'profiles/settings.json',
    // **The file name of a board pack is `board.yaml`** (not manifest.json —
    // that one belongs to the cards)
    'profiles/boards/rk3588-atk/board.yaml',
  ]) {
    const present = paths.includes(needed);
    checks.push({
      what: `the asar holds ${needed}`,
      ok: present,
      detail: present ? 'it is there' : 'it is not there — `files` is short of `profiles/**/*`',
    });
  }
  checks.push({
    what: 'the asar holds the connection profiles (profiles/targets/*)',
    ok: paths.some((p) => p.startsWith('profiles/targets/')),
    detail: paths.filter((p) => p.startsWith('profiles/targets/')).slice(0, 5).join(', ') || 'none',
  });
  checks.push({
    what: 'the asar holds the workflow packs (profiles/workflows/*)',
    ok: paths.some((p) => p.startsWith('profiles/workflows/')),
    detail: paths.filter((p) => p.startsWith('profiles/workflows/')).slice(0, 5).join(', ') || 'none',
  });

  // ── No fake device in the production package (**synthetic data may not
  //    enter the production package**) ───────────────────────────────
  const mainBundle = readAsarFile(asarPath, header, 'out/main/index.js');
  // ── **Is the code in the package the one on the disk** (added on
  //    2026-11-19) ─────────────────────────────────────────────────
  //
  // → **It prevents "the package is older than the fix"** (the real event of
  //   2026-11-19): only after the install did it turn out that **the package
  //   was running the code from before the fix** ⚠️ → while **everything was
  //   green during the development**.
  // → **`npm run dist` runs `electron-vite build` first** → **`out/` is the
  //   fresh build** → **the two differ = the package is stale**.
  const diskBundlePath = join(root, 'out', 'main', 'index.js');
  const diskBundle = existsSync(diskBundlePath)
    ? readFileSync(diskBundlePath)
    : undefined;
  const bundleCmp = compareBundle(mainBundle, diskBundle);
  checks.push({
    what: '**the code in the package is the newest one** (the out/main/index.js of the asar is the one on the disk)',
    ok: bundleCmp.ok,
    detail: bundleCmp.ok
      ? bundleCmp.detail
      : `${bundleCmp.detail} — **this one catches "the old code was installed"**`,
  });
  const fakeInPackage = mainBundle?.toString('utf8').includes(FAKE_DEVICE_MARKER) ?? false;
  checks.push({
    what: 'there is no fake device in the production package',
    ok: !fakeInPackage,
    detail: fakeInPackage ? 'the fake device got into the package — the user takes the false readings for real ones' : 'there is none',
  });

  // ── Were the native modules **unpacked** (unpacked = the runtime does not
  //    find the .node files) ────────────────────────────────────────
  const unpackedNative = join(unpackedDir, 'resources', 'app.asar.unpacked', 'node_modules');
  let nativeFound: string[] = [];
  if (existsSync(unpackedNative)) {
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full, `${prefix}${entry}/`);
          continue;
        }
        if (entry.endsWith('.node')) nativeFound.push(`${prefix}${entry}`);
      }
    };
    walk(unpackedNative, '');
  }
  checks.push({
    what: 'the native modules are unpacked (the .node files are in app.asar.unpacked)',
    ok: nativeFound.length > 0,
    detail:
      nativeFound.length > 0
        ? nativeFound.slice(0, 5).join(', ')
        : 'no .node was found — node-pty / serialport may not load after the packaging',
  });

  // ── The summary ────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error('✗ the self-check of the packaged artefact failed:');
    for (const c of failed) console.error(`  - ${c.what}\n      ${c.detail}`);
    console.error('\n  Three common causes:');
    console.error('  ① `files` is short of `cards/**/*` or `profiles/**/*`');
    console.error('     — after the packaging `app.getAppPath()` is the root of the asar, so a missing one means "not one card after the install".');
    console.error('  ② the fake device got into the production build (synthetic data may not enter the production package)');
    console.error('  ③ **the package is older than the source** — the code was fixed but not rebuilt → **run `npm run dist` once more**');
    console.error('     (**the real machine of 2026-11-19 hit this**: only after the install did it turn out that the package was running the code from before the fix ⚠️)');
    process.exit(1);
  }

  console.log(
    `✓ the self-check of the packaged artefact passed (${cardManifests.length} built-in cards · the native modules are unpacked · no fake device · the code in the package is the newest one)`,
  );
}

// The CLI only runs when it is run directly; when it is imported it only exports the functions (the same rule as `gen-vocabulary.ts`)
if (process.argv[1] && process.argv[1].endsWith('check-package.ts')) {
  main();
}
