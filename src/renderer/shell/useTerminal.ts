import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionInfo } from '../../shared/ipc-contract';
import { interpolate, pick, type Locale, type Localised } from './i18n';
import type { TerminalTab } from './types';
import type { ReportError } from './data';

/** The wording of the terminal hook, in both languages. */
const strings = {
  sessionEnded: {
    'zh-Hans': '终端会话结束（退出码 {code}）：{session}',
    en: 'Terminal session ended (exit code {code}): {session}',
  },
  noExitCode: { 'zh-Hans': '无', en: 'none' },
  openedTerminal: { 'zh-Hans': '打开终端：{label}', en: 'Opened the terminal: {label}' },
  openedAnother: {
    'zh-Hans': '又开了一个终端：{label}',
    en: 'Opened another terminal: {label}',
  },
} satisfies Record<string, Localised>;

/**
 * Terminal sessions.
 *
 * ── one session = one connection to one profile ──
 *
 * The host opens a **new connection** per session (`terminal:open` → the
 * connection table is keyed by session id). Opening a second session for
 * the same profile therefore means a second connection — and on a serial
 * port that is a **port conflict**, not a second window. So: one session
 * per profile by default, with an explicit "open another" when the user
 * really wants it.
 *
 * ── the subscribe function must keep its identity ──
 *
 * `TerminalView` subscribes in an effect keyed on that function. A new
 * function every render means the effect tears down and re-subscribes on
 * every render — and output that arrives in between is dropped. So the
 * factory is **cached per session** and handed out unchanged.
 */
