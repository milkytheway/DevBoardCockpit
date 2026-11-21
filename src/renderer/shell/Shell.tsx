import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import { BoardWizardDialog } from './BoardWizardDialog';
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
import { currentBoard, sessionsOfBoard } from './board-scope';
import { applyTheme, readStoredTheme, readXtermTheme, type XtermTheme } from './theme';
import {
  interpolate,
  LocaleContext,
  pick,
  readStoredLocale,
  storeLocale,
  type Locale,
  type Localised,
} from './i18n';
import type { ActivityLevel, DetailTarget, PageId } from './types';
import { useTerminal } from './useTerminal';
import { useFileEndpoint } from './useFileEndpoint';

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

const PAGE_TITLE: Record<PageId, Localised> = {
  workbench: { 'zh-Hans': '工作台', en: 'Workbench' },
  terminal: { 'zh-Hans': '终端', en: 'Terminal' },
  files: { 'zh-Hans': '文件传输', en: 'File transfer' },
  logs: { 'zh-Hans': '运行日志', en: 'Run log' },
  library: { 'zh-Hans': '卡片库', en: 'Card library' },
  settings: { 'zh-Hans': '设置', en: 'Settings' },
};

/**
 * The wording of the shell, in both languages.
 *
 * The shell draws the provider for the locale, so it cannot read it back
 * from the context — it picks the pair itself.
 */
