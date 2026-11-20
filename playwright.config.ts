import { defineConfig } from '@playwright/test';

/**
 * The Playwright configuration, in **Electron mode**.
 *
 * ── Why Electron mode and not browser mode ──
 *
 * This product **is** an Electron application: the cards run in iframes,
 * over the `cockpit://` protocol, and the preload script proxies the host
 * capabilities. Browser mode exercises none of that (the protocol, the
 * preload script, the process boundary).
 *
 * ── Why `workers: 1` ──
 *
 * **A serial port is exclusive** (device fact S1), so the Electron
 * applications have to run one at a time. Running e2e in parallel makes
 * "the serial port is taken" indistinguishable from "the code has a bug".
 */
export default defineConfig({
  testDir: 'tests/e2e',
  /** Electron takes a dozen seconds to start (build artefacts, first frame) */
  timeout: 60_000,
  expect: { timeout: 10_000 },
  /** One at a time: a serial port is exclusive */
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
