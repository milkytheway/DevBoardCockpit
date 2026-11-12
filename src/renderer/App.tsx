import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalView } from './terminal/TerminalView';
import { FileBrowser } from './files/FileBrowser';
import type { CockpitApi, ConnectionInfo } from '../shared/ipc-contract';
import './theme/tokens.css';

/**
 * 工作台外壳。
 *
 * v1 只有一个东西：终端标签页 + 文件互传。
 * 卡片与布局在 M5。
 */

declare global {
  interface Window {
    cockpit: CockpitApi;
  }
}

interface Tab {
  sessionId: string;
  profileId: string;
}

export function App(): JSX.Element {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apiRef = useRef<CockpitApi | null>(null);

  useEffect(() => {
    apiRef.current = window.cockpit ?? null;
    if (!apiRef.current) return;

    // 连接与能力位都问宿主要——UI 不该自己猜哪个传输能干什么
    void apiRef.current.connectionsList().then(setConnections);

    const offExit = apiRef.current.onTerminalExit((sessionId) => {
      setTabs((prev) => prev.filter((t) => t.sessionId !== sessionId));
    });

    return () => {
      offExit();
    };
  }, []);

  /**
   * 订阅某个会话的输出。
   *
   * **每个 chunk 直接写进终端，不重放历史。**
   * 之前把输出累积成字符串再整体传下去，每来一个 chunk 就得把从第一个字符起的
   * 全部内容再写一遍——屏幕上显示的是重复的文本。
   */
  const subscribeOutput = useCallback(
    (sessionId: string) => (cb: (chunk: string) => void) => {
      const api = apiRef.current;
      if (!api) return () => undefined;
      return api.onTerminalData((id, chunk) => {
        if (id === sessionId) cb(chunk);
      });
    },
    [],
  );

  const openTab = useCallback(async (profileId: string) => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const { sessionId } = await api.terminalOpen(profileId);
      setTabs((prev) => [...prev, { sessionId, profileId }]);
      setActive(sessionId);
      setError(null);
    } catch (err) {
      // 失败要让人看见——「串口被占用」这种错误藏在控制台里等于没报（RF-5）
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const closeTab = useCallback((sessionId: string) => {
    apiRef.current?.terminalClose(sessionId);
    setTabs((prev) => prev.filter((t) => t.sessionId !== sessionId));
    setActive((prev) => (prev === sessionId ? null : prev));
  }, []);

  const current = tabs.find((t) => t.sessionId === active) ?? null;
  const currentInfo = connections.find((c) => c.id === current?.profileId) ?? null;

  return (
    <div className="cockpit-app">
      <header className="cockpit-toolbar">
        <span className="cockpit-toolbar__title">开发板驾驶舱</span>
        {connections.map((conn) => (
          <button key={conn.id} type="button" onClick={() => void openTab(conn.id)}>
            {conn.label}
          </button>
        ))}
      </header>

      <nav className="cockpit-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.sessionId}
            type="button"
            className={tab.sessionId === active ? 'is-active' : undefined}
            onClick={() => setActive(tab.sessionId)}
          >
            {tab.profileId}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.sessionId);
              }}
            >
              ×
            </span>
          </button>
        ))}
      </nav>

      {error ? (
        <p className="cockpit-error" role="alert">
          {error}
        </p>
      ) : null}

      <main className="cockpit-main">
        {current ? (
          <>
            <TerminalView
              sessionId={current.sessionId}
              subscribe={subscribeOutput(current.sessionId)}
              onWrite={(data) => apiRef.current?.terminalWrite(current.sessionId, data)}
              onResize={(cols, rows) => apiRef.current?.terminalResize(current.sessionId, cols, rows)}
            />
            {currentInfo ? (
              <FileBrowser
                connectionId={current.profileId}
                capabilities={currentInfo.capabilities}
                onPush={() => {
                  /* v1 只做本地选择，真实传输在 Task 10 之后接 */
                }}
              />
            ) : null}
          </>
        ) : (
          <p className="cockpit-empty">选一个连接开始</p>
        )}
      </main>
    </div>
  );
}
