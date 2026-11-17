import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * **「编译上板」那张卡**（`cards/build-deploy/card.js`）——三段式。
 *
 * ── 为什么要有守卫 ──
 *
 * → 它**把编译、上传、运行拆成三步** ✓ —— 每一步都是一次真实流程 ✗
 *   → 按钮和参数如果错了，用户会在真板子上跑错命令 ✗ → **必须守住** ✓。
 *
 * ── 测什么 ──
 *
 * | # | 判据 | 为什么 |
 * |---|---|---|
 * | 1 | **流程清单来自宿主** ✓ | 没在清单里的流程不能偷偷跑 ✓ |
 * | 2 | **三个参数输入都在** ✓ | 目录 / 项目 / 模块名都可以留空 ✓ |
 * | 3 | **点哪一步就调哪条流程** ✓ | 卡片自己不执行命令 ✓ |
 * | 4 | **空参数不发给宿主** ✓ | 留给流程包的默认值 ✓ |
 * | 5 | **没被授权就说没被授权** ✓ | 不装作跑起来了 ✓ |
 * | 6 | **跑过 ≠ 成了** ✓ | `verified: false` 不是成功 ✓ |
 */
const REPO_ROOT = resolve(__dirname, '../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'build-deploy');

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
  { id: 'hello-kernel.compile', name: '编译', version: '1.0.0', inputs: {} },
  { id: 'hello-kernel.upload', name: '上传', version: '1.0.0', inputs: {} },
  { id: 'hello-kernel.load', name: '运行', version: '1.0.0', inputs: {} },
];

beforeEach(() => {
  mountCard();
  vi.resetModules();
  loaded = null;
});

describe('「编译上板」那张卡', () => {
  it('**三个步骤按钮都在** ✓（编译 / 上传 / 运行 ✓）', async () => {
    installCockpit();
    await loadCard();
    expect(document.getElementById('phase-compile')).not.toBeNull();
    expect(document.getElementById('phase-upload')).not.toBeNull();
    expect(document.getElementById('phase-run')).not.toBeNull();
  });

  it('**三个输入都在** ✓（全部可以留空 ✓）', async () => {
    installCockpit();
    await loadCard();
    expect(document.getElementById('build-dir')).not.toBeNull();
    expect(document.getElementById('project')).not.toBeNull();
    expect(document.getElementById('module')).not.toBeNull();
  });

  it('**点「编译」就调编译流程** ✓（带上目录与项目 ✓）', async () => {
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

  it('**点「运行」只发模块名** ✓（空就一个参数都不发 ✓）', async () => {
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

  it('**没被授权就说没被授权** ✓（**不装作跑起来了** ✗）', async () => {
    installCockpit({
      workflows: {
        list: async () => FLOWS,
        run: async () => ({ ok: false, reason: 'denied' }),
      },
    });
    await loadCard();
    (document.getElementById('phase-compile') as HTMLButtonElement).click();
    await flush();
    expect(document.getElementById('note')?.textContent).toContain('没有被授权');
    expect(document.querySelector('.bd__step.is-failed')).not.toBeNull();
  });

  it('**每一步分得清「跑过」与「成了」** ✓（**`verified: false` 不是成功** ✓）', async () => {
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

  it('**宿主没有这条流程就说没有** ✓（**不装成「有」** ✓）', async () => {
    installCockpit({ workflows: { list: async () => [] } });
    await loadCard();
    expect(document.getElementById('note')?.textContent).toContain('宿主没有');
  });
});
