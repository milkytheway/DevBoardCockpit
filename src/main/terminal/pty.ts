import { createRequire } from 'node:module';
import { Session } from '../hal/session';
import type { SessionLog } from '../logging/session-log';

/**
 * The pty session of the local machine.
 *
 * `node-pty` is a native module, but it is an NAPI one → the ABI is stable,
 * and the prebuilds shipped with the package work across Node and Electron
 * versions, so there is no need to recompile it for Electron
 * (`scripts/ensure-native.mjs`: it only compiles when the module cannot be
 * loaded).
 * (⚠️ Linux has no prebuild for node-pty → the Linux side still needs a
 * compiler.)
 *
 * It does not degrade silently when the load fails: without a properly built
 * native module it simply does not run, and that kind of "the terminal does
 * not show up" bug is the hardest to track down.
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
 * Loads node-pty.
 *
 * It uses `createRequire` instead of a bare `require`: the build output is
 * ESM (package.json has `"type": "module"`), and a bare `require` does not
 * exist in ESM.
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
   * The local shell exited → report it.
   *
   * Without this, the user types `exit` in the "local" tab → powershell
   * exits → the interface does not know → the tab stays open and the
   * following typing goes into a dead pty.
   * (SSH and ADB both have this hook, the local one was missing —
   * plan-1 re-review, finding S-07)
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

/** The factory for LocalConnection: opens a new pty session every time */
export function createLocalPtySession(log: SessionLog, opts: LocalPtyOptions = {}): Session {
  return new LocalPtySession(log, opts);
}
