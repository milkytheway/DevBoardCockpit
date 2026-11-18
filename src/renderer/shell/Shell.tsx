import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import { CommandPalette, type Command } from './CommandPalette';
import { DetailPanel } from './detail/DetailPanel';
import { DevicePicker } from './DevicePicker';
import { ErrorBar } from './ErrorBar';
import { FilesPage } from './pages/FilesPage';
import { LibraryPage } from './pages/LibraryPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TerminalPage } from './pages/TerminalPage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { ChevronIcon } from './Icons';
import { Rail } from './Rail';
import { WorkflowRuns } from './WorkflowRuns';
import { Secondary } from './Secondary';
import {
  useActivity,
  useBroker,
  useCards,
  useConnections,
  useLayout,
  usePermissions,
  useRuntime,
  useTagStream,
} from './data';
import { describeError, runtimeText } from './format';
import { downloadFile, uploadFile, type FileTransferHost } from './files';
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
/** The host's file-transfer surface (the preload's white list). */
const FILE_HOST: FileTransferHost = {
  getPathForFile: (file) => window.cockpit.getPathForFile(file),
  push: (sessionId, localPath, remotePath) => window.cockpit.filesPush(sessionId, localPath, remotePath),
  pull: (connectionId, remotePath) => window.cockpit.filesPull(connectionId, remotePath, ''),
};

const PAGE_TITLE: Record<PageId, string> = {
  workbench: '工作台',
  terminal: '终端',
  files: '文件传输',
  logs: '运行日志',
  library: '卡片库',
  settings: '设置',
};

function readStoredSecondary(): boolean {
  try {
    return window.localStorage.getItem('devboard.secondary') !== '0';
  } catch {
    return true;
  }
}

function readStoredDetailWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem('devboard.detailWidth'));
    if (Number.isFinite(raw) && raw >= 320 && raw <= 640) return raw;
  } catch {
    // ignore — a broken storage must not stop the shell
  }
  return 380;
}

