import type { ConnectionInfo } from '../../../shared/ipc-contract';
import type { TerminalTab } from '../types';
import { TerminalView } from '../../terminal/TerminalView';
import type { XtermTheme } from '../theme';
import { TerminalIcon } from '../Icons';

/**
 * The terminal page: the terminal, full screen.
 *
 * ── every session stays mounted ──
 *
 * xterm has no `serialize()`, so unmounting a terminal **destroys its
 * scrollback**. Every session has its own `TerminalView`, and the inactive
 * ones are hidden with `display: none` (not `visibility: hidden`, which
 * would keep them laid out and let them report a size).
 */
export function TerminalPage({
  sessions,
  activeSessionId,
  xtermTheme,
  terminalSubscribe,
  onTerminalWrite,
  onTerminalResize,
}: {
  sessions: TerminalTab[];
  activeSessionId: string | null;
  xtermTheme: XtermTheme;
  terminalSubscribe: (sessionId: string) => (cb: (chunk: string) => void) => () => void;
  onTerminalWrite: (sessionId: string, data: string) => void;
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void;
}): JSX.Element {
  if (sessions.length === 0) {
    return (
      <div className="page page--terminal">
        <header className="page-head">
          <div className="page-head__text">
            <span className="page-head__eyebrow">TERMINAL</span>
            <h1 className="page-head__title">终端</h1>
            <p className="page-head__sub">串口 / ADB / SSH / 本机 · 每条连接一个会话</p>
          </div>
        </header>
        <div className="page-empty">
          <span className="page-empty__icon" aria-hidden>
            <TerminalIcon size={26} />
          </span>
          <h2>还没有终端会话</h2>
          <p>左边「连接方式」里点一个连接就能开——会话会一直留着，切回来不丢历史。</p>
        </div>
      </div>
    );
  }
  return (
    <div className="page page--terminal">
      {sessions.map((session) => {
        const isActive = session.sessionId === activeSessionId;
        return (
          <div
            key={session.sessionId}
            className="terminal__pane"
            data-testid={`terminal-pane-${session.sessionId}`}
            // **display:none**（不是 visibility）→ 隐藏的会话不报尺寸
            hidden={!isActive}
          >
            <TerminalView
              sessionId={session.sessionId}
              subscribe={terminalSubscribe(session.sessionId)}
              onWrite={(data) => onTerminalWrite(session.sessionId, data)}
              onResize={(cols, rows) => onTerminalResize(session.sessionId, cols, rows)}
              theme={xtermTheme}
              active={isActive}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The connection a session belongs to (for the page header). */
export function sessionConnection(
  session: TerminalTab,
  connections: ConnectionInfo[],
): ConnectionInfo | null {
  return connections.find((connection) => connection.id === session.profileId) ?? null;
}
