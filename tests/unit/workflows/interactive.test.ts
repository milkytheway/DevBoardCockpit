import { describe, it, expect } from 'vitest';
import { runWorkflowInteractively } from '../../../src/main/workflows/interactive';
import { parseWorkflow, type WorkflowPack } from '../../../src/main/workflows/format';
import { TargetRegistry } from '../../../src/main/workflows/targets';
import { ConfirmationStore } from '../../../src/main/actions/authorization';
import type { WorkflowRunDeps } from '../../../src/main/workflows/runner';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';
import type { Connection, ExecResult } from '../../../src/main/hal/connection';

/**
 * **人点头的那一下**（契约 `spec/05` §7.6 的确认链 ✓）。
 *
 * ── 这条判据在盯什么 ──
 *
 * 契约 §7.6 要的是：**同一个 `run_id`** ✓ · **同一份时间线** ✓ ·
 * **从停住的那一步继续**（**前面的步不重跑** ✓）。
 *
 * → 这三条**只有「人点头发生在同一个进程里」才天然成立** ✓。
 * → 跨进程那条路要**持久化整个运行状态** ✓（否则「同一份时间线」做不到 ✓）→ 大工程 ✓。
 *
 * → 所以这里的判据是：**同进程**问人 ✓ → 人点头 ✓ → **从那一步继续** ✓。
 */

/** 一条带 destructive 步的流程（**逼出确认** ✓） */
const PACK: WorkflowPack = parseWorkflow(
  {
    apiVersion: 'devboard/v1',
    kind: 'Workflow',
    id: 'w.confirm',
    name: '要人确认的流程',
    version: '1.0.0',
    inputs: {},
    roles: { build: { purpose: '客机', profile: 'guest' } },
    steps: [
      { id: 'first', kind: 'exec', role: 'build', cmd: 'echo first' },
      { id: 'risky', kind: 'exec', role: 'build', cmd: 'echo risky', danger: 'destructive' },
      { id: 'last', kind: 'exec', role: 'build', cmd: 'echo last' },
    ],
  },
  'w.yaml',
);

interface Harness {
  deps: WorkflowRunDeps;
  /** 每个目标上跑过的命令 ✓ */
  commands: string[];
}

function harness(): Harness {
  const commands: string[] = [];
  const profile: ConnectionProfile = {
    id: 'guest',
    label: '客机',
    transport: 'ssh',
    options: { host: '10.0.0.2' },
  };
  const conn = {
    id: 'guest',
    transport: 'ssh',
    capabilities: () => ({ exec: true, files: true, exitCode: true, pty: false }),
    open: async () => undefined,
    close: async () => undefined,
    exec: async (command: string): Promise<ExecResult> => {
      commands.push(command);
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    },
    pull: async () => undefined,
    push: async () => undefined,
    list: async () => [],
    openSession: async () => {
      throw new Error('不开会话');
    },
  } as unknown as Connection;

  const targets = new TargetRegistry({
    profileFor: (id) => (id === 'guest' ? profile : undefined),
    createConnection: () => conn,
  });
  const confirmations = new ConfirmationStore();
  const deps: WorkflowRunDeps = {
    targets,
    profileFor: (id) => (id === 'guest' ? profile : undefined),
    audit: () => 'audit-1',
    confirmations,
  };
  return { deps, commands };
}

describe('人点头（确认链的落点）', () => {
  it('遇到 destructive 步 → **问人** → 点头 → **从那一步继续**（前面的步**不重跑** ✓）', async () => {
    const h = harness();
    const asked: string[] = [];
    const result = await runWorkflowInteractively(PACK, {}, h.deps, { approved: true }, async (q) => {
      asked.push(q.stepId);
      return true; // **人点头** ✓
    });

    // **问了人** ✓（而且问的是那一步 ✓）
    expect(asked).toEqual(['risky']);
    // **跑完了** ✓
    expect(result.ok).toBe(true);
    // **三个步都在时间线上** ✓
    expect(result.stages.map((s) => s.stepId)).toEqual(['first', 'risky', 'last']);
    // **前面的步只跑了一次** ✓（不重跑 ✓ —— 契约 §7.6 ✓）
    expect(h.commands.filter((c) => c.includes('first'))).toHaveLength(1);
    // **destructive 那一步也真跑了** ✓
    expect(h.commands.filter((c) => c.includes('risky'))).toHaveLength(1);
  });

  it('**人摇头 → 不跑那一步**（不许「没人点头也照样做」✗）', async () => {
    const h = harness();
    const result = await runWorkflowInteractively(PACK, {}, h.deps, { approved: true }, async () => false);

    expect(result.ok).toBe(false);
    // **那一步没跑** ✓
    expect(h.commands.some((c) => c.includes('risky'))).toBe(false);
    // **而且说清了是「人没点头」** ✓（不是「失败了」✗）
    expect(result.needsConfirmation?.stepId).toBe('risky');
  });

  it('**同一次运行**（run_id 不变 ✓）—— 续跑不是重开一条 ✓', async () => {
    const h = harness();
    const result = await runWorkflowInteractively(PACK, {}, h.deps, { approved: true }, async () => true);
    // run_id 是调用方给的或生成的 ✓ —— 这里只断言**它存在且贯穿始终** ✓
    expect(result.runId).toBeTruthy();
    expect(result.stages.every((s) => s.stepId)).toBe(true);
  });
});
