import { createRequire } from 'node:module';
import { Session } from '../hal/session';
import type { SessionLog } from '../logging/session-log';

/**
 * 本机的 pty 会话。
 *
 * `node-pty` 是**原生模块**，要针对 Electron 的 ABI 重编译
 * （ADR-D11：`electron-rebuild` 固化进 `postinstall`）。
 * 这是全工程第一个 ABI 风险点——`docs/04-架构设计.md` §14 把它列为第一风险。
 *
 * 加载失败时不静默降级：原生模块没编好就跑不起来，
 * 那种「终端不显示」的错最难查。
 */

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; env: Record<string, string>; cwd?: string },
  ): {
    onData(cb: (data: string) => void): void;
    onExit(cb: (exitCode: number) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
  };
}

let ptyModule: PtyModule | undefined;

/**
 * 加载 node-pty。
 *
 * 用 `createRequire` 而不是裸 `require`：构建产物是 ESM
 * （package.json 有 `"type": "module"`），裸 `require` 在 ESM 里不存在。
 */
function loadPty(): PtyModule {
  if (ptyModule) return ptyModule;
  const require = createRequire(import.meta.url);
  ptyModule = require('node-pty') as PtyModule;
  return ptyModule;
}

export interface LocalPtyOptions {
  cols?: number;
  rows?: number;
}

export class LocalPtySession extends Session {
  private readonly proc: ReturnType<PtyModule['spawn']>;
  private exitCodeValue: number | null = null;

  constructor(
    log: SessionLog,
    opts: LocalPtyOptions = {},
  ) {
    super(log);
    const pty = loadPty();
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    this.proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
    this.proc.onExit((code) => {
      this.exitCodeValue = code;
    });
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  write(data: string): void {
    this.proc.write(data);
    this.record(data);
  }

  onData(cb: (chunk: string) => void): void {
    this.proc.onData(cb);
  }

  /**
   * 本机 shell 退出了 → 上报。
   *
   * 没有它的话，用户在「本机」标签里敲 `exit` → powershell 退出 →
   * **界面不知道** → 标签页留着，继续打字写进一个已死的 pty。
   * （SSH 与 ADB 都有这个钩子，本机这条漏了——
   *  `docs/13-计划1复评报告.md` S-07）
   */
  onExit(cb: (exitCode: number | null) => void): void {
    this.proc.onExit((code) => {
      this.exitCodeValue = code;
      cb(code);
    });
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
  }

  close(): void {
    this.proc.kill();
  }
}

/** 给 LocalConnection 用的工厂：每次开一个新 pty 会话 */
export function createLocalPtySession(log: SessionLog, opts: LocalPtyOptions = {}): Session {
  return new LocalPtySession(log, opts);
}
