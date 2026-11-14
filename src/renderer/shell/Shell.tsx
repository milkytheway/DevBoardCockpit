import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import { CommandPalette, type Command } from './CommandPalette';
import { DetailPanel } from './detail/DetailPanel';
import { ErrorBar } from './ErrorBar';
import { FilesPage } from './pages/FilesPage';
import { LibraryPage } from './pages/LibraryPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { Rail } from './Rail';
import { Secondary } from './Secondary';
import { StatusBar } from './StatusBar';
import {
  useActivity,
  useBroker,
  useCards,
  useConnections,
  useLayout,
  useRuntime,
} from './data';
import { describeError } from './format';
import { slotKey } from './layout-utils';
import { secondaryGroupsFor } from './nav';
import { applyTheme, readStoredTheme, readXtermTheme, type XtermTheme } from './theme';
import type { ActivityLevel, DetailTarget, PageId } from './types';
import { useTerminal } from './useTerminal';

/**
 * The shell: the frame around every page.
 *
 * ── one rail entry = one page ──
 *
 * The terminal, the files and the log used to live in a bottom dock, so
 * clicking them in the rail opened a panel underneath the workbench. Now
 * each one is a page in the main area, and the rail is the only way in.
 *
 * ── the workbench's main area is the cards, and only the cards ──
 *
 * The "overview" strip above the grid (target + a live reading table) is
 * gone. The link state lives in the secondary sidebar's status block; the
 * readings belong to the cards.
 *
 * ── state lives in hooks, not in here ──
 *
 * The shell used to hold 22 `useState`s and one large wiring effect. Now
 * it holds the navigation and hands the rest to `data.ts` / `useTerminal.ts`.
 */
