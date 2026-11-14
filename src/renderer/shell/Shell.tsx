import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardInstanceInfo, ConnectionInfo } from '../../shared/ipc-contract';
import type { LayoutState, LayoutUnit } from '../../shared/layout';
import { unitsForView, withViewUnits } from '../../shared/layout';
import type { RuntimeStatus } from '../../shared/runtime-status';
import type { TagReading } from '../../shared/tag-reading';
import { CardBroker } from '../cards/broker';
import { CommandPalette, type Command } from './CommandPalette';
import { Dock, type DockFilesProps } from './Dock';
import { describeError, pushHistory } from './format';
import { Inspector } from './Inspector';
import { LibraryPage } from './LibraryPage';
import { Rail } from './Rail';
import { SettingsPage } from './SettingsPage';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { ViewTabs } from './ViewTabs';
import { Workbench } from './Workbench';
import { applyTheme, readStoredTheme, readXtermTheme } from './theme';
import type { ActivityEntry, ActivityLevel, DockTab, PageId, TerminalTab, ViewId } from './types';

const MAX_ACTIVITY = 200;

/**
 * The shell owns presentation state and the renderer-side lifecycle. It never
 * judges permissions or talks to the board: everything device-shaped goes
 * through window.cockpit (main owns the real logic).
 */