export function useTerminal(
  connections: ConnectionInfo[],
  reportError: ReportError,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  locale: Locale,
): {
  sessions: TerminalTab[];
  activeSessionId: string | null;
  activeSession: TerminalTab | null;
  openSession: (profileId: string) => void;
  openAnotherSession: (profileId: string) => void;
  selectSession: (sessionId: string) => void;
  closeSession: (sessionId: string) => void;
  terminalSubscribe: (sessionId: string) => (cb: (chunk: string) => void) => () => void;
  onTerminalWrite: (sessionId: string, data: string) => void;
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void;
} {
  const [sessions, setSessions] = useState<TerminalTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  /** sessionId → the writer that xterm registered */
  const writersRef = useRef(new Map<string, (chunk: string) => void>());
  /** output that arrived before xterm was ready (the shell banner, the prompt…) */
  const pendingRef = useRef(new Map<string, string[]>());
  /** sessionId → its subscribe factory (identity must be stable) */
  const factoriesRef = useRef(
    new Map<string, (cb: (chunk: string) => void) => () => void>(),
  );

  const report = useRef(reportError);
  report.current = reportError;
  const logRef = useRef(log);
  logRef.current = log;
  // The exit event arrives from the host, not from a React event, so the
  // locale it is phrased in has to be read from a ref rather than a closure.
  const localeRef = useRef(locale);
  localeRef.current = locale;

  // Output and exit events arrive from the host, not from a React event.
  useEffect(() => {
    const api = window.cockpit;
    if (!api) return undefined;
    const offData = api.onTerminalData((sessionId, chunk) => {
      const writer = writersRef.current.get(sessionId);
      if (writer) {
        writer(chunk);
        return;
      }
      const pending = pendingRef.current.get(sessionId) ?? [];
      pending.push(chunk);
      pendingRef.current.set(sessionId, pending.slice(-200));
    });
    const offExit = api.onTerminalExit((sessionId, exitCode) => {
      const current = localeRef.current;
      logRef.current(
        exitCode === 0 ? 'info' : 'warn',
        interpolate(pick(strings.sessionEnded, current), {
          code: exitCode === null ? pick(strings.noExitCode, current) : exitCode,
          session: sessionId.slice(0, 8),
        }),
      );
      setSessions((previous) => {
        const remaining = previous.filter((session) => session.sessionId !== sessionId);
        // **When the session is gone the active item moves to a neighbouring
        // session** (rather than leaving a blank page)
        setActiveSessionId((current) => {
          if (current !== sessionId) return current;
          const index = previous.findIndex((session) => session.sessionId === sessionId);
          const neighbour = remaining[index] ?? remaining[index - 1];
          return neighbour?.sessionId ?? null;
        });
        return remaining;
      });
      writersRef.current.delete(sessionId);
      pendingRef.current.delete(sessionId);
      factoriesRef.current.delete(sessionId);
    });
    return () => {
      offData();
      offExit();
    };
  }, []);

  const openSession = useCallback(
    (profileId: string) => {
      // A session for the same profile already exists → reuse it (a serial port is exclusive)
      const existing = sessions.find((session) => session.profileId === profileId);
      if (existing) {
        setActiveSessionId(existing.sessionId);
        return;
      }
      const label = connections.find((connection) => connection.id === profileId)?.label ?? profileId;
      const api = window.cockpit;
      if (!api) return;
      void api
        .terminalOpen(profileId)
        .then(({ sessionId }) => {
          setSessions((previous) => [...previous, { sessionId, profileId, label }]);
          setActiveSessionId(sessionId);
          logRef.current(
            'info',
            interpolate(pick(strings.openedTerminal, localeRef.current), { label }),
          );
        })
        .catch((cause: unknown) =>
          report.current(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [connections, sessions],
  );

  const openAnotherSession = useCallback(
    (profileId: string) => {
      const label = connections.find((connection) => connection.id === profileId)?.label ?? profileId;
      const api = window.cockpit;
      if (!api) return;
      void api
        .terminalOpen(profileId)
        .then(({ sessionId }) => {
          setSessions((previous) => [...previous, { sessionId, profileId, label }]);
          setActiveSessionId(sessionId);
          logRef.current(
            'info',
            interpolate(pick(strings.openedAnother, localeRef.current), { label }),
          );
        })
        .catch((cause: unknown) =>
          report.current(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [connections],
  );

  const closeSession = useCallback((sessionId: string) => {
    const api = window.cockpit;
    if (api) void api.terminalClose(sessionId).catch(() => undefined);
    setSessions((previous) => {
      const remaining = previous.filter((session) => session.sessionId !== sessionId);
      setActiveSessionId((current) => {
        if (current !== sessionId) return current;
        const index = previous.findIndex((session) => session.sessionId === sessionId);
        const neighbour = remaining[index] ?? remaining[index - 1];
        return neighbour?.sessionId ?? null;
      });
      return remaining;
    });
    writersRef.current.delete(sessionId);
    pendingRef.current.delete(sessionId);
    factoriesRef.current.delete(sessionId);
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);

  /**
   * A **stable** subscribe function for a session.
   *
   * Identity matters: `TerminalView`'s effect depends on it, so a new
   * function each render would tear the subscription down and set it up
   * again — dropping output that arrives in between.
   */
  const terminalSubscribe = useCallback(
    (sessionId: string) => {
      const cached = factoriesRef.current.get(sessionId);
      if (cached !== undefined) return cached;
      const factory = (callback: (chunk: string) => void): (() => void) => {
        writersRef.current.set(sessionId, callback);
        const backlog = pendingRef.current.get(sessionId);
        if (backlog !== undefined && backlog.length > 0) {
          pendingRef.current.delete(sessionId);
          callback(backlog.join(''));
        }
        return () => {
          if (writersRef.current.get(sessionId) === callback) writersRef.current.delete(sessionId);
        };
      };
      factoriesRef.current.set(sessionId, factory);
      return factory;
    },
    [],
  );

  const onTerminalWrite = useCallback((sessionId: string, data: string) => {
    window.cockpit.terminalWrite(sessionId, data);
  }, []);

  const onTerminalResize = useCallback((sessionId: string, cols: number, rows: number) => {
    window.cockpit.terminalResize(sessionId, cols, rows);
  }, []);

  const activeSession = sessions.find((session) => session.sessionId === activeSessionId) ?? null;

  return {
    sessions,
    activeSessionId,
    activeSession,
    openSession,
    openAnotherSession,
    selectSession,
    closeSession,
    terminalSubscribe,
    onTerminalWrite,
    onTerminalResize,
  };
}
