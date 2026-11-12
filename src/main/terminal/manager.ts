import { randomUUID } from 'node:crypto';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import type { Connection } from '../hal/connection';
import type { Session } from '../hal/session';

/**
 * 终端会话的生命周期。
 *
 * 一个会话 = 一个连接实例上的一个交互式会话。
 * 宿主这边只做三件事：转发按键、转发输出、记日志。
 *
 * **回显的责任在谁**（legacy 的两种终端模式）：
 *
 * - **pty 模式**（ssh、`adb shell -t`）：远端提供真终端，自己回显、自己出 ANSI。
 *   宿主**只转发按键**，不多回显一遍——多回显一次用户就看到两行字。
 * - **pipe 模式**（`adb shell` 无 PTY、串口）：远端**不回显**。
 *   所以宿主把用户输入**也写进数据通道**，用户才看得到自己打的字。
 *
 * 这条分界必须在**能力位**上判断，不能靠传输名——
 * 旧工程就是靠传输名推断的，新注册的传输就被当成了真终端（见 `connection.ts`）。
 */

export interface TerminalManagerOptions {
  /** 列出可用的连接 profile（按 id 查） */
  listProfiles(): ConnectionProfile[];
  /** 按 profile 造一个连接 */
  createConnection(profile: ConnectionProfile): Connection;
  /** 造一个会话日志 */
  createLog(label: string): SessionLog;
  /** 连接建好后的通知。文件互传等模块靠它拿到「按 id 找连接」的入口 */
  onConnectionOpen?: (connectionId: string, connection: Connection) => void;
}

interface LiveSession {
  id: string;
  session: Session;
  connection: Connection;
  pty: boolean;
}

export class TerminalManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly dataCbs: ((sessionId: string, chunk: string) => void)[] = [];
  private readonly exitCbs: ((sessionId: string, exitCode: number | null) => void)[] = [];
  private readonly logs = new Map<string, SessionLog>();

  constructor(private readonly opts: TerminalManagerOptions) {}

  /** 每个连接一个会话日志 */
  private logFor(profileId: string): SessionLog {
    let log = this.logs.get(profileId);
    if (!log) {
      log = this.opts.createLog(profileId);
      this.logs.set(profileId, log);
    }
    return log;
  }

  /** 打开一个会话。找不到 profile 就报 TERM_NOT_FOUND */
  async open(profileId: string): Promise<{ sessionId: string }> {
    const profile = this.opts.listProfiles().find((p) => p.id === profileId);
    if (!profile) {
      throw makeError('TERM_NOT_FOUND', `找不到连接 ${profileId}`, {
        detail: { profileId },
      });
    }

    const connection = this.opts.createConnection(profile);
    await connection.open();

    const session = await connection.openSession({ cols: 80, rows: 24 });
    const id = randomUUID();
    const pty = connection.capabilities().pty;

    session.onData((chunk: string) => {
      // 远端输出也要记进日志——事实 G4：「崩溃/重启/关窗都不能丢记录」。
      // 只记输入不记输出，事后复盘就只剩半截对话。
      this.logFor(profileId).write(chunk);
      for (const cb of this.dataCbs) cb(id, chunk);
    });

    this.sessions.set(id, { id, session, connection, pty });
    this.opts.onConnectionOpen?.(profileId, connection);
    return { sessionId: id };
  }

  write(sessionId: string, data: string): void {
    const live = this.require(sessionId);
    live.session.write(data);

    // pipe 模式：远端不回显，宿主把输入也送进数据通道
    if (!live.pty) {
      for (const cb of this.dataCbs) cb(sessionId, data);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.require(sessionId).session.resize(cols, rows);
  }

  close(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    live.session.close();
    void live.connection.close();
    this.sessions.delete(sessionId);
    for (const cb of this.exitCbs) cb(sessionId, live.session.exitCode);
  }

  onData(cb: (sessionId: string, chunk: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (sessionId: string, exitCode: number | null) => void): void {
    this.exitCbs.push(cb);
  }

  private require(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) {
      throw makeError('TERM_NOT_FOUND', `会话不存在 ${sessionId}`, { detail: { sessionId } });
    }
    return live;
  }
}
