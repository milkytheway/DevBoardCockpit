import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { WorkflowRuns } from '../../src/renderer/shell/WorkflowRuns';
import type { CockpitApi } from '../../src/shared/ipc-contract';

/**
 * **取消**（契约 `05` §八·A ✓）—— **宿主唯一的「停」入口** ✓。
 *
 * ── 这组判据在防什么 ──
 *
 * | 判据 | 防的是 |
 * |---|---|
 * | **卡片 API 里没有 `workflows.cancel`** | 卡片能「停一次别人的运行」✗ —— 那**不在任何权限项里** ✗（契约 A4 ✓） |
 * | **MCP 工具里没有 cancel** | agent 有了「**自己决定不干**」的通道 ✗ —— 「人点头」那条链多一个旁路 ✗（契约 A4 ✓） |
 * | **宿主有这两个通道** | 「编译要几分钟，中途想停做不到」✗（契约 A1–A10 全是语义，**没有入口就是没有** ✓） |
 * | **没有运行中时不渲染** | 顶条**常驻一行** ✗ —— 顶条不能变挤 ✓ |
 */

describe('取消 · 外壳的「停」按钮', () => {
  const cancel = vi.fn(async () => ({ runId: 'r1' }));

  /** 只给测试要用的那几个方法 ✓（类型上是整个 api ✓ —— 测试里只碰这两个 ✓） */
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

  it('**没有运行中 → 什么都不渲染** ✓（顶条不能常驻一行 ✓）', async () => {
    render(<WorkflowRuns />);
    await waitFor(() => expect(cancel).not.toHaveBeenCalled());
    expect(screen.queryByTestId('workflow-runs')).toBeNull();
  });

  it('**有运行中 → 显示流程名 + 当前这一步 + 一个「停」** ✓', async () => {
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
    render(<WorkflowRuns />);
    await waitFor(() => expect(screen.getByTestId('workflow-runs')).toBeTruthy());
    expect(screen.getByText('hello-kernel.build-run')).toBeTruthy();
    expect(screen.getByText(/compile/)).toBeTruthy();
    // **已经跑了多久** ✓ —— **算出来的** ✓（契约 B2 ✓：不给百分比 ✓）
    expect(screen.getByText(/42 秒|41 秒|43 秒/)).toBeTruthy();
    expect(screen.getByText('停')).toBeTruthy();
  });

  it('**点「停」→ 调宿主的取消** ✓（**卡片不参与** ✓）', async () => {
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
    render(<WorkflowRuns />);
    await waitFor(() => expect(screen.getByText('停')).toBeTruthy());
    screen.getByText('停').click();
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('r7'));
  });

  it('**已结束的运行不显示** ✓（只有 running 才占地方 ✓）', async () => {
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
    render(<WorkflowRuns />);
    await waitFor(() => expect(cancel).not.toHaveBeenCalled());
    expect(screen.queryByTestId('workflow-runs')).toBeNull();
  });
});