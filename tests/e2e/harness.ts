import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 在**真 Electron** 里跑测试的外壳。
 *
 * ── 为什么不用浏览器模式 ──
 *
 * 这个产品的三条边界（自定义协议、preload、跨进程）**只在 Electron 里存在**。
 * 浏览器模式测出来的「通过」，跟产品真正的边界没关系。
 *
 * ── Linux 沙箱里的显示问题 ──
 *
 * 沙箱没有显示器。`DISPLAY` 没设时**自己起一个 Xvfb**
 * （与 `scripts/acceptance/run-app.sh` 同一套办法）。
 * 宿主（Windows）上有显示器，这一支不会走。
 */

/** 仓库根（测试从仓库根跑） */
const REPO_ROOT = resolve(process.cwd());

export interface Launched {
  app: ElectronApplication;
  window: Page;
  /** 这次运行的 userData 目录（测试往这里放卡片） */
  userDataDir: string;
  /** 收摊：关应用 + 关 Xvfb */
  close: () => Promise<void>;
}

/**
 * Linux 上没有显示器就起一个 Xvfb。
 *
 * @returns 进程（已经 set 了 `process.env.DISPLAY`）
 */
function ensureDisplay(): ChildProcess | undefined {
  if (process.platform !== 'linux') return undefined;
  if (process.env['DISPLAY'] !== undefined && process.env['DISPLAY'] !== '') return undefined;

  const display = `:${90 + Math.floor(Math.random() * 20)}`;
  const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
  proc.unref();
  process.env['DISPLAY'] = display;
  return proc;
}

/** 等 Xvfb 的 socket 出来 */
async function waitForDisplay(display: string): Promise<void> {
  const socket = `/tmp/.X11-unix/X${display.replace(':', '')}`;
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(socket)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Xvfb ${display} 没起来（${socket} 不存在）`);
}

/**
 * 起一次应用。
 *
 * @param opts.executablePath Electron 二进制。默认用 `node_modules/electron`；
 *   Linux 沙箱里没有 npm 版的 Linux 二进制，用 `ELECTRON_BIN` 指过去
 *   （与 `scripts/acceptance/run-app.sh` 同一个环境变量）。
 */
export async function launchApp(
  opts: { executablePath?: string } = {},
): Promise<Launched> {
  const xvfb = ensureDisplay();
  if (xvfb !== undefined) await waitForDisplay(process.env['DISPLAY'] as string);

  const mainEntry = join(REPO_ROOT, 'out', 'main', 'index.js');
  if (!existsSync(mainEntry)) {
    throw new Error(`找不到构建产物：${mainEntry} —— 先跑 npm run build`);
  }

  const app = await electron.launch({
    args: [mainEntry],
    ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
    env: { ...process.env },
  });
  const window = await app.firstWindow();
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

  return {
    app,
    window,
    userDataDir,
    close: async () => {
      await app.close().catch(() => undefined);
      xvfb?.kill();
    },
  };
}

/** 卡片目录在 userData 下的位置 */
export function cardDir(userDataDir: string, cardId: string): string {
  return join(userDataDir, 'cards', cardId);
}

/**
 * 往 userData 里写一张卡。
 *
 * **写 userData，不写仓库**——测试不该在仓库里留垃圾。
 */
export async function writeCard(
  userDataDir: string,
  cardId: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = cardDir(userDataDir, cardId);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

/** 一张最小的只读卡（读 cpu.usage） */
export function simpleCard(): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(
      {
        apiVersion: 'devboard/v1',
        kind: 'Card',
        id: 'e2e-card',
        name: 'E2E 卡',
        version: '1.0.0',
        entry: 'index.html',
        requires: { tags: ['cpu.usage'] },
        permissions: { read: ['cpu.usage'], write: [] },
      },
      null,
      2,
    ),
    'index.html':
      '<!doctype html><meta charset="utf-8"><body>ok<script type="module" src="./card.js"></script>',
    'card.js':
      "document.title = 'e2e-card';\n" +
      "const el = document.createElement('div');\n" +
      "el.id = 'value';\n" +
      "document.body.appendChild(el);\n" +
      "cockpit.tags.subscribe('cpu.usage', (v) => { el.textContent = String(v.value); });\n",
  };
}