export function Shell(): JSX.Element {
  const [theme, setTheme] = useState(readStoredTheme);
  const [page, setPage] = useState<PageId>('workbench');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailTarget>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activityFilter, setActivityFilter] = useState<'all' | ActivityLevel>('all');
  const [transferNote, setTransferNote] = useState<string | null>(null);
  const [xtermTheme, setXtermTheme] = useState<XtermTheme>(readXtermTheme);

  const reportError = useCallback((message: string) => setError(message), []);
  const { activity, log } = useActivity();
  const connections = useConnections(reportError);
  const runtime = useRuntime();
  const { cards, refresh } = useCards(reportError);
  const { units, density, placeCard, removeCard, setUnits, setDensity } = useLayout(reportError);
  const broker = useBroker();
  const terminal = useTerminal(connections, reportError, log);

  // Theme is a document-level attribute; xterm needs concrete colours, so it
  // is re-read from the CSS variables after the styles have been applied.
  useEffect(() => {
    applyTheme(theme);
    const timer = window.setTimeout(() => setXtermTheme(readXtermTheme()), 30);
    return () => window.clearTimeout(timer);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  // The cards that are **placed** in the main area right now.
  const placedKeys = useMemo(() => new Set(units.map((u) => slotKey(u.cardId, u.connectionId))), [
    units,
  ]);
  const placedCards = useMemo(
    () => cards.filter((card) => placedKeys.has(slotKey(card.cardId, card.connectionId))),
    [cards, placedKeys],
  );

  const openDetail = useCallback((card: CardInstanceInfo) => {
    setDetail({ kind: 'card', card });
  }, []);

  const selectCard = useCallback((card: CardInstanceInfo) => {
    setDetail((current) => (current?.kind === 'card' ? { kind: 'card', card } : current));
  }, []);

  const handleRemove = useCallback(
    (card: CardInstanceInfo) => {
      removeCard(card);
      setDetail((current) =>
        current?.kind === 'card' && current.card.instanceId === card.instanceId ? null : current,
      );
    },
    [removeCard],
  );

  const handlePlace = useCallback(
    (card: CardInstanceInfo) => {
      placeCard(card);
      log('info', `把卡片摆进主区：${card.cardId}`);
    },
    [placeCard, log],
  );

  // ── keyboard ──
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
        setPage((current) => (current === 'terminal' ? 'workbench' : 'terminal'));
        return;
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setDetail(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const close = (): void => setPaletteOpen(false);
    const go = (target: PageId): (() => void) => () => {
      setPage(target);
      close();
    };
    const list: Command[] = [
      { id: 'page-workbench', label: '打开工作台', run: go('workbench') },
      { id: 'page-terminal', label: '打开终端', shortcut: 'Ctrl `', run: go('terminal') },
      { id: 'page-files', label: '打开文件', run: go('files') },
      { id: 'page-logs', label: '打开日志', run: go('logs') },
      { id: 'page-library', label: '打开卡片库', run: go('library') },
      { id: 'page-settings', label: '打开设置', run: go('settings') },
      {
        id: 'toggle-theme',
        label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        run: () => {
          toggleTheme();
          close();
        },
      },
      {
        id: 'refresh-cards',
        label: '重新扫描卡片目录',
        run: () => {
          refresh();
          log('info', '重新扫描卡片目录');
          close();
        },
      },
    ];
    if (detail !== null) {
      list.push({
        id: 'close-detail',
        label: '关闭详情',
        run: () => {
          setDetail(null);
          close();
        },
      });
    }
    return list;
  }, [detail, log, refresh, theme, toggleTheme]);

  const secondary = useMemo(
    () =>
      secondaryGroupsFor(page, {
        runtime,
        connections,
        cards,
        placedCardIds: [...placedKeys].map((key) => key.split('::')[0] ?? key),
        sessions: terminal.sessions,
        activeSessionId: terminal.activeSessionId,
        activity,
        activityFilter,
        onActivityFilter: setActivityFilter,
        onPlaceCard: handlePlace,
        onRemoveCard: handleRemove,
        onOpenSession: terminal.openSession,
        onSelectSession: terminal.selectSession,
        onCloseSession: terminal.closeSession,
      }),
    [
      activity,
      activityFilter,
      cards,
      connections,
      handlePlace,
      handleRemove,
      page,
      placedKeys,
      runtime,
      terminal,
    ],
  );

  const activeConnection = terminal.activeSession
    ? (connections.find((connection) => connection.id === terminal.activeSession?.profileId) ?? null)
    : null;

  return (
    <div className="app-shell">
      <StatusBar
        theme={theme}
        onToggleTheme={toggleTheme}
        runtime={runtime}
        connections={connections}
        cardCount={cards.length}
        placedCount={placedCards.length}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="app-body">
        <Rail page={page} onPage={setPage} />
        <Secondary groups={secondary} />

        <main className={`app-main${density === 'compact' ? ' is-compact' : ''}`}>
          <ErrorBar message={error} onDismiss={() => setError(null)} />

          <div className="app-scroll">
            {page === 'workbench' ? (
              <WorkbenchPage
                cards={placedCards}
                units={units}
                broker={broker}
                density={density}
                selectedInstanceId={detail?.kind === 'card' ? detail.card.instanceId : null}
                onSelect={selectCard}
                onOpenDetail={openDetail}
                onRemove={handleRemove}
                onLayoutChange={setUnits}
              />
            ) : null}

            {page === 'terminal' ? (
              <TerminalPage
                sessions={terminal.sessions}
                activeSessionId={terminal.activeSessionId}
                xtermTheme={xtermTheme}
                terminalSubscribe={terminal.terminalSubscribe}
                onTerminalWrite={terminal.onTerminalWrite}
                onTerminalResize={terminal.onTerminalResize}
              />
            ) : null}

            {page === 'files' ? (
              <FilesPage
                sessionId={terminal.activeSession?.sessionId ?? null}
                capabilities={activeConnection?.capabilities ?? null}
                note={transferNote}
                onPush={(file, remotePath) => {
                  const session = terminal.activeSession;
                  if (session === null) return;
                  const localPath = window.cockpit.getPathForFile(file);
                  setTransferNote(`正在上传 ${file.name} …`);
                  void window.cockpit
                    .filesPush(session.sessionId, localPath, remotePath)
                    .then(() => {
                      setTransferNote(`已推送 ${file.name} → ${remotePath}`);
                      log('info', `已推送 ${file.name} → ${remotePath}`);
                    })
                    .catch((cause: unknown) => {
                      setTransferNote(null);
                      setError(describeError(cause));
                    });
                }}
                onPull={(connectionId, remotePath) => {
                  setTransferNote(`正在下载 ${remotePath} …`);
                  void window.cockpit
                    .filesPull(connectionId, remotePath, '')
                    .then((result) => {
                      setTransferNote(`已拉取 ${remotePath} → ${result.localPath}`);
                      log('info', `已拉取 ${remotePath} → ${result.localPath}`);
                    })
                    .catch((cause: unknown) => {
                      setTransferNote(null);
                      setError(describeError(cause));
                    });
                }}
              />
            ) : null}

            {page === 'logs' ? (
              <LogsPage activity={activity} filter={activityFilter} />
            ) : null}

            {page === 'library' ? (
              <LibraryPage
                cards={cards}
                selectedCardId={detail?.kind === 'card' ? detail.card.instanceId : null}
                onSelect={selectCard}
                onOpenDetail={openDetail}
                onRefresh={refresh}
                onOpenWorkbench={() => setPage('workbench')}
              />
            ) : null}

            {page === 'settings' ? (
              <SettingsPage
                theme={theme}
                onTheme={setTheme}
                density={density}
                onDensity={setDensity}
                cardsCount={cards.length}
                connectionsCount={connections.length}
                onRefreshCards={refresh}
              />
            ) : null}
          </div>
        </main>

        <DetailPanel
          target={detail}
          activity={activity}
          onClose={() => setDetail(null)}
          onCopyDiagnostics={() => {
            const payload = {
              generatedAt: new Date().toISOString(),
              theme,
              page,
              runtime,
              connections: connections.map((connection) => ({
                id: connection.id,
                transport: connection.transport,
                boardPack: connection.boardPack,
                capabilities: connection.capabilities,
              })),
              cards,
              activity,
            };
            const text = JSON.stringify(payload, null, 2);
            if (navigator.clipboard?.writeText) {
              void navigator.clipboard.writeText(text).then(
                () => log('info', '已复制诊断 JSON 到剪贴板'),
                () => setError('复制失败：剪贴板不可用。'),
              );
            } else {
              setError('复制失败：剪贴板不可用。');
            }
          }}
        />
      </div>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
