import { useState } from 'react';
import type { ConnectionCapabilities, ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { FileBrowser } from '../files/FileBrowser';
import { TerminalView } from '../terminal/TerminalView';
import { ageText, clockText, runtimeText, transportLabel } from './format';
import { AlertIcon, ChevronIcon, CloseIcon, TerminalIcon } from './Icons';
import type { XtermTheme } from './theme';
import type { ActivityEntry, DockTab, TerminalTab } from './types';

export interface DockFilesProps {
  sessionId: string;
  capabilities: ConnectionCapabilities;
  listRemote: (connectionId: string, remotePath: string) => Promise<
    { name: string; path: string; isDirectory: boolean; sizeBytes: number | null; modifiedAt: string | null }[]
  >;
  onPush: (file: File, remotePath: string) => void;
  onPull: (connectionId: string, remotePath: string) => void;
}

export function Dock({
  open,
  tab,
  onTab,
  onToggle,
  connections,
  runtime,
  sessions,
  activeSessionId,
  onOpenSession,
  onSelectSession,
  onCloseSession,
  terminalSubscribe,
  onTerminalWrite,
  onTerminalResize,
  files,
  activity,
  xtermTheme,
}: {
  open: boolean;
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  onToggle: () => void;
  connections: ConnectionInfo[];
  runtime: RuntimeStatus;
  sessions: TerminalTab[];
  activeSessionId: string | null;
  onOpenSession: (profileId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  terminalSubscribe: (sessionId: string) => (cb: (chunk: string) => void) => () => void;
  onTerminalWrite: (sessionId: string, data: string) => void;
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void;
  files: DockFilesProps | null;
  activity: ActivityEntry[];
  xtermTheme: XtermTheme;
}): JSX.Element {
  const rt = runtimeText(runtime, connections);
  const [transferNote, setTransferNote] = useState<string | null>(null);
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  if (!open) {
    return (
      <div className="dock dock--collapsed">
        <button type="button" className="dock__toggle" onClick={onToggle} title="Ctrl + ` 展开或收起">
          <ChevronIcon size={14} />
          <span>工具</span>
        </button>
        {(['terminal', 'files', 'logs'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className="dock__peek-tab"
            onClick={() => {
              onTab(key);
              onToggle();
            }}
          >
            {key === 'terminal' ? '终端' : key === 'files' ? '文件传输' : '运行日志'}
          </button>
        ))}
        <span className="dock__collapsed-meta">
          {sessions.length} 个终端会话 · {activity.length} 条事件
        </span>
        <span className="spacer" />
        <span className={`chip chip--${rt.tone} chip--sm`}>
          <span className={`dot dot--${rt.tone}`} />
          {rt.label}
        </span>
        <button type="button" className="dock__toggle dock__toggle--right" onClick={onToggle}>
          <span>展开</span>
          <ChevronIcon size={14} />
        </button>
      </div>
    );
  }

  return (
    <section className="dock" data-testid="dock">
      <header className="dock__head">
        <div className="dock__tabs" role="tablist" aria-label="工具">
          {(['terminal', 'files', 'logs'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`dock__tab ${tab === key ? 'is-active' : ''}`}
              onClick={() => onTab(key)}
            >
              {key === 'terminal' ? (
                <>
                  <TerminalIcon size={14} /> 终端
                </>
              ) : key === 'files' ? (
                '文件传输'
              ) : (
                '运行日志'
              )}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="dock__meta">
          {activeSession
            ? `${transportLabel(connections.find((c) => c.id === activeSession.profileId)?.transport ?? 'local')} · ${activeSession.label}`
            : '未选择会话'}
        </span>
        <button type="button" className="icon-btn" onClick={onToggle} title="收起" aria-label="收起工具">
          <ChevronIcon size={14} />
        </button>
      </header>

      {tab === 'terminal' ? (
        <div className="dock__body dock__body--terminal">
          <div className="term-toolbar">
            <span className="term-toolbar__label">连接</span>
            {connections.map((connection) => (
              <button
                key={connection.id}
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onOpenSession(connection.id)}
                title={connection.boardPack ?? ''}
              >
                + {connection.label}
              </button>
            ))}
            <span className="term-toolbar__sep" />
            {sessions.map((session) => (
              <span
                key={session.sessionId}
                className={`term-tab ${session.sessionId === activeSessionId ? 'is-active' : ''}`}
              >
                <button type="button" onClick={() => onSelectSession(session.sessionId)}>
                  {session.label}
                </button>
                <button
                  type="button"
                  className="term-tab__close"
                  onClick={() => onCloseSession(session.sessionId)}
                  aria-label={'关闭 ' + session.label}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            ))}
            <span className="spacer" />
            <span className="dim">pty 优先 · pipe 回退</span>
          </div>
          <div className="term-host">
            {activeSession ? (
              <TerminalView
                key={activeSession.sessionId + xtermTheme.background}
                sessionId={activeSession.sessionId}
                onWrite={(data) => onTerminalWrite(activeSession.sessionId, data)}
                onResize={(cols, rows) => onTerminalResize(activeSession.sessionId, cols, rows)}
                subscribe={terminalSubscribe(activeSession.sessionId)}
              />
            ) : (
              <div className="dock-empty">
                <TerminalIcon size={20} />
                <p>还没有终端会话。选一个上面的连接开一个。</p>
                <p className="dim">串口 / ADB / SSH / 本机四条通道都会走 pty；没有 pty 时回退 pipe。</p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {tab === 'files' ? (
        <div className="dock__body dock__body--files">
          {files ? (
            <>
              <FileBrowser
                connectionId={files.sessionId}
                capabilities={files.capabilities}
                listRemote={files.listRemote}
                onPush={(file, remotePath) => {
                  setTransferNote('正在上传 ' + file.name + ' …');
                  files.onPush(file, remotePath);
                }}
                onPull={(connectionId, remotePath) => {
                  setTransferNote('正在下载 ' + remotePath + ' …');
                  files.onPull(connectionId, remotePath);
                }}
              />
              {transferNote ? <p className="dock__note">{transferNote}</p> : null}
            </>
          ) : (
            <div className="dock-empty">
              <AlertIcon size={20} />
              <p>文件传输需要一个支持文件通道的会话。</p>
              <p className="dim">先开一个 ADB / SSH 的终端会话，再回到这里。</p>
            </div>
          )}
        </div>
      ) : null}

      {tab === 'logs' ? (
        <div className="dock__body dock__body--logs">
          {activity.length === 0 ? (
            <div className="dock-empty">
              <p>还没有事件。连接、开终端、上传文件、卡片变化都会记在这里。</p>
            </div>
          ) : (
            <ol className="activity-list">
              {activity.map((entry) => (
                <li key={entry.id} className={`activity-list__item tone-${entry.level}`}>
                  <span className="mono activity-list__time">{clockText(entry.at)}</span>
                  <span className={`glyph glyph--${entry.level === 'error' ? 'danger' : entry.level === 'warn' ? 'warn' : 'ok'}`}>
                    {entry.level === 'error' ? '✕' : entry.level === 'warn' ? '◐' : '●'}
                  </span>
                  <span className="activity-list__message">{entry.message}</span>
                  <span className="dim activity-list__age">{ageText(entry.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}
