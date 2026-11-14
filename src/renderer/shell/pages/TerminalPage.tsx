import type { ConnectionInfo } from '../../../shared/ipc-contract';
import type { TerminalTab } from '../types';
import { TerminalView } from '../../terminal/TerminalView';
import type { XtermTheme } from '../theme';

/**
 * The terminal page: the terminal, full screen.
 *
 * ── every session stays mounted ──
 *
 * xterm has no `serialize()`, so unmounting a terminal **destroys its
 * scrollback**. The old shell kept all terminals mounted and hid the
 * inactive ones; the bottom dock only ever rendered the active one, so
 * switching tabs lost the history.
 *
 * → Here every session has its own `TerminalView`, and the inactive ones
 * are hidden with `display: none` (not `visibility: hidden`, which would
 * keep them laid out and let them report a size).
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
      <div className="page page--terminal is-empty">
        <p className="terminal__empty">
          还没有终端会话。左边「连接方式」里点一个连接就能开。
        </p>
      </div>
    );
  }
  return (
    <div className="page page--terminal">
      {sessions.map((session) => {
        const active = session.sessionId === activeSessionId;
        return (
          <div
            key={session.sessionId}
            className="terminal__pane"
            data-testid={`terminal-pane-${session.sessionId}`}
            // **display:none**（不是 visibility）→ 隐藏的会话不报尺寸
            hidden={!active}
          >
            <TerminalView
              sessionId={session.sessionId}
              subscribe={terminalSubscribe(session.sessionId)}
              onWrite={(data) => onTerminalWrite(session.sessionId, data)}
              onResize={(cols, rows) => onTerminalResize(session.sessionId, cols, rows)}
              theme={xtermTheme}
              active={active}
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
