import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, writeCard, currentCardFrame, placeCard, APP_NAME } from './harness';

/**
 * 写侧的**端到端**：一张卡触发一次动作 → 界面按**回读值**渲染。
 *
 * ── 这条判据在证明什么 ──
 *
 * 契约 `docs/spec/03-card-manifest.md` §5.2：
 *
 * > 「**卡片必须用返回值渲染，不能自己乐观更新。**」
 *
 * → 所以判据不是「动作执行了」，而是：
 * **卡片显示的那个数，是从板子上读回来的**。
 * 乐观更新的话，卡片会显示自己刚传进去的参数——
 * 那张卡在「板子没接上」时也会显示「已设置 200」✗。
 *
 * ── 为什么用假设备 ──
 *
 * 真板子不在这台机器上；而这条判据必须**可自动化**。
 * 假设备现在有一块**虚拟盘**（`hal/fake/fs.ts`）→
 * 动作的命令真的写进去，回读真的读回来 ✓。
 *
 * ── 三层都要真 ──
 *
 * ① **main 侧**：授权账 → 权限判定 → 执行器 → 回读 → 审计（真代码）
 * ② **HAL 侧**：假设备的虚拟盘（真文件往返）
 * ③ **卡片侧**：卡片 iframe 里的 JS 真的按返回值渲染
 */

/** 一张会调动作的卡（渲染**回读值**，不是自己传的参数） */
const ACTION_CARD: Record<string, string> = {
  'manifest.json': JSON.stringify(
    {
      apiVersion: 'devboard/v1',
      kind: 'Card',
      id: 'action-card',
      name: '动作卡',
      version: '1.0.0',
      entry: 'index.html',
      requires: { actions: ['backlight.set'] },
      permissions: { read: [], write: ['backlight.set'] },
    },
    null,
    2,
  ),
  'index.html':
    '<!doctype html><meta charset="utf-8"><body><div id="result">pending</div>' +
    '<script type="module" src="./card.js"></script>',
  'card.js': [
    "const el = document.getElementById('result');",
    "cockpit.actions.invoke('backlight.set', { value: 200 })",
    '  .then((r) => {',
    '    el.textContent = JSON.stringify({',
    '      ok: r.ok,',
    '      verified: r.verified,',
    "      value: r.readback ? r.readback.value : null,",
    '      audit: r.audit_id ?? null,',
    '    });',
    '  })',
    "  .catch((e) => { el.textContent = 'error:' + String(e); });",
  ].join('\n'),
};

