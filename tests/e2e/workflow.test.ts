import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchApp, cardFrameFor, placeCard, writeCard } from './harness';
import { digestOf } from '../../src/main/workflows/registry';

/**
 * **卡片触发流程**（计划 7 · 契约 `spec/03` §7.7 的三行 ✓）。
 *
 * ── 这条 e2e 在证什么 ──
 *
 * 「用户点一下就编译上板」这条路，**最后一段是卡片** ✓：
 * 卡片起一条流程 ✓ → 拿到 `run_id` ✓ → 轮询状态 ✓ → 看到阶段时间线 ✓。
 *
 * → 前面那些单测证的是**各层自己** ✓（授权 ✓ · 投影 ✓ · 规则 14 ✓）；
 * → 这一条证的是**接起来了** ✓（卡片的 `cockpit.workflows.*` 真的能驱动流程层 ✓）。
 *
 * ── 为什么用假设备 ──
 *
 * e2e 要**可重复** ✓ → 不依赖真板在场 ✓（真板另有尖兵 ✓）。
 */

/** 流程包（**角色绑到假设备** ✓ —— 假设备是 ssh 传输 ✓，且不绑 `local` ✓） */
const FLOW_ID = 'demo.e2e';
const FLOW_YAML = `apiVersion: devboard/v1
kind: Workflow
id: ${FLOW_ID}
name: E2E 流程
version: 1.0.0
inputs: {}
roles:
  build:
    purpose: 假客机
    profile: fake-board
steps:
  - id: hello
    kind: exec
    role: build
    cmd: 'echo hello'
`;

/** 一张会起流程的卡 */
function flowCard(cardId: string, flowId: string): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(
      {
        apiVersion: 'devboard/v1',
        kind: 'Card',
        id: cardId,
        name: 'E2E 流程卡',
        version: '1.0.0',
        entry: 'index.html',
        // **声明要这个流程** ✓（规则 3：requires ⊆ permissions ✓）
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
    // **别记「有几个」** ✓ —— **那个数会过时** ✓（内置流程包一多就变 ✓ → 断言跟着红 ✓
    //   （实测 2026-11-16：批准账那层被拿掉后，列出来的是**全部**流程 ✓
    //     —— 断言写死 '1' 就**必然红** ✓，而**流程本身好好的** ✓）。
    // → 记「**我要的那个在不在**」✓（**这才是这条用例要证明的事** ✓）。
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
      // **状态不是 running 了 → 收工** ✓
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

/** 把流程包 · 批准账 · 授权账写进 userData（**必须在应用启动前** ✓） */
function prepare(userDataDir: string, cardId: string, flowId: string): void {
  const workflowsDir = join(userDataDir, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, `${flowId}.yaml`), FLOW_YAML, 'utf8');
  // **批准账**（放一个文件进目录 ≠ 批准它 ✓ —— 摘要对得上才算 ✓）
  writeFileSync(
    join(userDataDir, 'workflows-approved.json'),
    JSON.stringify({
      workflows: { [flowId]: { digest: digestOf(FLOW_YAML), at: Date.now() } },
    }),
    'utf8',
  );
  // **不用再写卡级授权了** ✓（2026-11-16 起没有那一层 ✓ —— ADR-D46 ✓）
  // → **流程包批准就是唯一那道闸** ✓（**它能跑任意命令** ✓ —— 板型包管不到 ✓）
}

test.describe('卡片触发流程', () => {
  test('一张卡能起一条流程 → 拿到 run_id → 轮询看到时间线', async () => {
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

      // **读卡片自己那个 div 的 dataset** ✓（不是 body 的 ✓ —— 写在哪就读哪 ✓）
      const readData = (): Promise<Record<string, string>> =>
        frame.evaluate(() => {
          const el = document.getElementById('result');
          return { ...(el?.dataset ?? {}) };
        });

      // **等卡片跑完** ✓
      await expect
        .poll(async () => (await readData())['done'] ?? '', { timeout: 30_000 })
        .toBe('1');

      const data = await readData();

      // **先把卡片看到的东西打出来** ✓（判据失败时能一眼看出是哪一步 ✗）
      console.log('卡片看到的数据：', JSON.stringify(data));
      // **没这个键就是没出错** ✓（`undefined` 不是「空串」✓）
      expect(data.error ?? '', `卡片抛了：${data.error}`).toBe('');
      // **列得出流程** ✓ —— **要的是「我要的那个在列表里」** ✓
      // （**不是「列表里只有一个」** ✓ —— 那是**会过时的写死事实** ✓）
      expect(data.listed).toBe('1');
      // **起得了** ✓
      expect(data.runOk).toBe('true');
      expect(data.runId).not.toBe('');
      // **跑完了** ✓
      expect(data.state).toBe('done');
      // **时间线有一行** ✓（那条 exec ✓）
      expect(data.stageCount).toBe('1');
    } finally {
      await app.close();
    }
  });
});
