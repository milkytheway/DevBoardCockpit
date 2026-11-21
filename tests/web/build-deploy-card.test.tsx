import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The "build and deploy" card (`cards/build-deploy/card.js`) — three stages.
 *
 * ── Why it needs a guard ──
 *
 * → It drives a build, an upload and a load, and it drives them through the
 *   host: a card may not run a command on the board by itself.
 * → Its three stages are independent, so a failure in one must not leave the
 *   other two looking as if they had run.
 *
 * ── The judgments ──
 *
 * | # | Judgment | Why |
 * |---|---|---|
 * | 1 | The three stage buttons exist | the card is the entry point of the flow |
 * | 2 | All three inputs may be left empty | the defaults of the host are good enough for the common case |
 * | 3 | Clicking a stage calls the matching workflow pack | the card collects inputs, the host runs the steps |
 * | 4 | The stage that is still running is not a stage that succeeded | `verified: false` is not a success |
 * | 5 | A refusal is reported as a refusal | the card must not pretend the build ran |
 */
const REPO_ROOT = resolve(__dirname, '../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'build-deploy');

/** Install a fake host API that returns the given workflows. */
function installCockpit(overrides: Record<string, unknown> = {}): void {
  (window as unknown as { cockpit: unknown }).cockpit = {
    workflows: {
      list: async () => FLOWS,
      run: async () => ({ ok: true, runId: 'wf-1' }),
      status: async () => ({ ok: true, state: 'done', stages: [] }),
      ...(overrides['workflows'] as Record<string, unknown> | undefined),
    },
  };
}

function mountCard(): void {
  const html = readFileSync(join(CARD_DIR, 'index.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html);
  document.body.innerHTML = (body?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/g, '');
}

let loaded: Promise<unknown> | null = null;
async function loadCard(): Promise<void> {
  if (loaded === null) loaded = import('../../cards/build-deploy/card.js');
  await loaded;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  }
}

const FLOWS = [
  { id: 'hello-kernel.compile', name: 'Compile', version: '1.0.0', inputs: {} },
  { id: 'hello-kernel.upload', name: 'Upload', version: '1.0.0', inputs: {} },
  { id: 'hello-kernel.load', name: 'Load', version: '1.0.0', inputs: {} },
];

beforeEach(() => {
  mountCard();
  vi.resetModules();
  loaded = null;
});

describe('The "build and deploy" card', () => {
  it('the three stage buttons are there (compile / upload / load)', async () => {
    installCockpit();
    await loadCard();
    expect(document.getElementById('phase-compile')).not.toBeNull();
    expect(document.getElementById('phase-upload')).not.toBeNull();
    expect(document.getElementById('phase-run')).not.toBeNull();
  });

  it('the three inputs are there (all of them may be left empty)', async () => {
    installCockpit();
    await loadCard();
    expect(document.getElementById('build-dir')).not.toBeNull();
    expect(document.getElementById('project')).not.toBeNull();
    expect(document.getElementById('module')).not.toBeNull();
  });

  it('clicking compile calls the compile workflow, with the directory and the project', async () => {
    const run = vi.fn(async () => ({ ok: true, runId: 'wf-1' }));
    installCockpit({ workflows: { list: async () => FLOWS, run } });
    await loadCard();
    (document.getElementById('build-dir') as HTMLInputElement).value = '/home/me/src';
    (document.getElementById('project') as HTMLInputElement).value = 'hello';
    (document.getElementById('phase-compile') as HTMLButtonElement).click();
    await flush();
    expect(run).toHaveBeenCalledWith('hello-kernel.compile', {
      build_dir: '/home/me/src',
      project: 'hello',
    });
  });

  it('clicking load sends the module name only (an empty field sends no argument at all)', async () => {
    const run = vi.fn(async () => ({ ok: true, runId: 'wf-1' }));
    installCockpit({ workflows: { list: async () => FLOWS, run } });
    await loadCard();
    (document.getElementById('phase-run') as HTMLButtonElement).click();
    await flush();
    expect(run).toHaveBeenCalledWith('hello-kernel.load', {});

    (run as unknown as { mockClear: () => void }).mockClear();
    (document.getElementById('module') as HTMLInputElement).value = 'hello';
    (document.getElementById('phase-run') as HTMLButtonElement).click();
    await flush();
    expect(run).toHaveBeenCalledWith('hello-kernel.load', { module: 'hello' });
  });

  it('a refusal is reported as a refusal (the card must not pretend it ran)', async () => {
    installCockpit({
      workflows: {
        list: async () => FLOWS,
        run: async () => ({ ok: false, reason: 'denied' }),
      },
    });
    await loadCard();
    (document.getElementById('phase-compile') as HTMLButtonElement).click();
    await flush();
    // → **The cards speak Chinese** ✓ (the card protocol carries no locale ✓)
    expect(document.getElementById('note')?.textContent).toMatch(/没有被授权/);
    expect(document.querySelector('.bd__step.is-failed')).not.toBeNull();
  });

  it('every stage distinguishes "it ran" from "it succeeded" (verified: false is not a success)', async () => {
    installCockpit({
      workflows: {
        list: async () => FLOWS,
        run: async () => ({ ok: true, runId: 'wf-1' }),
        status: async () => ({
          ok: true,
          state: 'done',
          current: null,
          stages: [
            { stepId: 'compile', kind: 'exec', ok: true, verified: true },
            { stepId: 'artifacts', kind: 'discover', ok: true, verified: false },
          ],
        }),
      },
    });
    await loadCard();
    (document.getElementById('phase-compile') as HTMLButtonElement).click();
    await flush(10);
    const steps = document.querySelectorAll('.bd__run-item');
    expect(steps.length).toBe(2);
    expect(steps[0]?.className).toContain('is-ok');
    expect(steps[1]?.className).toContain('is-warn');
  });

  it('a workflow the host does not have is reported as missing (the card must not pretend it has it)', async () => {
    installCockpit({ workflows: { list: async () => [] } });
    await loadCard();
    expect(document.getElementById('note')?.textContent).toMatch(/宿主没有/);
  });
});
