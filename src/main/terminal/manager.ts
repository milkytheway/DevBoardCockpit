import { randomUUID } from 'node:crypto';
import { makeError } from '../../shared/errors';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import type { Connection } from '../hal/connection';
import { capabilitiesFor } from '../hal/capabilities';
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
  /**
   * 按 profile 造一个连接。
   *
   * **日志由 manager 造好传进来**——一个会话一份日志，
   * 连接那份与会话那份必须是**同一个文件**：
   * 输入（`Session.record`）与输出（manager 的 `onData`）得在同一处。
   * 之前两边各造一份，标签还一样，于是**一次会话落两个文件**，
   * 连接那份永远没有收尾行。
   */
  createConnection(profile: ConnectionProfile, log: SessionLog): Connection;
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
  /**
   * **这条会话连的是哪个 profile** ✓。
   *
   * → 它答的是「**这条配置现在有活连接吗**」✓（契约 `spec/04` §2.1 的 `connected` ✓）。
   * → **按 sessionId 索引会话，按 profileId 索引「谁连着」** ✓ —— 两个不同的问法 ✓
   *   （同一个 profile 可以开两个标签 ✓ —— 按 profileId 索引**会话**会撞 ✓ —— 那个坑踩过 ✓）。
   */
  profileId: string;
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

  /** 收掉一个会话的日志：断开 → （远端自己退出的话）断流 → 收尾 */
  private closeLog(sessionId: string, remoteExited: boolean): void {
    const log = this.logs.get(sessionId);
    if (!log) return;
    // 顺序与黄金样本一致：
    //   --- disconnected --- → --- stream-ended --- → === session closed ===
    log.writeEvent('disconnected');
    if (remoteExited) log.writeEvent('stream-ended');
    log.close();
    this.logs.delete(sessionId);
  }

  /** 打开一个会话。找不到 profile 就报 TERM_NOT_FOUND */
  async open(profileId: string): Promise<{ sessionId: string }> {
    const profile = this.opts.listProfiles().find((p) => p.id === profileId);
    if (!profile) {
      throw makeError('TERM_NOT_FOUND', `找不到连接 ${profileId}`, {
        detail: { profileId },
      });
    }

    const id = randomUUID();
    // 会话日志：**一个会话一份**（同 profile 的两个标签要分得开），
    // 而且连接与会话**共用这一份**——输入与输出得在同一处。
    const log = this.logFor(id, profileId, profile.transport);

    let connection: Connection;
    try {
      connection = this.opts.createConnection(profile, log);
      await connection.open();
    } catch (err) {
      // 连不上：日志不能留一个没有收尾的半截
      this.closeLog(id, false);
      throw err;
    }

    let session: Session;
    try {
      session = await connection.openSession({ cols: 80, rows: 24 });
    } catch (err) {
      // 开不出会话就把连接收掉——否则 ssh 客户端与 socket 永久挂着，
      // 而且连接没进 Map，没有任何东西能回收它。
      await connection.close().catch(() => undefined);
      this.closeLog(id, false);
      throw err;
    }
    // **终端模式由 profile 决定**，不是由传输名决定。
    //
    // 这里曾经有个**两个能力位来源互相矛盾**的 bug：
    // `connection.capabilities().pty` 报的是**传输的常量**（serial=true / adb=false / …），
    // 看都不看 profile；而 UI 侧的 `connections:list` 用的是 profile 感知的
    // `capabilitiesFor(profile)`。用户把 profile 的 `pty` 改成 false，
    // UI 报 false、运行时仍按 true 走，
    // 于是宿主不做行编辑也不回显，用户打的字一个都看不见，
    // 回车原样发成 `\r`，远端永远等不到行尾。
    //
    // **当时的绕法**：这里直接调 `capabilitiesFor(profile)`，绕开连接对象。
    // **2026-11-13 的修法**：连接对象自己也调 `capabilitiesFor(profile)`
    // （`Connection.capabilities()` 不再报传输常量），
    // **矛盾本身没了**，这里仍然调同一个函数是为了让「唯一实现」名副其实。
    const pty = capabilitiesFor(profile).pty;

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
      this.closeSession(id, exitCode, true);
    });

    // pipe 模式：远端不发提示符，宿主画（profile 的 `options.prompt`）
    const prompt = typeof profile.options['prompt'] === 'string' ? profile.options['prompt'] : '';
    const editor = new PipeInput(prompt);
    this.sessions.set(id, { id, profileId: profile.id, session, connection, pty, editor });
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

  /**
   * 关掉一个会话。
   *
   * **要等连接真的关掉再返回**：串口的 `close()` 是异步的（等 `port.close()` 回调），
   * 不等就返回的话，用户「关标签 → 马上重开」会撞 `PORT_BUSY`——
   * 而他刚关掉标签，那个「端口被占用」会让人以为端口被别人占了。
   */
  async close(sessionId: string): Promise<void> {
    await this.closeSession(sessionId, this.sessions.get(sessionId)?.session.exitCode ?? null, false);
  }

  /**
   * 收掉一个会话。
   *
   * 两条路径会走到这里：用户点关闭按钮、远端自己退出了。
   * 重复调用无害——会话从 map 里删掉后第二次就直接返回。
   */
  private async closeSession(
    sessionId: string,
    exitCode: number | null,
    remoteExited: boolean,
  ): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    // 会话先关：SSH 会把 decoder 里那半个字符 flush 出来——
    // 它得落在 `=== session closed ===` **之前**。
    live.session.close();
    await live.connection.close().catch(() => undefined);
    this.sessions.delete(sessionId);
    // 连接也要注销——否则按 id 找连接会拿到一个已关闭的
    this.opts.onConnectionClose?.(sessionId);
    // 断开与收尾也要进日志——事后要能看出「这个会话是怎么结束的」
    this.closeLog(sessionId, remoteExited);
    for (const cb of this.exitCbs) cb(sessionId, exitCode);
  }

  onData(cb: (sessionId: string, chunk: string) => void): void {
    this.dataCbs.push(cb);
  }

  /**
   * **现在有活连接的那些 profile id** ✓。
   *
   * → 这是「**这条配置现在有活连接吗**」的答案 ✓（契约 `spec/04` §2.1 的 `connected` ✓）。
   * → **同一个 profile 开多个标签只出现一次** ✓ —— 问的是「有哪些 profile 连着」✓
   *   不是「有几个会话」✓。
   * → **关掉一个标签 → 另一个还在 → profile 还在** ✓。
   *
   * → **为什么需要它** ✓：宿主侧**没有连接 registry** ✓ ——
   *   `main/index.ts` 的 `connections` Map 按 **sessionId** 索引 ✓（给文件互传用 ✓），
   *   **按 profileId 索引会话会撞** ✓（同一个 profile 开两个标签 ✓）。
   */
  liveProfileIds(): string[] {
    const ids = new Set<string>();
    for (const live of this.sessions.values()) ids.add(live.profileId);
    return [...ids];
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
