import { useEffect, useState } from 'react';
import type { ConnectionInfo } from '../../../shared/ipc-contract';
import type { TerminalTab } from '../types';
import { TerminalView } from '../../terminal/TerminalView';
import type { XtermTheme } from '../theme';
import { CloseIcon, TerminalIcon } from '../Icons';

type TerminalLayout = 'single' | 'split' | 'quad';

const CAPACITY: Record<TerminalLayout, number> = { single: 1, split: 2, quad: 4 };

const LAYOUTS: { id: TerminalLayout; label: string; hint: string }[] = [
  { id: 'single', label: '单窗', hint: '一次看一个会话，其余留在左侧' },
  { id: 'split', label: '左右', hint: '两个会话并排' },
  { id: 'quad', label: '四宫', hint: '最多四个会话同时看' },
];

/**
 * The terminal page: one or more live terminals, side by side.
 *
 * ── every session stays mounted ──
 *
 * xterm has no `serialize()`, so unmounting a terminal **destroys its
 * scrollback**. Every session has its own `TerminalView`; the ones that are
 * not in the current pane set are hidden with `display: none` (not
 * `visibility: hidden`, which would keep them laid out and let them report a
 * size).
 *
 * ── panes are a view of the session list ──
 *
 * The pane set is derived state: keep the sessions that still exist, make sure
 * the active session has a pane, then fill empty panes from the rest up to the
 * layout's capacity. Clicking a session in the sidebar therefore "opens" it in
 * the focused pane instead of replacing everything.
 */
export function TerminalPage({
  sessions,
  activeSessionId,
  xtermTheme,
  terminalSubscribe,
  onTerminalWrite,
  onTerminalResize,
  onSelectSession,
  onCloseSession,
}: {
  sessions: TerminalTab[];
  activeSessionId: string | null;
  xtermTheme: XtermTheme;
  terminalSubscribe: (sessionId: string) => (cb: (chunk: string) => void) => () => void;
  onTerminalWrite: (sessionId: string, data: string) => void;
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
}): JSX.Element {
  const [layout, setLayout] = useState<TerminalLayout>('single');
  const [paneIds, setPaneIds] = useState<string[]>([]);
  const capacity = CAPACITY[layout];

  useEffect(() => {
    setPaneIds((current) => {
      const alive = current.filter((id) => sessions.some((session) => session.sessionId === id));
      const next = [...alive];
      if (activeSessionId !== null && !next.includes(activeSessionId)) {
        if (next.length < capacity) next.push(activeSessionId);
        else next[next.length - 1] = activeSessionId;
      }
      for (const session of sessions) {
        if (next.length >= capacity) break;
        if (!next.includes(session.sessionId)) next.push(session.sessionId);
      }
      return next.slice(0, capacity);
    });
  }, [sessions, activeSessionId, capacity]);

  return (
    <div className="page page--terminal">
      <header className="page-head page-head--compact">
        <div className="page-head__text">
          <h1 className="page-head__title">终端</h1>
        </div>
        {sessions.length > 0 ? (
          <div className="page-head__actions">
            <span className="page-head__hint">
              {paneIds.length} / {sessions.length} 个会话在窗格里
            </span>
            <div className="segmented" role="group" aria-label="终端排列">
              {LAYOUTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={layout === option.id ? 'is-active' : ''}
                  aria-pressed={layout === option.id}
                  title={option.hint}
                  onClick={() => setLayout(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </header>

      {sessions.length === 0 ? (
        <div className="page-empty">
          <span className="page-empty__icon" aria-hidden>
            <TerminalIcon size={26} />
          </span>
          <h2>还没有终端会话</h2>
          <p>左边「连接方式」里点一个连接就能开——会话会一直留着，切回来不丢历史。</p>
        </div>
      ) : (
        <div
          className="terminal-grid"
          data-layout={layout}
          data-panes={paneIds.length}
          data-testid="terminal-grid"
        >
          {sessions.map((session) => {
            const visible = paneIds.includes(session.sessionId);
            const isActive = session.sessionId === activeSessionId;
            return (
              <div
                key={session.sessionId}
                className={`terminal__pane${visible ? ' is-visible' : ''}${
                  isActive ? ' is-active' : ''
                }`}
                data-testid={`terminal-pane-${session.sessionId}`}
                // **display:none**（不是 visibility）→ 隐藏的会话不报尺寸
                hidden={!visible}
              >
                {visible ? (
                  <header className="terminal__bar">
                    <button
                      type="button"
                      className="terminal__tab"
                      onClick={() => onSelectSession(session.sessionId)}
                      title="把这个会话设为当前会话"
                    >
                      <TerminalIcon size={12} />
                      <span className="terminal__tab-label">{session.label}</span>
                      <span className="terminal__tab-id mono">{session.sessionId.slice(0, 6)}</span>
                      {isActive ? <span className="terminal__tab-active">当前</span> : null}
                    </button>
                    <button
                      type="button"
                      className="terminal__pane-close"
                      aria-label={`关闭 ${session.label}`}
                      title="关闭会话"
                      onClick={() => onCloseSession(session.sessionId)}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </header>
                ) : null}
                <div className="terminal__surface">
                  <TerminalView
                    sessionId={session.sessionId}
                    subscribe={terminalSubscribe(session.sessionId)}
                    onWrite={(data) => onTerminalWrite(session.sessionId, data)}
                    onResize={(cols, rows) => onTerminalResize(session.sessionId, cols, rows)}
                    theme={xtermTheme}
                    active={visible}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
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
