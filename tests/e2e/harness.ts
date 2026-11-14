import { _electron as electron, type ElectronApplication, type Frame, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  /** 收摊：关应用 + 关 Xvfb + 删临时目录 */
  close: () => Promise<void>;
}

/** 应用的用户数据目录名（与 `src/main/util/paths.ts` 的 DEFAULT_APP 同一个） */
const APP_NAME = 'DevBoardCockpit';

/**
 * **整个测试进程共用**的 Xvfb。
 *
 * ── 为什么不能每个测试各起各的 ──
 *
 * 第一个测试起 Xvfb，后面的测试看到 `DISPLAY` 已经设了就**不再起**——
 * 但如果第一个测试的 `close()` 把它杀了，**后面的测试就没有显示器了**：
 * Electron 会以 `The platform failed to initialize` + SIGSEGV 挂掉。
 *
 * → Xvfb **起一次，用到进程退出**（`process.on('exit')` 收摊）。
 */
let sharedXvfb: ChildProcess | undefined;

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
  sharedXvfb = proc;
  // **进程退出时收摊**（不是每个测试结束时——后面的测试还要用它）
  process.on('exit', () => {
    try {
      sharedXvfb?.kill();
    } catch {
      // 已经退了
    }
  });
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

  /**
   * **两边说的「用户数据目录」必须是同一个地方。**
   *
   * 宿主侧算的是 `src/main/util/paths.ts` 的 `userDataDir()`：
   * Linux 是 `$XDG_DATA_HOME/DevBoardCockpit`，Windows 是 `%LOCALAPPDATA%\DevBoardCockpit`。
   * 而 Electron 的 `app.getPath('userData')` 默认是 `%APPDATA%\DevBoardCockpit`（**漫游目录**）。
   *
   * → **不是一个地方**。测试把卡写进 Electron 那个，应用却去另一个里找 →
   * **卡片区永远是空的** → 十条隔离判据全是「红」，而红的原因是**环境**。
   *
   * 顺带解决一件事：e2e **不再往用户真实的用户数据目录里写东西**。
   */
  const root = mkdtempSync(join(tmpdir(), 'cockpit-e2e-'));
  const userDataDir = join(root, APP_NAME);
  mkdirSync(userDataDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === 'win32') {
    env['LOCALAPPDATA'] = root;
  } else {
    env['XDG_DATA_HOME'] = root;
  }

  // **Electron 二进制**：默认用 node_modules 里那个；
  // Linux 沙箱里那个是 win32 的 → 用 `ELECTRON_BIN` 指过去
  // （与 `scripts/acceptance/run-app.sh` 同一个环境变量）。
  const executablePath = opts.executablePath ?? process.env['ELECTRON_BIN'];
  const app = await electron.launch({
    // **用「应用根」启动**（`electron .`），不是 `electron out/main/index.js`
    //
    // 两者的 `app.getAppPath()` 不同：前者 = 应用根，**内置卡的根就在那儿**
    // （`join(app.getAppPath(), 'cards')`）；后者 = 脚本所在目录 → **内置卡找不到**。
    // → e2e 测的就不是用户看到的东西了。
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    ...(executablePath !== undefined ? { executablePath } : {}),
    env,
  });
  const window = await app.firstWindow();

  return {
    app,
    window,
    userDataDir,
    close: async () => {
      await app.close().catch(() => undefined);
      // **不杀 Xvfb**——它是整个测试进程共用的（见 `ensureDisplay` 的注释）
      void xvfb;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * 找到**某张卡**的 iframe。
 *
 * ── 为什么不能靠「第一个 card frame」──
 *
 * **内置卡（`cards/cpu-usage/`）自动就在列表里**（它就在内置根下）
 * → 卡片区不止一个 iframe。
 * 而 frame 的 URL 里只有**实例 id**（`cockpit://card/<实例 id>/…`），看不出是哪张卡。
 *
 * → 先问宿主要清单（`cardsList`），用 cardId 换 instanceId，再按 URL **精确匹配** ✓
 *
 * @param cardId 卡片 id（目录名与 manifest 的 id 相同）
 */
export async function cardFrameFor(page: Page, cardId: string): Promise<Frame> {
  // ── 为什么是「重试」而不是「等一次」──
  //
  // 卡片的内容指纹进了**实例 id** → **卡片文件一变，实例 id 就变**
  // （这是「改文件即热更新」的实现方式：URL 变 → iframe 重建）。
  // 而 e2e 写卡时是**连续写几个文件** → 实例 id 会抖几下。
  //
  // → 每轮都重新读清单、重新找帧；帧要是已经被换掉（detached）就再来一轮。
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = await cardsList(page);
    const info = list.find((c) => c.cardId === cardId);
    if (info !== undefined) {
      const frame = page
        .frames()
        .find((f) => f.url().startsWith(`cockpit://card/${info.instanceId}/`));
      if (frame !== undefined && !frame.isDetached()) return frame;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`卡片 ${cardId} 的 iframe 没出现`);
}

/** 问宿主要装着的卡片清单 */
async function cardsList(page: Page): Promise<{ cardId: string; instanceId: string }[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        cockpit: { cardsList(): Promise<{ cardId: string; instanceId: string }[]> };
      }
    ).cockpit.cardsList(),
  );
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

/**
 * 一张最小的只读卡（读 cpu.usage）。
 *
 * @param cardId 卡片 id（目录名与 manifest 的 id 相同）
 * @param marker 卡片自己写在 `document.body.dataset.marker` 上的标记——
 *   **「改文件即热更新」那条判据靠它看新行为有没有生效**
 */
export function simpleCard(cardId = 'e2e-card', marker = 'v1'): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(
      {
        apiVersion: 'devboard/v1',
        kind: 'Card',
        id: cardId,
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
      `document.body.dataset.marker = ${JSON.stringify(marker)};\n` +
      "const el = document.createElement('div');\n" +
      "el.id = 'value';\n" +
      "document.body.appendChild(el);\n" +
      "cockpit.tags.subscribe('cpu.usage', (v) => { el.textContent = String(v.value); });\n",
  };
}
