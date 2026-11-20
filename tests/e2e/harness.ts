import { _electron as electron, type ElectronApplication, type Frame, type Page } from 'playwright';
import { expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The harness that runs the tests in a real Electron.
 *
 * ── Why not the browser mode ──
 *
 * The three boundaries of this product (the custom protocol, the preload, the
 * cross-process calls) exist only in Electron. A pass in the browser mode has
 * nothing to do with the boundaries the product really has.
 *
 * ── The display in the Linux sandbox ──
 *
 * The sandbox has no display. When `DISPLAY` is not set, an Xvfb is started
 * (the same method as `scripts/acceptance/run-app.sh`). The Windows host
 * has a display, so that branch never runs there.
 */

/** The root of the repository (the tests run from the root) */
const REPO_ROOT = resolve(process.cwd());

export interface Launched {
  app: ElectronApplication;
  window: Page;
  /** The userData directory of this run (the tests put their cards here) */
  userDataDir: string;
  /** Clean up: close the application, close Xvfb, remove the temporary directory */
  close: () => Promise<void>;
}

/** The name of the user data directory of the application (the same as DEFAULT_APP in `src/main/util/paths.ts`) */
export const APP_NAME = 'DevBoardCockpit';

/**
 * The Xvfb shared by the whole test process.
 *
 * ── Why it cannot be one per test ──
 *
 * The first test starts Xvfb, and the tests that follow see that `DISPLAY`
 * is already set and do not start another one — but if the first test's
 * `close()` kills it, the tests that follow have no display left: Electron
 * dies with `The platform failed to initialize` and a SIGSEGV.
 *
 * → Xvfb is started once and lives until the process exits (the cleanup runs
 *   on `process.on('exit')`).
 */
let sharedXvfb: ChildProcess | undefined;

/**
 * Start an Xvfb on Linux when there is no display.
 *
 * @returns the process (`process.env.DISPLAY` has been set)
 */
function ensureDisplay(): ChildProcess | undefined {
  if (process.platform !== 'linux') return undefined;
  if (process.env['DISPLAY'] !== undefined && process.env['DISPLAY'] !== '') return undefined;

  const display = `:${90 + Math.floor(Math.random() * 20)}`;
  const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
  proc.unref();
  process.env['DISPLAY'] = display;
  sharedXvfb = proc;
  // Clean up when the process exits (not when a test ends — the tests that
  // follow still need it)
  process.on('exit', () => {
    try {
      sharedXvfb?.kill();
    } catch {
      // It has already exited
    }
  });
  return proc;
}

/** Wait for the socket of Xvfb to appear */
async function waitForDisplay(display: string): Promise<void> {
  const socket = `/tmp/.X11-unix/X${display.replace(':', '')}`;
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(socket)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Xvfb ${display} did not start (${socket} does not exist)`);
}

/**
 * Start the application once.
 *
 * @param opts.executablePath the Electron binary. It defaults to
 *   `node_modules/electron`; the Linux sandbox has no npm build of the Linux
 *   binary, so `ELECTRON_BIN` points at it (the same environment variable as
 *   in `scripts/acceptance/run-app.sh`).
 * @param opts.env the environment variables to add (for example
 *   `COCKPIT_FAKE=only` connects the fake device only).
 */
export async function launchApp(
  opts: {
    executablePath?: string;
    userDataDir?: string;
    env?: Record<string, string>;
    /**
     * Write into the userData directory **before the application starts**.
     *
     * → Why it is needed: the workflow registry scans its directory once at
     *   start-up, so a workflow pack has to be in place before that — one step
     *   later and it is not found.
     */
    prepare?: (userDataDir: string) => void;
  } = {},
): Promise<Launched> {
  const xvfb = ensureDisplay();
  if (xvfb !== undefined) await waitForDisplay(process.env['DISPLAY'] as string);

  const mainEntry = join(REPO_ROOT, 'out', 'main', 'index.js');
  if (!existsSync(mainEntry)) {
    throw new Error(`the build output is missing: ${mainEntry} — run npm run build first`);
  }

  /**
   * The "user data directory" of both sides has to be the same place.
   *
   * The host computes it in `userDataDir()` of `src/main/util/paths.ts`:
   * on Linux `$XDG_DATA_HOME/DevBoardCockpit`, on Windows
   * `%LOCALAPPDATA%\DevBoardCockpit`. Electron's `app.getPath('userData')`
   * defaults to `%APPDATA%\DevBoardCockpit` — the roaming directory.
   *
   * → They are not the same place. The test writes the card into the Electron
   *   one and the application looks in the other →
   * **the card area is always empty** → the ten isolation judgments are all
   *   red, and the reason they are red is the **environment**.
   *
   * One thing is settled along the way: the e2e tests **no longer write into
   * the real user data directory of the user**.
   */
  // The userData passed in is reused (the "the position survives a restart"
  // judgment needs it) — without it every run gets a new temporary directory
  // (so the runs do not interfere with each other)
  const root = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'cockpit-e2e-'));
  const userDataDir = join(root, APP_NAME);
  mkdirSync(userDataDir, { recursive: true });
  // Whatever has to be written is written before the start (the workflow packs)
  opts.prepare?.(userDataDir);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  if (process.platform === 'win32') {
    env['LOCALAPPDATA'] = root;
  } else {
    env['XDG_DATA_HOME'] = root;
  }

  // The Electron binary: the one in node_modules by default; in the Linux
  // sandbox that one is the win32 build → `ELECTRON_BIN` points at the
  // right one (the same environment variable as in
  // `scripts/acceptance/run-app.sh`).
  const executablePath = opts.executablePath ?? process.env['ELECTRON_BIN'];
  const app = await electron.launch({
    // The application root is started (`electron .`), not
    // `electron out/main/index.js`
    //
    // The two give a different `app.getPath()`: the first one is the
    // application root, and **the root of the built-in cards is there**
    // (`join(app.getAppPath(), 'cards')`); the second one is the directory
    // of the script → **the built-in cards are not found**.
    // → The e2e test would not be testing what the user sees.
    //
    // `--disable-gpu`: in an environment without a GPU (a CI container,
    // Xvfb) the GPU process does not start, and Electron dies with
    // `The platform failed to initialize` and a SIGSEGV —
    // **that has nothing to do with what is under test** (the isolation of the
    // cards rests on the sandbox attribute and the CSP of the iframe, not on
    // the GPU).
    args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    cwd: REPO_ROOT,
    ...(executablePath !== undefined ? { executablePath } : {}),
    env,
  });
  const window = await app.firstWindow();

  return {
    app,
    window,
    userDataDir,
    close: async () => {
      await app.close().catch(() => undefined);
      // Xvfb is not killed — the whole test process shares it (see the comment
      // of `ensureDisplay`)
      void xvfb;
      // The directory that was passed in is not removed (it is the site of the
      // "it survives a restart" judgment)
      if (opts.userDataDir === undefined) {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Find the iframe **currently** showing a card (`undefined` when there is
 * none).
 *
 * ── Why this "current" variant exists ──
 *
 * A hot reload invalidates the old frame: the card files change → the content
 * fingerprint changes → the instance id changes → the iframe is rebuilt. A
 * judgment that holds on to a `Frame` reference and waits for a result never
 * sees it again at the moment of the rebuild. So a judgment has to **look the
 * frame up again on every round** (with the retry logic of `cardFrameFor`, or
 * with this function).
 *
 * @param cardId the id of the card
 */
export async function currentCardFrame(page: Page, cardId: string): Promise<Frame | undefined> {
  const list = await cardsList(page);
  const info = list.find((c) => c.cardId === cardId);
  if (info === undefined) return undefined;
  return page.frames().find((f) => f.url().startsWith(`cockpit://card/${info.instanceId}/`));
}

/**
 * Find the iframe of **a given card**.
 *
 * ── Why "the first card frame" is not enough ──
 *
 * The **built-in card (`cards/cpu-usage/`) is in the list by itself** (it
 * sits under the built-in root), so the card area holds more than one iframe.
 * The URL of a frame only carries the **instance id**
 * (`cockpit://card/<instance id>/…`), which does not say which card it is.
 *
 * → Ask the host for the list (`cardsList`), turn the card id into an
 *   instance id, and match the URL **exactly**.
 *
 * @param cardId the id of the card (the directory name and the id of the
 * manifest are the same)
 */
export async function cardFrameFor(page: Page, cardId: string): Promise<Frame> {
  // ── Why a retry and not a single wait ──
  //
  // The content fingerprint of the card goes into the **instance id** → **the
  // card files change and the instance id changes with them** (that is how
  // "edit a file and it reloads" is implemented: the URL changes → the iframe
  // is rebuilt). The e2e tests write a card as several files in a row → the
  // instance id wobbles a few times.
  //
  // → On every round the list is read again and the frame is looked up again;
  //   if the frame has already been replaced (detached) another round follows.
  //
  // And for a plainer reason: as soon as the iframe is in the DOM,
  // `page.frames()` sees it, but the card document **may not have finished
  // navigating** (the evaluate lands on about:blank).
  // → After the frame is found, the document has to be loaded and the bridge
  //   injected before it is handed out.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = await cardsList(page);
    const info = list.find((c) => c.cardId === cardId);
    if (info !== undefined) {
      const frame = page
        .frames()
        .find((f) => f.url().startsWith(`cockpit://card/${info.instanceId}/`));
      if (frame !== undefined && !frame.isDetached()) {
        const ready = await frame
          .evaluate(() => {
            const injected = (window as unknown as { cockpit?: unknown }).cockpit;
            return document.readyState === 'complete' && typeof injected === 'object';
          })
          .catch(() => false);
        if (ready) return frame;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the iframe of the card ${cardId} did not appear`);
}

/** Ask the host for the list of the installed cards */
export async function cardsList(page: Page): Promise<{ cardId: string; instanceId: string }[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        cockpit: { cardsList(): Promise<{ cardId: string; instanceId: string }[]> };
      }
    ).cockpit.cardsList(),
  );
}

/**
 * Put a card into the main area.
 *
 * The workbench starts **empty** — the cards live in the secondary sidebar's
 * catalogue until you pick them. So a test that wants to look at a card
 * has to place it first, exactly like a user would.
 */
export async function placeCard(page: Page, cardId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const list = await cardsList(page);
        return list.filter((c) => c.cardId === cardId).length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  // It is found by its data attribute, not by a class name: the e2e tests
  // know no class name at all, the DOM of the shell may be entirely different,
  // and as long as the interface is connected the judgments must stay green.
  await page.locator(`[data-cockpit-card-id="${cardId}"]`).first().click();
}

/** The place of the card directory under userData */
export function cardDir(userDataDir: string, cardId: string): string {
  return join(userDataDir, 'cards', cardId);
}

/**
 * Write a card into the userData directory.
 *
 * It writes into userData and not into the repository — a test must not leave
 * rubbish in the repository.
 */
export async function writeCard(
  userDataDir: string,
  cardId: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = cardDir(userDataDir, cardId);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

/**
 * The smallest read-only card (it reads cpu.usage).
 *
 * @param cardId the id of the card (the directory name and the id of the
 * manifest are the same)
 * @param marker the marker the card writes on
 * `document.body.dataset.marker` — the "edit a file and it reloads"
 * judgment watches it to see whether the new behaviour took effect
 */
export function simpleCard(cardId = 'e2e-card', marker = 'v1'): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(
      {
        apiVersion: 'devboard/v1',
        kind: 'Card',
        id: cardId,
        name: 'E2E card',
        version: '1.0.0',
        entry: 'index.html',
        requires: { tags: ['cpu.usage'] },
        permissions: { read: ['cpu.usage'], write: [] },
      },
      null,
      2,
    ),
    'index.html':
      '<!doctype html><meta charset="utf-8"><body>ok<script type="module" src="./card.js"></script>',
    'card.js':
      `document.body.dataset.marker = ${JSON.stringify(marker)};\n` +
      "const el = document.createElement('div');\n" +
      "el.id = 'value';\n" +
      "document.body.appendChild(el);\n" +
      "cockpit.tags.subscribe('cpu.usage', (v) => { el.textContent = String(v.value); });\n",
  };
}