test('一张卡触发一次动作 → 界面按**回读值**渲染（不是乐观更新）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-action-e2e-'));
  try {
    /**
     * ── **得先把权限打开** ──
     *
     * → **卡片写板子默认禁止** ✓（**ADR-D47** ✓ —— **设置里的统一权限区** ✓）
     *   → 理由：**宿主验不了「人点了卡片上的按钮」** ✗ → **默认不给** ✓ → **要写板子的人在设置里打开** ✓
     * → 这份账就是**设置里那个开关存下来的东西** ✓（`permissions.json` ✓）
     */
    const userDataDir = join(root, APP_NAME);
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      join(userDataDir, 'permissions.json'),
      JSON.stringify({ card: { 'action:backlight.set': true }, agent: {} }, null, 2),
      'utf8',
    );

    // **只有假设备**（真板子不在这台机器上）
    const app = await launchApp({ userDataDir: root, env: { COCKPIT_FAKE: 'only' } });
    try {
      /**
       * ── 生产构建里**没有假设备** ──
       *
       * ADR-D30：假设备**不进生产包**（`scripts/check-build.ts` 验的就是这件事）→
       * 这条判据要 `npm run build:fake`（`--mode fake`）才跑得起来。
       *
       * → **自己判断**：假 profile 在连接清单里吗？
       * → 不在就**跳过并说清楚为什么**（不是「悄悄通过」）。
       */
      const hasFake = await app.window.evaluate(async () => {
        const list = await (
          window as unknown as {
            cockpit: { connectionsList(): Promise<{ id: string }[]> };
          }
        ).cockpit.connectionsList();
        return list.some((c) => c.id === 'fake-board');
      });
      test.skip(
        !hasFake,
        '这条判据要**带假设备的构建**（`npm run build:fake`）——生产构建里没有假设备（ADR-D30）',
      );

      // ── 等运行时连上（动作跑在那条连接上）──
      await expect
        .poll(
          async () =>
            app.window.evaluate(() =>
              (
                window as unknown as { cockpit: { tagsReadings(): Promise<unknown[]> } }
              ).cockpit.tagsReadings(),
            ),
          { timeout: 20_000 },
        )
        .not.toHaveLength(0);

      await writeCard(app.userDataDir, 'action-card', ACTION_CARD);
      // **先把卡放进工作台**（外壳的规矩：卡片要先「就位」才进主区）
      await placeCard(app.window, 'action-card');

      /**
       * ── 等「**成功**的那次渲染」──
       *
       * 卡片刚写进去时会被**热更新**一次（内容指纹变了 → 实例 id 变了 → iframe 重建）
       * → 卡片脚本会跑**两遍**：第一遍可能赶在运行时连上之前（失败），
       * 第二遍才是真的成功。
       *
       * → 所以**不能**只等「出现 `"ok"`」——那会逮到第一次（失败的那次）✗。
       * → 等**回读值 200**（只有成功才有）✓。
       */
      await expect
        .poll(
          async () => {
            // **每轮重新找帧**（热更新会换掉旧帧）
            const frame = await currentCardFrame(app.window, 'action-card');
            if (frame === undefined) return '';
            return (await frame.locator('#result').textContent().catch(() => '')) ?? '';
          },
          { timeout: 30_000 },
        )
        .toContain('"value":"200"');

      const frame = await currentCardFrame(app.window, 'action-card');
      if (frame === undefined) throw new Error('卡片 action-card 的 iframe 不见了');
      const raw = (await frame.locator('#result').textContent()) ?? '{}';
      const rendered = JSON.parse(raw) as {
        ok: boolean;
        verified: boolean;
        value: string | null;
        audit: string | null;
        reason?: string;
      };
      // **失败时把卡片看到的东西原样带出来**（不然只剩一句「不是 true」）
      expect(rendered.ok, `卡片看到的结果：${raw}`).toBe(true);
      expect(rendered.verified).toBe(true);
      // **回读到的值**（板子上真的写着 200）——不是卡片自己传的参数
      expect(rendered.value).toBe('200');
      // 结果带**审计的 id**（契约 spec/04 §2.4）
      expect(rendered.audit).toBeTruthy();

      // ── 审计：恰好一行，且**参数与回读值都在** ──
      const auditPath = join(app.userDataDir, 'logs', 'actions.log');
      expect(existsSync(auditPath)).toBe(true);
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('action=backlight.set');
      // 回读值是**文本**（file_equals 比的是文件内容）→ 审计行里是带引号的
      expect(lines[0]).toContain('value="200"');
      expect(lines[0]).toContain('verified=true');
    } finally {
      await app.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * **默认：卡片不许写板子** ✓（**ADR-D47** ✓ · **C2** ✓）。
 *
 * → **宿主验不了「人点了卡片上的按钮」** ✗ → **默认不给** ✓
 * → **要写板子的人在设置里打开那个开关** ✓（**一次** ✓ · **不再有弹窗** ✓）
 */
test('卡片写板子：默认被拒（**设置里没打开** ✓）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-perm-e2e-'));
  try {
    // **不写 permissions.json** ✓ → **走默认** ✓（**卡片写板子：禁止** ✓）
    const app = await launchApp({ userDataDir: root, env: { COCKPIT_FAKE: 'only' } });
    try {
      const hasFake = await app.window.evaluate(async () => {
        const list = await (
          window as unknown as { cockpit: { connectionsList(): Promise<{ id: string }[]> } }
        ).cockpit.connectionsList();
        return list.some((c) => c.id === 'fake-board');
      });
      test.skip(
        !hasFake,
        '这条判据要**带假设备的构建**（`npm run build:fake`）——生产构建里没有假设备（ADR-D30）',
      );

      await expect
        .poll(
          async () =>
            app.window.evaluate(() =>
              (
                window as unknown as { cockpit: { tagsReadings(): Promise<unknown[]> } }
              ).cockpit.tagsReadings(),
            ),
          { timeout: 20_000 },
        )
        .not.toHaveLength(0);

      await writeCard(app.userDataDir, 'action-card', ACTION_CARD);
      await placeCard(app.window, 'action-card');

      // **等它渲染出「失败」** ✓（**被拒就是失败** ✓ —— 不是「还没跑」✓）
      await expect
        .poll(
          async () => {
            const frame = await currentCardFrame(app.window, 'action-card');
            if (frame === undefined) return '';
            return (await frame.locator('#result').textContent().catch(() => '')) ?? '';
          },
          { timeout: 30_000 },
        )
        .toContain('"ok":false');

      const frame = await currentCardFrame(app.window, 'action-card');
      if (frame === undefined) throw new Error('卡片 action-card 的 iframe 不见了');
      const raw = (await frame.locator('#result').textContent()) ?? '{}';
      const rendered = JSON.parse(raw) as { ok: boolean; value: string | null };
      expect(rendered.ok, `卡片看到的结果：${raw}`).toBe(false);
      // **板子上没有那个数** ✓（**动作根本没跑** ✓ —— 不是「跑了但回读失败」✓）
      expect(rendered.value).toBeNull();
    } finally {
      await app.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
