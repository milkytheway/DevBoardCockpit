import { join } from 'node:path';
import type { ConnectionProfile } from '../profiles/schema';
import { createConnection } from '../hal/registry';
import { loadSettings, resolveAdbPath } from '../util/settings';
import { SessionLog } from '../logging/session-log';
import { runWizard, type WizardDeps, type WizardResult } from './run';

/**
 * **向导在 main 侧的接线** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 为什么单独一个文件（**而不是塞进 `index.ts`** ✓）──
 *
 * → `index.ts` 已经是**一千行的接线板** ✓ → 再往里塞向导的细节 = 继续长 ✓
 * → **这一块有它自己的依赖** ✓（会话日志 ✓ · 连接工厂 ✓ · 两个目录 ✓）→
 *   → **收在这里** ✓ → `index.ts` 只调一个函数 ✓。
 *
 * ── ⚠️ **它会写用户的目录** ✓ ──
 *
 * → 落**连接 profile** ✓（用户数据目录 ✓ · `userProfilesDir()` ✓）
 * → 落**板型包** ✓（用户数据目录 ✓ · `userBoardsDir()` ✓）
 * → **所以它是宿主专用** ✓ —— **卡片与 agent 都拿不到** ✓（IPC 契约 ✓）。
 */

/** 接线的依赖（**可注入** ✓ —— 好测 ✓） */
export interface WizardWiringOptions {
  /** 应用根目录（**内置包在这儿** ✓） */
  appRoot: string;
  /** 用户连接 profile 目录 ✓ */
  userProfilesDir: string;
  /** 用户板型包目录 ✓ */
  userBoardsDir: string;
  /** 用户数据目录（**会话日志在这儿** ✓） */
  userDataDir: string;
  /** 建连接 ✓（**默认用真的** ✓） */
  createConnection?: (profile: ConnectionProfile, log: SessionLog) => ReturnType<typeof createConnection>;
  /** 建会话日志 ✓ */
  createLog?: (label: string, transport: string) => SessionLog;
}

/** 一次向导的依赖 ✓ */
export function wizardDeps(opts: WizardWiringOptions): WizardDeps {
  const settings = loadSettings(join(opts.appRoot, 'profiles', 'settings.json'));
  const adbPath = resolveAdbPath(settings);
  return {
    createConnection:
      opts.createConnection ??
      ((profile, log) => createConnection(profile, log, { adbPath })),
    createLog:
      opts.createLog ??
      ((label, transport) =>
        new SessionLog({
          label,
          transport,
          dataDir: opts.userDataDir,
        })),
    genericPackDir: join(opts.appRoot, 'profiles', 'boards', 'generic-linux'),
    boardsRoot: opts.userBoardsDir,
    profilesRoot: opts.userProfilesDir,
  };
}

/**
 * **跑一次向导** ✓ —— 返回给界面的话 ✓。
 *
 * → **四种结果** ✓ —— **它们是不同的故障** ✓（见 `WizardRunResult` ✓）。
 */
export async function runWizardForHost(
  input: { port: string; baudrate: number; boardName: string; transport?: 'serial' | 'adb' },
  opts: WizardWiringOptions,
): Promise<{
  ok: boolean;
  kind: 'ok' | 'port-unopenable' | 'no-reply' | 'connection-dead';
  message: string;
  hints: string[];
  greenCount: number;
  redCount: number;
  installedDir?: string;
  boardId?: string;
}> {
  let result: WizardResult;
  try {
    result = await runWizard(input, wizardDeps(opts));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: 'no-reply',
      message: `**向导没跑完** ✓ —— ${message}`,
      hints: [],
      greenCount: 0,
      redCount: 0,
    };
  }

  const greenCount = result.reports?.filter((r) => r.ok).length ?? 0;
  const redCount = result.reports?.filter((r) => !r.ok).length ?? 0;

  return {
    ok: result.ok,
    kind: result.ok
      ? 'ok'
      : result.firstTruth.kind === 'port-unopenable'
        ? 'port-unopenable'
        : 'no-reply',
    message: result.message,
    // **传输层的 hint 排第一** ✓（**它说的是最准的那条** ✓ —— 串口知道「回包被吃了」✓）
    hints: result.hint !== undefined ? [result.hint] : [],
    greenCount,
    redCount,
    ...(result.installedDir !== undefined ? { installedDir: result.installedDir } : {}),
    ...(result.installedDir !== undefined
      ? { boardId: result.installedDir.split(/[\\/]/).pop() }
      : {}),
  };
}
