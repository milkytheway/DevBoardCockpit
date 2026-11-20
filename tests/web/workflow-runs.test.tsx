import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { WorkflowRuns } from '../../src/renderer/shell/WorkflowRuns';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { CockpitApi } from '../../src/shared/ipc-contract';

/**
 * Cancelling a run (contract `docs/spec/05-workflow-pack.md` section 8.A) —
 * the only place the host offers a "stop".
 *
 * ── What this group of judgments guards ──
 *
 * | Judgment | What it prevents |
 * |---|---|
 * | The card API has no `workflows.cancel` | a card could stop somebody else's run — that is not covered by any permission |
 * | The MCP tool set has no cancel | an agent would have a "decide to stop by itself" channel, a bypass around the chain that asks the person |
 * | The host does have those two channels | "the build takes minutes and there is no way to stop it halfway" — a rule that has no entry point is not a rule |
 * | Nothing is rendered while no run is active | the strip would be a permanent row, and the title bar must not get crowded |
 *
 * The locale is pinned to English, so the wording under test is fixed.
 */

describe('Cancelling · the stop button of the shell', () => {
  const cancel = vi.fn(async () => ({ runId: 'r1' }));

  /** Only the few methods the test needs (the type is the whole api, the test touches two of them). */
  function setApi(partial: Partial<CockpitApi>): void {
    (window as unknown as { cockpit: CockpitApi }).cockpit = partial as CockpitApi;
  }

  beforeEach(() => {
    cancel.mockClear();
    setApi({ workflowsRecent: async () => [], workflowsCancel: cancel });
  });

  afterEach(() => {
    delete (window as unknown as { cockpit?: unknown }).cockpit;
  });

  function renderRuns(): void {
    render(
      <LocaleContext.Provider value="en">
        <WorkflowRuns />
      </LocaleContext.Provider>,
    );
  }

  it('with no run in flight nothing is rendered (the strip may not be a permanent row)', async () => {
    renderRuns();
    await waitFor(() => expect(cancel).not.toHaveBeenCalled());
    expect(screen.queryByTestId('workflow-runs')).toBeNull();
  });

  it('with a run in flight it shows the workflow name, the current step and one stop', async () => {
    setApi({
      workflowsRecent: async () => [
        {
          runId: 'r1',
          workflowId: 'hello-kernel.build-run',
          state: 'running',
          current: { stepId: 'compile', kind: 'exec', at: Date.now() - 42_000 },
          startedAt: Date.now() - 42_000,
          outputs: {},
        },
      ],
      workflowsCancel: cancel,
    });
    renderRuns();
    await waitFor(() => expect(screen.getByTestId('workflow-runs')).toBeTruthy());
    expect(screen.getByText('hello-kernel.build-run')).toBeTruthy();
    expect(screen.getByText(/compile/)).toBeTruthy();
    // How long it has been running is computed (contract B2: no percentage).
    expect(screen.getByText(/42 s|41 s|43 s/)).toBeTruthy();
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('pressing stop calls the cancel of the host (the cards take no part in it)', async () => {
    setApi({
      workflowsRecent: async () => [
        {
          runId: 'r7',
          workflowId: 'hello-kernel.build-run',
          state: 'running',
          current: { stepId: 'deliver', kind: 'file.transfer', at: Date.now() },
          startedAt: Date.now(),
          outputs: {},
        },
      ],
      workflowsCancel: cancel,
    });
    renderRuns();
    await waitFor(() => expect(screen.getByText('Stop')).toBeTruthy());
    screen.getByText('Stop').click();
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('r7'));
  });

  it('a run that has ended is not shown (only a running one takes space)', async () => {
    setApi({
      workflowsRecent: async () => [
        {
          runId: 'r8',
          workflowId: 'hello-kernel.build-run',
          state: 'done',
          current: null,
          startedAt: Date.now(),
          outputs: {},
        },
      ],
      workflowsCancel: cancel,
    });
    renderRuns();
    await waitFor(() => expect(cancel).not.toHaveBeenCalled());
    expect(screen.queryByTestId('workflow-runs')).toBeNull();
  });
});
