import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * **「编译上板」那张卡的逻辑**（`cards/build-deploy/card.js`）。
 *
 * ── 为什么要有守卫 ──
 *
 * → **卡片代码不进 vitest 的 include** ✓（它在 `cards/` 下 ✓ —— **不是 `src/`** ✓）
 *   → **没人跑它** ✗ → **它坏了也没人知道** ✗。
 * → 而这张卡**会触发流程** ✓ —— **流程能在用户机器上执行命令** ✗
 *   → **它的一举一动都得看得见** ✓ → **它得被测** ✓。
 *
 * → 所以这里**把它当普通模块加载** ✓（DOM 先摆好 ✓ —— 卡片一 import 就读元素 ✓）。
 *
 * ── 测什么 ──
 *
 * | # | 判据 | 为什么 |
 * |---|---|---|
 * | 1 | **只列宿主给的流程** ✓ | 流程包没批过 → 卡片**看不见** ✓ |
 * | 2 | **输入按流程声明渲染** ✓ | 卡片**不自己发明参数** ✓ |
| 3 | **点一下就调 `workflows.run`** ✓ | **它自己不执行命令** ✓ —— 那是流程层的事 ✓ |
| | 4 | **每一步都分得清「跑过」与「成了」** ✓ | `verified: false` **不是**成功 ✓（契约 §2.4 ✓） |
 */
const REPO_ROOT = resolve(__dirname, '../..');
const CARD_DIR = join(REPO_ROOT, 'cards', 'build-deploy');

/** 装一份假的宿主 API（**只给这张卡用得到的那几个** ✓） */
function installCockpit(overrides: Record<string, unknown> = {}): void {
  (window as unknown as { cockpit: unknown }).cockpit = {
    workflows: {
      list: async () => [],
      run: async () => ({ ok: true, runId: 'wf-1' }),
      status: async () => ({ ok: true, state: 'done', stages: [] }),
      ...(overrides['workflows'] as Record<string, unknown> | undefined),
    },
  };
}

/** 把卡片自己的 HTML 摆进 DOM（**卡片一 import 就读元素** ✓） */
function mountCard(): void {
  const html = readFileSync(join(CARD_DIR, 'index.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html);
  document.body.innerHTML = (body?.[1] ?? '').replace(/<script[\s\S]*?<\/script>/g, '');
}

/** 卡片模块**只装一次** ✓（模块级状态 ✓ —— 每次 import 同一个实例 ✓） */
let loaded: Promise<unknown> | null = null;
async function loadCard(): Promise<void> {
  if (loaded === null) loaded = import('../../cards/build-deploy/card.js');
  await loaded;
}

const FLOWS = [
  {
    id: 'hello-kernel.build-run',
    name: '编译内核模块 → 直传板子',
    version: '1.0.0',
    approved: true,
    inputs: {
      build_dir: { type: 'path', required: true, description: '构建机上的工程根目录' },
      project: { type: 'string', required: true },
    },
  },
];

beforeEach(() => {
  mountCard();
  // **模块缓存要清** ✓ —— 卡片在**模块级**抓住了那几个元素 ✓
  // → 不清的话，第二个用例拿到的是**上一轮那个 DOM** ✗ → 测的不是这张卡 ✗
  vi.resetModules();
  loaded = null;
});

describe('「编译上板」那张卡', () => {
  it('**流程清单来自宿主** ✓（**没批过的看不见** ✓）', async () => {
    installCockpit({ workflows: { list: async () => FLOWS } });
    await loadCard();
    const select = document.getElementById('flow') as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(select.options[0]?.value).toBe('hello-kernel.build-run');
  });

  it('**输入按流程声明渲染** ✓（**卡片不自己发明参数** ✓）', async () => {
    installCockpit({ workflows: { list: async () => FLOWS } });
    await loadCard();
    const inputs = document.querySelectorAll('input[data-name]');
    expect([...inputs].map((el) => (el as HTMLInputElement).dataset.name)).toEqual([
      'build_dir',
      'project',
    ]);
  });

  it('**必填没填就不跑** ✓（**不把空参数发给宿主** ✓）', async () => {
    const run = vi.fn(async () => ({ ok: true, runId: 'wf-1' }));
    installCockpit({ workflows: { list: async () => FLOWS, run } });
    await loadCard();
    (document.getElementById('run') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(document.getElementById('note')?.textContent).toContain('build_dir');
  });

  it('**点一下就调 `workflows.run`** ✓（**带上输入** ✓）', async () => {
    const run = vi.fn(async () => ({ ok: true, runId: 'wf-1' }));
    installCockpit({ workflows: { list: async () => FLOWS, run } });
    await loadCard();
    const inputs = document.querySelectorAll('input[data-name]');
    (inputs[0] as HTMLInputElement).value = '/home/me/src';
    (inputs[1] as HTMLInputElement).value = 'hello';
    (document.getElementById('run') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledWith('hello-kernel.build-run', {
      build_dir: '/home/me/src',
      project: 'hello',
    });
  });

  it('**没被授权就说没被授权** ✓（**不装作跑起来了** ✗）', async () => {
    installCockpit({
      workflows: {
        list: async () => FLOWS,
        run: async () => ({ ok: false, reason: 'denied' }),
      },
    });
    await loadCard();
    const inputs = document.querySelectorAll('input[data-name]');
    (inputs[0] as HTMLInputElement).value = '/home/me/src';
    (inputs[1] as HTMLInputElement).value = 'hello';
    (document.getElementById('run') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById('note')?.textContent).toContain('没有被授权');
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
            { stepId: 'deliver', kind: 'file.transfer', ok: true, verified: false },
          ],
        }),
      },
    });
    await loadCard();
    const inputs = document.querySelectorAll('input[data-name]');
    (inputs[0] as HTMLInputElement).value = '/home/me/src';
    (inputs[1] as HTMLInputElement).value = 'hello';
    (document.getElementById('run') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const steps = document.querySelectorAll('.deck__step');
    expect(steps.length).toBe(2);
    // **验过的** ✓ 与 **没验过的** ✓ —— **两种样子** ✓
    expect(steps[0]?.className).toContain('deck__step--ok');
    expect(steps[1]?.className).toContain('deck__step--warn');
  });

  it('**没有流程就说没有** ✓（**不装成「有」** ✓）', async () => {
    installCockpit({ workflows: { list: async () => [] } });
    await loadCard();
    expect(document.getElementById('note')?.textContent).toContain('没有可跑的流程');
  });
});
