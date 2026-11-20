import { describe, it, expect } from 'vitest';
import { cardApis } from '../../../src/main/cards/api-registry';
import { TOOL_DEFS, READ_TOOL_DEFS } from '../../../src/main/mcp/server';
import { IPC } from '../../../src/shared/ipc-contract';

/**
 * The contract boundary of cancellation (contract `05` §8, item A).
 *
 * What this group defends against:
 *
 * | Criterion | Defends against |
 * |---|---|
 * | **there is no cancellation in the card API** | a card could "stop somebody else's run", and that is **not covered by any permission item** (contract **A4**) |
 * | **there is no cancellation in the MCP tools** | the agent would get a channel to **decide on its own not to act**, which adds a bypass to the "the operator agrees" chain (contract **A4**) |
 * | **the host has those two channels** | "the compile takes minutes and there is no way to stop it half way" (contract A1–A10 are all **semantics** — without an entry point there is nothing) |
 *
 * This boundary is worth keeping: it is the **executable form** of the
 * statement that the permission model has one direction only.
 */
describe('cancellation · the contract boundary (A4: only the host may cancel)', () => {
  it('**there is no cancellation in the card API**', () => {
    const names = cardApis().map((api) => api.name);
    expect(names.some((n) => n.includes('cancel'))).toBe(false);
    // **not one of the workflow methods a card should have is missing** (the door
// may not be closed too far)
    for (const name of ['workflows.list', 'workflows.run', 'workflows.status']) {
      expect(names).toContain(name);
    }
  });

  it('**there is no cancellation in the MCP tools**', () => {
    const names = [...TOOL_DEFS, ...READ_TOOL_DEFS].map((tool) => tool.name);
    expect(names.some((n) => n.includes('cancel'))).toBe(false);
    for (const name of ['list_workflows', 'run_workflow', 'workflow_status']) {
      expect(names).toContain(name);
    }
  });

  it('**the host has two channels, "recent runs" and "cancel"**', () => {
    expect(IPC.workflowsRecent).toBe('workflows:recent');
    expect(IPC.workflowsCancel).toBe('workflows:cancel');
  });
});