/** Card ids the user pinned in the sidebar. */
function readStoredPins(): string[] {
  try {
    const raw = window.localStorage.getItem('devboard.pinnedCards');
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function Shell(): JSX.Element {
  const [theme, setTheme] = useState(readStoredTheme);
  const [cardTheme, setCardTheme] = useState(theme);
  const [page, setPage] = useState<PageId>('workbench');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailTarget>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activityFilter, setActivityFilter] = useState<'all' | ActivityLevel>('all');
  const [transferNote, setTransferNote] = useState<string | null>(null);
  const [xtermTheme, setXtermTheme] = useState<XtermTheme>(readXtermTheme);
  const [secondaryOpen, setSecondaryOpen] = useState(readStoredSecondary);
  const [detailWidth, setDetailWidth] = useState(readStoredDetailWidth);
  const [pinnedCardIds, setPinnedCardIds] = useState<string[]>(readStoredPins);

  const reportError = useCallback((message: string) => setError(message), []);
  const { activity, log } = useActivity();
  const { connections, refresh: refreshConnections } = useConnections(reportError);
  const runtime = useRuntime();
  const { cards, refresh } = useCards(reportError);
  const { rows: permissionRows, set: setPermission } = usePermissions(reportError);
  const { units, density, placeCard, removeCard, setUnits, setDensity } = useLayout(reportError);
  const broker = useBroker();
  const terminal = useTerminal(connections, reportError, log);
  const tagStream = useTagStream();

  // Theme is a document-level attribute; xterm needs concrete colours, so it
  // is re-read from the CSS variables after the styles have been applied.
  // The host also needs it: card frames get their tokens from the protocol
  // handler, so the theme is pushed to main *before* the frames remount.
  useEffect(() => {
    applyTheme(theme);
    const timer = window.setTimeout(() => setXtermTheme(readXtermTheme()), 30);
    // The cards read their tokens from the main process, not from this
    // document. Ack the theme first, then remount the frames — otherwise the
    // iframe can reload with the previous palette.
    void window.cockpit
      .setTheme(theme)
      .catch(() => undefined)
      .finally(() => setCardTheme(theme));
    return () => window.clearTimeout(timer);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('devboard.secondary', secondaryOpen ? '1' : '0');
    } catch {
      // memory-only shell still works
    }
  }, [secondaryOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem('devboard.detailWidth', String(detailWidth));
    } catch {
      // memory-only shell still works
    }
  }, [detailWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem('devboard.pinnedCards', JSON.stringify(pinnedCardIds));
    } catch {
      // memory-only shell still works
    }
  }, [pinnedCardIds]);

  const togglePin = useCallback(
    (cardId: string) => {
      setPinnedCardIds((current) =>
        current.includes(cardId)
          ? current.filter((id) => id !== cardId)
          : [...current, cardId],
      );
      log('info', `${pinnedCardIds.includes(cardId) ? '取消置顶' : '置顶'}卡片：${cardId}`);
    },
    [log, pinnedCardIds],
  );

  const goPage = useCallback((target: PageId) => {
    setPage(target);
    setDetail(null);
    // A page switch starts at the top; keeping the previous scroll offset
    // lands the user halfway down a page they have never seen.
    document.querySelector('.app-scroll')?.scrollTo({ top: 0 });
  }, []);

  /**
   * **换一块板**（界面「选板子」✓ —— 板实物与连接是两层 ✓）。
   *
   * → **宿主去切** ✓（**界面不自己连** ✓ —— 那是宿主的活 ✓）
   * → **交出去的是板的身份** ✓（**不是连接 id** ✓ —— **界面不暴露连接** ✓）
   * → **连不上要说出来** ✓ —— **不静默地换一块** ✗
   *   （**那就是「静默地做另一件事」** ✗ —— 用户选了 A、实际连的是 B ✗）
   * → **切完刷新连接清单** ✓（「当前」变了 ✓）。
   */
  const [selecting, setSelecting] = useState(false);
  const selectDevice = useCallback(
    (deviceKey: string) => {
      setSelecting(true);
      void window.cockpit
        .devicesSelect(deviceKey)
        .then(() => {
          refreshConnections();
          log('info', `已切到板子：${deviceKey}`);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setSelecting(false));
    },
    [log, refreshConnections],
  );

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
        goPage(page === 'terminal' ? 'workbench' : 'terminal');
        return;
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setDetail(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goPage, page]);

  // The grid measures its own container. Opening/closing the detail column or
  // collapsing the secondary sidebar changes that width without a window
  // resize, so nudge react-grid-layout's WidthProvider explicitly.
  useEffect(() => {
    const timer = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    return () => window.clearTimeout(timer);
  }, [detail, secondaryOpen, detailWidth]);

  const commands = useMemo<Command[]>(() => {
    const close = (): void => setPaletteOpen(false);
    const go = (target: PageId): (() => void) => () => {
      goPage(target);
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
  }, [detail, goPage, log, refresh, theme, toggleTheme]);

  const secondary = useMemo(
    () =>
      secondaryGroupsFor(page, {
        runtime,
        connections,
        cards,
        placedSlotKeys: [...placedKeys],
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
        pinnedCardIds,
        onTogglePin: togglePin,
      }),
    [
      activity,
      activityFilter,
      cards,
      connections,
      handlePlace,
      handleRemove,
      page,
      pinnedCardIds,
      placedKeys,
      runtime,
      terminal,
      togglePin,
    ],
  );

  const activeConnection = terminal.activeSession
    ? (connections.find((connection) => connection.id === terminal.activeSession?.profileId) ?? null)
    : null;
  const statusText = runtimeText(runtime, connections);
  const secondaryStatus = {
    ...statusText,
    tone: statusText.tone === 'unknown' ? ('muted' as const) : statusText.tone,
  };

  return (
    <div className="app-shell">
      {/* The native title bar is hidden; this strip is the window's drag
          handle and the native min/max/close buttons float over it.
          **选板子在这里** ✓ —— 它是界面最顶端的一行 ✓
          （**「我在这块板上」得一直在** ✓ —— 页面头会跟着页面换位置 ✗）。*/}
      <div className="window-drag">
        <DevicePicker
          connections={connections}
          onSelect={selectDevice}
          busy={selecting}
        />
        {/* **运行中的流程 + 唯一的「停」** ✓ —— 契约 `05` §八·A **A4** ✓：
            **只有宿主能取消** ✓ → **卡片里没有这个按钮** ✓ → 它只能在这儿 ✓。
            顶条**一直在** ✓ —— 编译要几分钟 ✓，中途切到别的页面也得找得着「停」✓。*/}
        <WorkflowRuns />
      </div>

      <div className="app-body">
        <Rail page={page} onPage={goPage} onOpenPalette={() => setPaletteOpen(true)} />
        {secondaryOpen ? (
          <Secondary
            title={PAGE_TITLE[page]}
            status={secondaryStatus}
            groups={secondary}
            onCollapse={() => setSecondaryOpen(false)}
          />
        ) : (
          <button
            type="button"
            className="secondary-reopen"
            onClick={() => setSecondaryOpen(true)}
            title="展开二级栏"
            aria-label="展开二级栏"
          >
            <ChevronIcon size={14} />
          </button>
        )}

        <main className={`app-main${density === 'compact' ? ' is-compact' : ''}`}>
          <ErrorBar message={error} onDismiss={() => setError(null)} />

          <div className="app-scroll">
            {page === 'workbench' ? (
              <WorkbenchPage
                cards={placedCards}
                units={units}
                broker={broker}
                theme={cardTheme}
                density={density}
                selectedInstanceId={detail?.kind === 'card' ? detail.card.instanceId : null}
                onSelect={selectCard}
                onOpenDetail={openDetail}
                onRemove={handleRemove}
                onLayoutChange={setUnits}
                onOpenLibrary={() => goPage('library')}
                onDensity={setDensity}
                onRefreshCards={refresh}
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
                onSelectSession={terminal.selectSession}
                onCloseSession={terminal.closeSession}
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
                  setTransferNote(`正在上传 ${file.name} …`);
                  void uploadFile(FILE_HOST, session.sessionId, file, remotePath)
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
                  void downloadFile(FILE_HOST, connectionId, remotePath)
                    .then((localPath) => {
                      setTransferNote(`已拉取 ${remotePath} → ${localPath}`);
                      log('info', `已拉取 ${remotePath} → ${localPath}`);
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
                onPlaceOnWorkbench={(card) => {
                  handlePlace(card);
                  setPage('workbench');
                }}
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
                permissions={permissionRows}
                onPermission={setPermission}
              />
            ) : null}
          </div>
        </main>

        <DetailPanel
          target={detail}
          width={detailWidth}
          activity={activity}
          readings={tagStream.readings}
          historyFor={tagStream.historyFor}
          sampleCount={tagStream.sampleCount}
          onWidthChange={setDetailWidth}
          onClose={() => setDetail(null)}
          onRemoveCard={handleRemove}
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
