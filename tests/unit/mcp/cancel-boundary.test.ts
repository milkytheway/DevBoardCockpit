import { describe, it, expect } from 'vitest';
import { cardApis } from '../../../src/main/cards/api-registry';
import { TOOL_DEFS, READ_TOOL_DEFS } from '../../../src/main/mcp/server';
import { IPC } from '../../../src/shared/ipc-contract';

/**
 * **取消的契约边界**（契约 `05` §八·A ✓）。
 *
 * ── 这一组在防什么 ──
 *
 * | 判据 | 防的是 |
 * |---|---|
 * | **卡片 API 里没有取消** | 卡片能「停一次别人的运行」✗ —— 那**不在任何权限项里** ✗（契约 **A4** ✓） |
 * | **MCP 工具里没有取消** | agent 有了「**自己决定不干**」的通道 ✗ —— 「人点头」那条链多一个旁路 ✗（契约 **A4** ✓） |
 * | **宿主有那两个通道** | 「编译要几分钟，中途想停做不到」✗（契约 A1–A10 全是**语义** ✓ —— **没有入口就是没有** ✓） |
 *
 * → **这条边界值得守着** ✓ —— 它是「权限模型只有一个方向」那句话的**可执行版本** ✓
 */
describe('取消 · 契约边界（A4：只有宿主能取消）', () => {
  it('**卡片 API 里没有取消** ✓', () => {
    const names = cardApis().map((api) => api.name);
    expect(names.some((n) => n.includes('cancel'))).toBe(false);
    // **卡片该有的流程方法一个都不少** ✓（别把门关过头了 ✓）
    for (const name of ['workflows.list', 'workflows.run', 'workflows.status']) {
      expect(names).toContain(name);
    }
  });

  it('**MCP 工具里没有取消** ✓', () => {
    const names = [...TOOL_DEFS, ...READ_TOOL_DEFS].map((tool) => tool.name);
    expect(names.some((n) => n.includes('cancel'))).toBe(false);
    for (const name of ['list_workflows', 'run_workflow', 'workflow_status']) {
      expect(names).toContain(name);
    }
  });

  it('**宿主有「最近运行」与「取消」两个通道** ✓', () => {
    expect(IPC.workflowsRecent).toBe('workflows:recent');
    expect(IPC.workflowsCancel).toBe('workflows:cancel');
  });
});