const strings = {
  pinCard: { 'zh-Hans': '置顶卡片：{card}', en: 'Pinned the card: {card}' },
  unpinCard: { 'zh-Hans': '取消置顶卡片：{card}', en: 'Unpinned the card: {card}' },
  switchedBoard: { 'zh-Hans': '已切到板子：{board}', en: 'Switched to the board: {board}' },
  deletedBoard: { 'zh-Hans': '已删除开发板：{board}', en: 'Deleted the board: {board}' },
  placedCard: {
    'zh-Hans': '把卡片摆进主区：{card}',
    en: 'Placed the card in the work area: {card}',
  },
  openWorkbench: { 'zh-Hans': '打开工作台', en: 'Open the workbench' },
  openTerminal: { 'zh-Hans': '打开终端', en: 'Open the terminal' },
  openFiles: { 'zh-Hans': '打开文件', en: 'Open the files' },
  openLogs: { 'zh-Hans': '打开日志', en: 'Open the logs' },
  openLibrary: { 'zh-Hans': '打开卡片库', en: 'Open the card library' },
  openWizard: { 'zh-Hans': '添加开发板', en: 'Add a board' },
  openSettings: { 'zh-Hans': '打开设置', en: 'Open the settings' },
  lightTheme: { 'zh-Hans': '切换到浅色主题', en: 'Switch to the light theme' },
  darkTheme: { 'zh-Hans': '切换到深色主题', en: 'Switch to the dark theme' },
  rescanCards: { 'zh-Hans': '重新扫描卡片目录', en: 'Rescan the card directory' },
  closeDetail: { 'zh-Hans': '关闭详情', en: 'Close the detail panel' },
  expandSecondary: { 'zh-Hans': '展开二级栏', en: 'Expand the secondary sidebar' },
  uploading: { 'zh-Hans': '正在上传 {name} …', en: 'Uploading {name} …' },
  pushed: { 'zh-Hans': '已推送 {name} → {path}', en: 'Pushed {name} → {path}' },
  downloading: { 'zh-Hans': '正在下载 {path} …', en: 'Downloading {path} …' },
  pulled: {
    'zh-Hans': '已拉取 {remote} → {local}',
    en: 'Pulled {remote} → {local}',
  },
  wizardInstalled: {
    'zh-Hans': '开发板已添加',
    en: 'Board added',
  },
  diagnosticsCopied: {
    'zh-Hans': '已复制诊断 JSON 到剪贴板',
    en: 'Copied the diagnostics JSON to the clipboard',
  },
  clipboardFailed: {
    'zh-Hans': '复制失败：剪贴板不可用。',
    en: 'Copy failed: the clipboard is unavailable.',
  },
} satisfies Record<string, Localised>;

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
  const [locale, setLocale] = useState<Locale>(readStoredLocale);
  const [cardTheme, setCardTheme] = useState(theme);
  const [page, setPage] = useState<PageId>('workbench');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailTarget>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [activityFilter, setActivityFilter] = useState<'all' | ActivityLevel>('all');
  const [transferNote, setTransferNote] = useState<string | null>(null);
  const [xtermTheme, setXtermTheme] = useState<XtermTheme>(readXtermTheme);
  const [secondaryOpen, setSecondaryOpen] = useState(readStoredSecondary);
  const [detailWidth, setDetailWidth] = useState(readStoredDetailWidth);
  const [pinnedCardIds, setPinnedCardIds] = useState<string[]>(readStoredPins);

  const reportError = useCallback((message: string) => setError(message), []);
  // The shell owns the provider for the locale, so it picks the pair itself
  // rather than reading it back from the context it just supplied.
  const t = useCallback(
    (text: Localised, values?: Record<string, string | number>): string =>
      interpolate(pick(text, locale), values),
    [locale],
  );
  const { activity, log } = useActivity();
  const { connections, refresh: refreshConnections } = useConnections(reportError);
  const runtime = useRuntime();
  const { cards, refresh: refreshCards } = useCards(reportError);
  const { rows: permissionRows, set: setPermission } = usePermissions(reportError);
  const { units, density, placeCard, removeCard, setUnits, setDensity, refresh: refreshLayout } =
    useLayout(reportError);
  const broker = useBroker();
  const terminal = useTerminal(connections, reportError, log, locale);
  const tagStream = useTagStream();
  // → **The link that carries the files** ✓ — the host picks it ✓ (ADB →
  //   SSH → serial ✓) → **the files page does not need a terminal** ✓.
  const boardKey = currentBoard(connections);
  const fileEndpoint = useFileEndpoint(page === 'files', boardKey);

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

  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    storeLocale(next);
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
      log(
        'info',
        t(pinnedCardIds.includes(cardId) ? strings.unpinCard : strings.pinCard, {
          card: cardId,
        }),
      );
    },
    [log, pinnedCardIds, t],
  );

  const goPage = useCallback((target: PageId) => {
    setPage(target);
    setDetail(null);
    // A page switch starts at the top; keeping the previous scroll offset
    // lands the user halfway down a page they have never seen.
    document.querySelector('.app-scroll')?.scrollTo({ top: 0 });
  }, []);

  /**
   * **Switching to another board** (the interface has a "choose a board"
   * control ✓ — the board and its connections are two layers ✓).
   *
   * → **The host does the switch** ✓ (**the interface does not connect** ✓ —
   *   that is the host's job ✓)
   * → **What is handed over is the board identity** ✓ (**not a connection id** ✓
   *   — **the interface does not expose connections** ✓)
   * → **A failure to connect has to be reported** ✓ — **never switch to a
   *   different board silently** ✗ (that would be **doing another thing
   *   silently** ✗ — the user chose A and B is what got connected ✗)
   * → **Refresh the connection list after the switch** ✓ (the "current" board
   *   changed ✓).
   */
  const [selecting, setSelecting] = useState(false);
  const closeWizard = useCallback(() => {
    setWizardOpen(false);
    window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('.device-picker__trigger')?.focus();
    }, 0);
  }, []);
  const selectDevice = useCallback(
    (deviceKey: string) => {
      setSelecting(true);
      void window.cockpit
        .devicesSelect(deviceKey)
        .then(() => {
          refreshConnections();
          // → **The board changed** ✓ → the card instances belong to the new
          //   board ✓ (they carry the connection id ✓) and the cells of the
          //   work area were re-bound on the host ✓ → so both are read again
          //   ✓ (without it the cards of the main area disappear ✓ — found
          //   on 2026-11-21 ✓).
          refreshCards();
          refreshLayout();
          log('info', t(strings.switchedBoard, { board: deviceKey }));
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setSelecting(false));
    },
    [log, refreshCards, refreshConnections, refreshLayout, t],
  );

  const deleteDevice = useCallback(
    async (deviceKey: string): Promise<void> => {
      try {
        await window.cockpit.devicesDelete(deviceKey);
        refreshConnections();
        refreshCards();
        refreshLayout();
        log('info', t(strings.deletedBoard, { board: deviceKey }));
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        throw cause;
      }
    },
    [log, refreshCards, refreshConnections, refreshLayout, t],
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
      log('info', t(strings.placedCard, { card: card.cardId }));
    },
    [placeCard, log, t],
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
      { id: 'page-workbench', label: strings.openWorkbench, run: go('workbench') },
      {
        id: 'page-terminal',
        label: strings.openTerminal,
        shortcut: 'Ctrl `',
        run: go('terminal'),
      },
      { id: 'page-files', label: strings.openFiles, run: go('files') },
      { id: 'page-logs', label: strings.openLogs, run: go('logs') },
      { id: 'page-library', label: strings.openLibrary, run: go('library') },
      {
        id: 'add-board',
        label: strings.openWizard,
        run: () => {
          setWizardOpen(true);
          close();
        },
      },
      { id: 'page-settings', label: strings.openSettings, run: go('settings') },
      {
        id: 'toggle-theme',
        label: theme === 'dark' ? strings.lightTheme : strings.darkTheme,
        run: () => {
          toggleTheme();
          close();
        },
      },
      {
        id: 'refresh-cards',
        label: strings.rescanCards,
        run: () => {
          refreshCards();
          log('info', t(strings.rescanCards));
          close();
        },
      },
    ];
    if (detail !== null) {
      list.push({
        id: 'close-detail',
        label: strings.closeDetail,
        run: () => {
          setDetail(null);
          close();
        },
      });
    }
    return list;
  }, [detail, goPage, log, refreshCards, t, theme, togglePin]);

  const secondary = useMemo(
    () =>
      secondaryGroupsFor(page, {
        locale,
        runtime,
        connections,
        cards,
        placedSlotKeys: [...placedKeys],
        sessions: terminal.sessions,
        activeSessionId: terminal.activeSessionId,
        fileEndpoint: fileEndpoint.endpoint,
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

  const statusText = runtimeText(runtime, connections);
  const secondaryStatus = {
    ...statusText,
    tone: statusText.tone === 'unknown' ? ('muted' as const) : statusText.tone,
  };

  return (
    <LocaleContext.Provider value={locale}>
    <div className="app-shell">
      {/* The native title bar is hidden; this strip is the window's drag
          handle and the native min/max/close buttons float over it.
          **The board picker is here** ✓ — it is the topmost row of the
          interface ✓
          (**"which board I am on" has to stay on screen** ✓ — a page header
          moves with the page ✗).*/}
      <div className="window-drag">
        <DevicePicker
          connections={connections}
          onSelect={selectDevice}
          onAddBoard={() => setWizardOpen(true)}
          onDeleteBoard={deleteDevice}
          busy={selecting}
        />
        {/* **The running workflows + the only "stop"** ✓ — contract `05` §8.A
            **A4** ✓:
            **only the host may cancel** ✓ → **the card has no such button** ✓ →
            it can only be here ✓.
            The top bar **is always there** ✓ — a build takes minutes ✓, and
            after switching to another page the "stop" still has to be findable
            ✓.*/}
        <WorkflowRuns />
      </div>

      <div className="app-body">
        <Rail page={page} onPage={goPage} onOpenPalette={() => setPaletteOpen(true)} />
        {page !== 'settings' && secondaryOpen ? (
          <Secondary
            title={PAGE_TITLE[page]}
            status={secondaryStatus}
            groups={secondary}
            onCollapse={() => setSecondaryOpen(false)}
          />
        ) : page !== 'settings' ? (
          <button
            type="button"
            className="secondary-reopen"
            onClick={() => setSecondaryOpen(true)}
            title={t(strings.expandSecondary)}
            aria-label={t(strings.expandSecondary)}
          >
            <ChevronIcon size={14} />
          </button>
        ) : null}

        <main className={`app-main${density === 'compact' ? ' is-compact' : ''}`}>
          <ErrorBar message={error} onDismiss={() => setError(null)} />

          <div className={`app-scroll${page === 'settings' ? ' app-scroll--settings' : ''}`}>
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
                onRefreshCards={refreshCards}
              />
            ) : null}

            {page === 'terminal' ? (
              <TerminalPage
                // → **Only the sessions of the board that is current** ✓
                //   (the terminal of one board must not show up under
                //   another one ✓ — the machine can have several boards ✓)
                sessions={sessionsOfBoard(
                  terminal.sessions,
                  connections,
                  currentBoard(connections),
                )}
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
                endpoint={fileEndpoint.endpoint}
                busy={fileEndpoint.busy}
                error={fileEndpoint.error}
                onRetry={fileEndpoint.refresh}
                note={transferNote}
                onPush={(file, remotePath) => {
                  // → **The link the host picked** ✓ (not a terminal session ✓)
                  const link = fileEndpoint.endpoint;
                  if (link === null) return;
                  setTransferNote(t(strings.uploading, { name: file.name }));
                  void uploadFile(FILE_HOST, link.id, file, remotePath)
                    .then(() => {
                      setTransferNote(t(strings.pushed, { name: file.name, path: remotePath }));
                      log('info', t(strings.pushed, { name: file.name, path: remotePath }));
                    })
                    .catch((cause: unknown) => {
                      setTransferNote(null);
                      setError(describeError(cause, locale));
                    });
                }}
                onPull={(connectionId, remotePath) => {
                  setTransferNote(t(strings.downloading, { path: remotePath }));
                  void downloadFile(FILE_HOST, connectionId, remotePath)
                    .then((localPath) => {
                      setTransferNote(
                        t(strings.pulled, { remote: remotePath, local: localPath }),
                      );
                      log('info', t(strings.pulled, { remote: remotePath, local: localPath }));
                    })
                    .catch((cause: unknown) => {
                      setTransferNote(null);
                      setError(describeError(cause, locale));
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
                onRefresh={refreshCards}
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
                onRefreshCards={refreshCards}
                permissions={permissionRows}
                onPermission={setPermission}
                locale={locale}
                onLocale={changeLocale}
                // → **The board setup writes the profiles** ✓ → the
                //   connections change ✓ → the list is refreshed ✓.
                onBoardApplied={refreshConnections}
                reportError={reportError}
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
                () => log('info', t(strings.diagnosticsCopied)),
                () => setError(t(strings.clipboardFailed)),
              );
            } else {
              setError(t(strings.clipboardFailed));
            }
          }}
        />
      </div>

      {wizardOpen ? (
        <BoardWizardDialog
          run={(input) => window.cockpit.wizardRun(input)}
          detect={() => window.cockpit.boardDetect()}
          onInstalled={() => {
            refreshConnections();
            refreshCards();
            log('info', t(strings.wizardInstalled));
          }}
          onClose={closeWizard}
        />
      ) : null}

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
    </div>
    </LocaleContext.Provider>
  );
}