export function Shell(): JSX.Element {
  const [theme, setTheme] = useState(readStoredTheme);
  const [page, setPage] = useState<PageId>('workbench');
  const [view, setView] = useState<ViewId>('overview');
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<DockTab>('terminal');
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: 'idle' });
  const [readings, setReadings] = useState<TagReading[]>([]);
  const [lastReadingAt, setLastReadingAt] = useState<number | null>(null);
  const [cards, setCards] = useState<CardInstanceInfo[]>([]);
  const [layout, setLayout] = useState<LayoutState | null>(null);
  const [broker, setBroker] = useState<CardBroker | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [sessions, setSessions] = useState<TerminalTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [inspectorCard, setInspectorCard] = useState<CardInstanceInfo | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [xtermTheme, setXtermTheme] = useState(readXtermTheme);
  const [, setHistoryVersion] = useState(0);

  const historyRef = useRef(new Map<string, number[]>());
  const writersRef = useRef(new Map<string, (chunk: string) => void>());
  const pendingRef = useRef(new Map<string, string[]>());
  const activityIdRef = useRef(0);
  const layoutRef = useRef<LayoutState | null>(null);
  const layoutLoadedRef = useRef(false);

  const logActivity = useCallback((level: ActivityLevel, message: string) => {
    activityIdRef.current += 1;
    const entry: ActivityEntry = { id: activityIdRef.current, at: Date.now(), level, message };
    setActivity((previous) => [entry, ...previous].slice(0, MAX_ACTIVITY));
  }, []);

  // Theme is a document-level attribute; xterm needs concrete colors, so it is
  // re-read from CSS variables after the styles have been applied.
  useEffect(() => {
    applyTheme(theme);
    const timer = window.setTimeout(() => setXtermTheme(readXtermTheme()), 30);
    return () => window.clearTimeout(timer);
  }, [theme]);

  const refreshCards = useCallback(() => {
    const api = window.cockpit;
    void Promise.all([api.cardsList(), api.layoutGet()])
      .then(([list, loaded]) => {
        setCards(list);
        layoutRef.current = loaded;
        setLayout(loaded);
        // First load only: come back to the view the user left last time.
        if (!layoutLoadedRef.current) {
          layoutLoadedRef.current = true;
          setView(loaded.activeViewId);
        }
      })
      .catch((cause: unknown) => setError(describeError(cause)));
  }, []);

  // One wiring effect: all subscriptions are registered and cleaned up here so
  // the rest of the component can stay declarative.
  useEffect(() => {
    const api = window.cockpit;
    if (!api) {
      setError('宿主 API 未注入：检查 preload 是否是最新构建。');
      return;
    }
    let disposed = false;
    const offs: (() => void)[] = [];
    const cardBroker = new CardBroker(api);
    setBroker(cardBroker);

    const mergeReading = (reading: TagReading): void => {
      setReadings((previous) => {
        const index = previous.findIndex((item) => item.tag === reading.tag);
        if (index === -1) return [...previous, reading].sort((left, right) => left.tag.localeCompare(right.tag));
        const next = previous.slice();
        next[index] = reading;
        return next;
      });
      setLastReadingAt(reading.at);
      if (typeof reading.value === 'number') {
        pushHistory(historyRef.current, reading.tag, reading.value);
        setHistoryVersion((value) => value + 1);
      }
    };

    void api
      .connectionsList()
      .then((list) => {
        if (disposed) return;
        setConnections(list);
        logActivity('info', `发现 ${list.length} 个连接 profile`);
      })
      .catch((cause: unknown) => setError(describeError(cause)));

    void api
      .tagsReadings()
      .then((list) => {
        if (disposed) return;
        list.forEach(mergeReading);
      })
      .catch((cause: unknown) => setError(describeError(cause)));

    void api
      .tagsStatus()
      .then((status) => {
        if (!disposed) setRuntime(status);
      })
      .catch((cause: unknown) => setError(describeError(cause)));

    refreshCards();

    offs.push(api.onTagChanged(mergeReading));
    offs.push(
      api.onCardsChanged(() => {
        logActivity('info', '卡片目录变化，重新扫描');
        refreshCards();
      }),
    );

    const onMessage = (event: MessageEvent): void => cardBroker.handleMessage(event);
    window.addEventListener('message', onMessage);
    offs.push(() => window.removeEventListener('message', onMessage));

    const statusTimer = window.setInterval(() => {
      void api
        .tagsStatus()
        .then((status) => {
          if (!disposed) setRuntime(status);
        })
        .catch(() => undefined);
    }, 3000);

    offs.push(
      api.onTerminalData((sessionId, chunk) => {
        const writer = writersRef.current.get(sessionId);
        if (writer) {
          writer(chunk);
          return;
        }
        const pending = pendingRef.current.get(sessionId) ?? [];
        pending.push(chunk);
        pendingRef.current.set(sessionId, pending.slice(-200));
      }),
      api.onTerminalExit((sessionId, exitCode) => {
        logActivity(
          exitCode === 0 ? 'info' : 'warn',
          `终端会话结束（退出码 ${exitCode === null ? '无' : exitCode}）：${sessionId.slice(0, 8)}`,
        );
        setSessions((previous) => previous.filter((session) => session.sessionId !== sessionId));
        setActiveSessionId((previous) => (previous === sessionId ? null : previous));
      }),
    );

    return () => {
      disposed = true;
      window.clearInterval(statusTimer);
      for (const off of offs) off();
      cardBroker.dispose();
      setBroker(null);
    };
  }, [logActivity, refreshCards]);

  // Keyboard shortcuts are part of the shell contract (see the settings page).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (modifier && event.key === '`') {
        event.preventDefault();
        setDockOpen((open) => !open);
        return;
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setInspectorCard(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Grid units of the current view (each view owns its own layout). */
  const units = layout === null ? [] : unitsForView(layout, view);

  const persistLayout = useCallback((next: LayoutState) => {
    layoutRef.current = next;
    setLayout(next);
    void window.cockpit.layoutSet(next).catch((cause: unknown) => {
      setError(describeError(cause));
    });
  }, []);

  const changeView = useCallback(
    (nextView: ViewId) => {
      setView(nextView);
      const current = layoutRef.current;
      if (current === null) return;
      // Switching views persists "which view was last open" only. The other
      // views' units stay untouched.
      persistLayout({
        ...current,
        activeViewId: nextView,
        units: unitsForView(current, nextView),
      });
    },
    [persistLayout],
  );

  const handleLayoutChange = useCallback(
    (next: LayoutUnit[]) => {
      const current = layoutRef.current;
      if (current === null) return;
      persistLayout(withViewUnits(current, view, next));
    },
    [persistLayout, view],
  );

  const openTerminal = useCallback(
    (profileId: string) => {
      const existing = sessions.find((session) => session.profileId === profileId);
      if (existing) {
        setActiveSessionId(existing.sessionId);
        setDockTab('terminal');
        setDockOpen(true);
        return;
      }
      const label = connections.find((connection) => connection.id === profileId)?.label ?? profileId;
      void window.cockpit
        .terminalOpen(profileId)
        .then(({ sessionId }) => {
          setSessions((previous) => [...previous, { sessionId, profileId, label }]);
          setActiveSessionId(sessionId);
          setDockTab('terminal');
          setDockOpen(true);
          logActivity('info', `打开终端：${label}`);
        })
        .catch((cause: unknown) => setError(describeError(cause)));
    },
    [connections, logActivity, sessions],
  );

  const closeSession = useCallback((sessionId: string) => {
    void window.cockpit.terminalClose(sessionId).catch(() => undefined);
    setSessions((previous) => previous.filter((session) => session.sessionId !== sessionId));
    setActiveSessionId((previous) => (previous === sessionId ? null : previous));
  }, []);

  const terminalSubscribe = useCallback((sessionId: string) => {
    return (callback: (chunk: string) => void): (() => void) => {
      writersRef.current.set(sessionId, callback);
      const backlog = pendingRef.current.get(sessionId);
      if (backlog && backlog.length > 0) {
        pendingRef.current.delete(sessionId);
        callback(backlog.join(''));
      }
      return () => {
        if (writersRef.current.get(sessionId) === callback) writersRef.current.delete(sessionId);
      };
    };
  }, []);

  const onTerminalWrite = useCallback((sessionId: string, data: string) => {
    window.cockpit.terminalWrite(sessionId, data);
  }, []);

  const onTerminalResize = useCallback((sessionId: string, cols: number, rows: number) => {
    window.cockpit.terminalResize(sessionId, cols, rows);
  }, []);

  const activeSession = sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const activeConnection = activeSession
    ? connections.find((connection) => connection.id === activeSession.profileId) ?? null
    : null;

  const files: DockFilesProps | null =
    activeSession && activeConnection
      ? {
          sessionId: activeSession.sessionId,
          capabilities: activeConnection.capabilities,
          listRemote: (connectionId, remotePath) => window.cockpit.filesList(connectionId, remotePath),
          onPush: (file, remotePath) => {
            const localPath = window.cockpit.getPathForFile(file);
            void window.cockpit
              .filesPush(activeSession.sessionId, localPath, remotePath)
              .then(() => logActivity('info', `已推送 ${file.name} → ${remotePath}`))
              .catch((cause: unknown) => setError(describeError(cause)));
          },
          onPull: (connectionId, remotePath) => {
            void window.cockpit
              .filesPull(connectionId, remotePath, '')
              .then((result) => logActivity('info', `已拉取 ${remotePath} → ${result.localPath}`))
              .catch((cause: unknown) => setError(describeError(cause)));
          },
        }
      : null;

  const openLogs = useCallback(() => {
    setDockTab('logs');
    setDockOpen(true);
  }, []);

  const copyDiagnostics = useCallback(() => {
    const payload = {
      generatedAt: new Date().toISOString(),
      theme,
      page,
      view,
      runtime,
      connections: connections.map((connection) => ({
        id: connection.id,
        transport: connection.transport,
        boardPack: connection.boardPack,
        capabilities: connection.capabilities,
      })),
      cards,
      readings: readings.map((reading) => ({
        tag: reading.tag,
        status: reading.status,
        value: reading.value,
        reason: reading.reason,
        at: reading.at,
      })),
      activity,
    };
    const text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => logActivity('info', '已复制诊断 JSON 到剪贴板'),
        () => setError('复制失败：剪贴板不可用。'),
      );
    } else {
      setError('复制失败：剪贴板不可用。');
    }
  }, [activity, cards, connections, page, readings, runtime, theme, view, logActivity]);

  const commands = useMemo<Command[]>(() => {
    const close = (): void => setPaletteOpen(false);
    const goView = (next: ViewId): (() => void) => () => {
      changeView(next);
      setPage('workbench');
      close();
    };
    const list: Command[] = [
      { id: 'view-overview', label: '切换视图：总览', shortcut: 'G 1', run: goView('overview') },
      { id: 'view-monitor', label: '切换视图：监控', shortcut: 'G 2', run: goView('monitor') },
      { id: 'view-debug', label: '切换视图：调试', shortcut: 'G 3', run: goView('debug') },
      { id: 'view-demo', label: '切换视图：演示', shortcut: 'G 4', run: goView('demo') },
      {
        id: 'page-library',
        label: '打开卡片库',
        run: () => {
          setPage('library');
          close();
        },
      },
      {
        id: 'page-settings',
        label: '打开设置',
        run: () => {
          setPage('settings');
          close();
        },
      },
      {
        id: 'dock-terminal',
        label: '打开底部终端',
        shortcut: 'Ctrl `',
        run: () => {
          setDockTab('terminal');
          setDockOpen(true);
          close();
        },
      },
      {
        id: 'dock-logs',
        label: '打开运行日志',
        run: () => {
          setDockTab('logs');
          setDockOpen(true);
          close();
        },
      },
      {
        id: 'toggle-theme',
        label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        run: () => {
          setTheme(theme === 'dark' ? 'light' : 'dark');
          close();
        },
      },
      {
        id: 'refresh-cards',
        label: '重新扫描卡片目录',
        run: () => {
          refreshCards();
          close();
        },
      },
    ];
    if (connections.length > 0) {
      list.push({
        id: 'terminal-open-first',
        label: `打开终端：${connections[0].label}`,
        run: () => {
          openTerminal(connections[0].id);
          close();
        },
      });
    }
    if (inspectorCard) {
      list.push({
        id: 'close-inspector',
        label: '关闭检查器',
        run: () => {
          setInspectorCard(null);
          close();
        },
      });
    }
    return list;
  }, [changeView, connections, inspectorCard, openTerminal, refreshCards, theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const openDock = useCallback((tab: DockTab) => {
    setPage('workbench');
    setDockTab(tab);
    setDockOpen(true);
  }, []);

  const selectCard = useCallback((info: CardInstanceInfo) => {
    setSelectedCardId(info.instanceId);
  }, []);

  const openInspector = useCallback((info: CardInstanceInfo) => {
    setSelectedCardId(info.instanceId);
    setInspectorCard(info);
  }, []);

  return (
    <div className="app-shell">
      <StatusBar
        theme={theme}
        onToggleTheme={toggleTheme}
        runtime={runtime}
        connections={connections}
        readingCount={readings.length}
        cardCount={cards.length}
        lastReadingAt={lastReadingAt}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="app-body">
        <Rail page={page} dockTab={dockTab} dockOpen={dockOpen} onPage={setPage} onOpenDock={openDock} />

        <main className="app-main">
          {page === 'workbench' ? (
            <ViewTabs
              view={view}
              onView={changeView}
              onAddView={() => logActivity('info', '视图保存（M6 起可编辑）')}
            />
          ) : null}
          {page === 'workbench' ? (
            <Toolbar
              view={view}
              cardsCount={cards.length}
              tagCount={readings.length}
              onRefresh={refreshCards}
              onOpenLibrary={() => setPage('library')}
              onOpenDock={() => openDock('terminal')}
            />
          ) : null}

          {error ? (
            <div className="shell-error" role="alert">
              <span>{error}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setError(null)}>
                知道了
              </button>
            </div>
          ) : null}

          <div className="app-scroll">
            {page === 'workbench' ? (
              <Workbench
                view={view}
                connections={connections}
                runtime={runtime}
                readings={readings}
                history={(tag) => historyRef.current.get(tag) ?? []}
                cards={cards}
                units={units}
                broker={broker}
                selectedCardId={selectedCardId}
                activeTag={activeTag}
                onSelectTag={setActiveTag}
                onSelectCard={selectCard}
                onOpenInspector={openInspector}
                onLayoutChange={handleLayoutChange}
                onOpenTerminal={openTerminal}
                onOpenLibrary={() => setPage('library')}
              />
            ) : page === 'library' ? (
              <LibraryPage
                cards={cards}
                selectedCardId={selectedCardId}
                onSelect={selectCard}
                onOpenInspector={openInspector}
                onRefresh={refreshCards}
                onOpenWorkbench={() => setPage('workbench')}
              />
            ) : (
              <SettingsPage
                theme={theme}
                onTheme={setTheme}
                cardsCount={cards.length}
                connectionsCount={connections.length}
                onRefreshCards={refreshCards}
              />
            )}
          </div>
        </main>

        {inspectorCard ? (
          <Inspector
            card={inspectorCard}
            readings={readings}
            activity={activity}
            activeTag={activeTag}
            onClose={() => setInspectorCard(null)}
            onOpenLogs={openLogs}
            onCopyDiagnostics={copyDiagnostics}
          />
        ) : null}
      </div>

      <Dock
        open={dockOpen}
        tab={dockTab}
        onTab={setDockTab}
        onToggle={() => setDockOpen((open) => !open)}
        connections={connections}
        runtime={runtime}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onOpenSession={openTerminal}
        onSelectSession={setActiveSessionId}
        onCloseSession={closeSession}
        terminalSubscribe={terminalSubscribe}
        onTerminalWrite={onTerminalWrite}
        onTerminalResize={onTerminalResize}
        files={files}
        activity={activity}
        xtermTheme={xtermTheme}
      />

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
