import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchApp, cardFrameFor, placeCard, writeCard } from './harness';

/**
 * A card triggers a workflow (the third line of the card API in the contract,
 * `docs/spec/03-card-manifest.md` section 7.7).
 *
 * ── What this e2e proves ──
 *
 * The path "the user clicks once and the module is built and loaded" ends
 * **with a card**: the card starts a workflow → it gets a `run_id` → it polls
 * the status → it sees the timeline of the stages.
 *
 * → The unit tests before it prove that **each layer is right on its own**
 *   (the authorisation, the projection, rule 14);
 * → This one proves that **they are connected** (the `cockpit.workflows.*` of
 *   a card really drives the workflow layer).
 *
 * ── Why the fake device ──
 *
 * An e2e test has to be **repeatable** → it must not depend on a real board
 * being present (the real board has other tests of its own).
 */
const FLOW_ID = 'demo.e2e';
const FLOW_YAML = `apiVersion: devboard/v1
kind: Workflow
id: ${FLOW_ID}
name: E2E workflow
version: 1.0.0
inputs: {}
roles:
  build:
    purpose: Fake guest machine
    profile: fake-board
steps:
  - id: hello
    kind: exec
    role: build
    cmd: 'echo hello'
`;

/** A card that starts a workflow */
function flowCard(cardId: string, flowId: string): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(
      {
        apiVersion: 'devboard/v1',
        kind: 'Card',
        id: cardId,
        name: 'E2E workflow card',
        version: '1.0.0',
        entry: 'index.html',
        // The workflow is declared here (rule 3: requires ⊆ permissions)
        requires: { workflows: [flowId] },
        permissions: { read: [], write: [], workflows: [flowId] },
      },
      null,
      2,
    ),
    'index.html':
      '<!doctype html><meta charset="utf-8"><body><div id="result">idle</div><script type="module" src="./card.js"></script>',
    'card.js': `
const out = document.getElementById('result');
(async () => {
  try {
    const FLOW_ID = '${FLOW_ID}';
    const list = await cockpit.workflows.list();
    // It does not record "how many there are" — that number goes stale, it
    // changes as soon as there are more built-in workflow packs, and the
    // assertion turns red with it (measured on 2026-11-16: once the layer of
    // the approval ledger was gone, the list held **every** workflow, so an
    // assertion hard-coded to '1' was **certain to go red** while the
    // workflows themselves were fine).
    // → It records "**is the one I want in the list**" (that is what this case
    //   has to prove).
    out.dataset.listed = String(
      Array.isArray(list) && list.some((w) => w && w.id === FLOW_ID) ? '1' : '0',
    );
    const run = await cockpit.workflows.run(${JSON.stringify(flowId)}, {});
    out.dataset.runOk = String(run && run.ok === true);
    out.dataset.runId = String((run && run.runId) || '');
    if (!run || !run.runId) { out.textContent = 'no run'; return; }
    for (let i = 0; i < 60; i += 1) {
      const st = await cockpit.workflows.status(run.runId);
      out.dataset.state = String((st && st.state) || '');
      out.dataset.stageCount = String((st && st.stages && st.stages.length) || 0);
      // The state is no longer running → the work is done
      if (st && st.state !== 'running') { out.textContent = String(st.state); break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    out.dataset.done = '1';
  } catch (err) {
    out.dataset.error = String(err && err.message ? err.message : err);
    out.dataset.done = '1';
  }
})();
`,
  };
}

/** Write the workflow pack into userData (it has to be there before the application starts) */
function prepare(userDataDir: string, cardId: string, flowId: string): void {
  const workflowsDir = join(userDataDir, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, `${flowId}.yaml`), FLOW_YAML, 'utf8');
  // There is no approval ledger to write any more (that layer is gone since
  // 2026-11-16 — ADR-D48)
  // → **The gate is the unified permission area of the settings** (a card may
  //   trigger a workflow by default — ADR-D47)
}

test.describe('A card triggers a workflow', () => {
  test('a card starts a workflow → gets a run_id → polls and sees the timeline', async () => {
    const cardId = 'e2e-flow-card';
    const app = await launchApp({
      env: { COCKPIT_FAKE: 'only' },
      prepare: (dir) => prepare(dir, cardId, FLOW_ID),
    });
    try {
      await writeCard(app.userDataDir, cardId, flowCard(cardId, FLOW_ID));
      await app.window.waitForTimeout(500);
      await placeCard(app.window, cardId);
      const frame = await cardFrameFor(app.window, cardId);

      // The dataset of the div of the card itself is read (not the one of the
      // body — it is read where it is written)
      const readData = (): Promise<Record<string, string>> =>
        frame.evaluate(() => {
          const el = document.getElementById('result');
          return { ...(el?.dataset ?? {}) };
        });

      // Wait for the card to finish
      await expect
        .poll(async () => (await readData())['done'] ?? '', { timeout: 30_000 })
        .toBe('1');

      const data = await readData();

      // What the card saw is printed first (when the judgment fails, the step
      // it failed at is visible at a glance)
      console.log('the data the card saw:', JSON.stringify(data));
      // The absence of the key means that nothing threw (`undefined` is not an
      // empty string)
      expect(data.error ?? '', `the card threw: ${data.error}`).toBe('');
      // The workflows can be listed — what matters is **that the one I want is
      // in the list**
      // (not **that the list holds only one** — that would be a hard-coded
      // fact that goes stale)
      expect(data.listed).toBe('1');
      // It can be started
      expect(data.runOk).toBe('true');
      expect(data.runId).not.toBe('');
      // It has finished
      expect(data.state).toBe('done');
      // The timeline has one row (the exec step)
      expect(data.stageCount).toBe('1');
    } finally {
      await app.close();
    }
  });
});
