import { randomUUID } from 'node:crypto';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import type { Connection } from '../hal/connection';
import type { Session } from '../hal/session';
import { PipeInput } from './line-editor';

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
  /**
   * 造一个会话日志。
   *
   * **一个会话一份**（不是一份 profile 一份）——
   * 同一个 profile 开两个标签，两个会话的对话必须分得开。
   */
  createLog(label: string, transport: string): SessionLog;
  /** 连接建好后的通知。文件互传等模块靠它拿到「按 id 找连接」的入口 */
  onConnectionOpen?: (sessionId: string, connection: Connection) => void;
  /** 连接关掉后的通知。否则 connections Map 里会留下已关闭的连接 */
  onConnectionClose?: (sessionId: string) => void;
}

interface LiveSession {
  id: string;
  session: Session;
  connection: Connection;
  pty: boolean;
  /** pipe 模式的行编辑层。每个会话一份（各会话的输入行互不相干） */
  editor: PipeInput;
}

export class TerminalManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly dataCbs: ((sessionId: string, chunk: string) => void)[] = [];
  private readonly exitCbs: ((sessionId: string, exitCode: number | null) => void)[] = [];
  private readonly logs = new Map<string, SessionLog>();

  constructor(private readonly opts: TerminalManagerOptions) {}

  /** 每个会话一份日志（按 sessionId 索引，不按 profile） */
  private logFor(sessionId: string, label: string, transport: string): SessionLog {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = this.opts.createLog(label, transport);
      this.logs.set(sessionId, log);
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

    let session: Session;
    try {
      session = await connection.openSession({ cols: 80, rows: 24 });
    } catch (err) {
      // 开不出会话就把连接收掉——否则 ssh 客户端与 socket 永久挂着，
      // 而且连接没进 Map，没有任何东西能回收它。
      await connection.close().catch(() => undefined);
      throw err;
    }
    const id = randomUUID();
    const pty = connection.capabilities().pty;

    // 会话日志：**一个会话一份**（同 profile 的两个标签要分得开）
    const log = this.logFor(id, profileId, connection.transport);
    // 开场事件行。格式与黄金样本同构（旧工程也写这几行）
    log.writeEvent('connected', profileId);

    session.onData((chunk: string) => {
      // 远端输出也要记进日志——事实 G4：「崩溃/重启/关窗都不能丢记录」。
      // 只记输入不记输出，事后复盘就只剩半截对话。
      log.write(chunk);
      for (const cb of this.dataCbs) cb(id, chunk);
    });

    // 远端自己退出了（敲 exit / 拔线 / adbd 断连）→ 收掉会话并通知界面。
    // 没有这条，界面留着标签页，用户继续往死通道里打字。
    session.onExit((exitCode: number | null) => {
      log.writeEvent('stream-ended');
      this.closeSession(id, exitCode);
    });

    // pipe 模式：远端不发提示符，宿主画（profile 的 `options.prompt`）
    const prompt = typeof profile.options['prompt'] === 'string' ? profile.options['prompt'] : '';
    const editor = new PipeInput(prompt);
    this.sessions.set(id, { id, session, connection, pty, editor });
    // **按 sessionId 登记**：一个标签一个连接。
    // 按 profileId 登记的话，同一个 profile 开两个标签会互相覆盖。
    this.opts.onConnectionOpen?.(id, connection);

    // pipe 模式的第一条提示符
    if (!pty && prompt.length > 0) {
      for (const cb of this.dataCbs) cb(id, prompt);
    }
    return { sessionId: id };
  }

  write(sessionId: string, data: string): void {
    const live = this.require(sessionId);

    if (live.pty) {
      // pty 模式：远端有真终端（getty / sshd），行规程与回显都在那边。
      // 宿主**只转发**，多回显一次用户就看到两行字。
      live.session.write(data);
      return;
    }

    // pipe 模式：远端没有行规程——宿主做行编辑并回显。
    // 回车必须译成 LF 发过去，否则远端 shell 永远等不到行尾
    // （`docs/11-计划1评审报告.md` R-01 的真机实测）。
    const edit = live.editor.input(data);
    if (edit.toRemote.length > 0) live.session.write(edit.toRemote);
    if (edit.echo.length > 0) {
      for (const cb of this.dataCbs) cb(sessionId, edit.echo);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.require(sessionId).session.resize(cols, rows);
  }

  close(sessionId: string): void {
    this.closeSession(sessionId, this.sessions.get(sessionId)?.session.exitCode ?? null);
  }

  /**
   * 收掉一个会话。
   *
   * 两条路径会走到这里：用户点关闭按钮、远端自己退出了。
   * 重复调用无害——会话从 map 里删掉后第二次就直接返回。
   */
  private closeSession(sessionId: string, exitCode: number | null): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    // 断开与收尾也要进日志——事后要能看出「这个会话是怎么结束的」
    this.logs.get(sessionId)?.writeEvent('disconnected');
    this.logs.get(sessionId)?.close();
    this.logs.delete(sessionId);
    live.session.close();
    void live.connection.close();
    this.sessions.delete(sessionId);
    // 连接也要注销——否则按 id 找连接会拿到一个已关闭的
    this.opts.onConnectionClose?.(sessionId);
    for (const cb of this.exitCbs) cb(sessionId, exitCode);
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
