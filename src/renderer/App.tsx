import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalView } from './terminal/TerminalView';
import type { CockpitApi } from '../shared/ipc-contract';
import './theme/tokens.css';

/**
 * 工作台外壳。
 *
 * v1 只有一个东西：终端标签页。
 * 布局与卡片在 M5；文件浏览器在 M2 的 Task 9。
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
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [output, setOutput] = useState<Record<string, string>>({});
  const apiRef = useRef<CockpitApi | null>(null);

  useEffect(() => {
    apiRef.current = window.cockpit ?? null;
    if (!apiRef.current) return;

    const offData = apiRef.current.onTerminalData((sessionId, chunk) => {
      setOutput((prev) => ({ ...prev, [sessionId]: (prev[sessionId] ?? '') + chunk }));
    });
    const offExit = apiRef.current.onTerminalExit((sessionId) => {
      setTabs((prev) => prev.filter((t) => t.sessionId !== sessionId));
    });

    return () => {
      offData();
      offExit();
    };
  }, []);

  const openTab = useCallback(async (profileId: string) => {
    const api = apiRef.current;
    if (!api) return;
    const { sessionId } = await api.terminalOpen(profileId);
    setTabs((prev) => [...prev, { sessionId, profileId }]);
    setActive(sessionId);
  }, []);

  const closeTab = useCallback((sessionId: string) => {
    apiRef.current?.terminalClose(sessionId);
    setTabs((prev) => prev.filter((t) => t.sessionId !== sessionId));
    setActive((prev) => (prev === sessionId ? null : prev));
  }, []);

  const current = tabs.find((t) => t.sessionId === active) ?? null;

  return (
    <div className="cockpit-app">
      <header className="cockpit-toolbar">
        <span className="cockpit-toolbar__title">开发板驾驶舱</span>
        <button type="button" onClick={() => void openTab('board-serial')}>
          串口
        </button>
        <button type="button" onClick={() => void openTab('board-adb')}>
          ADB
        </button>
        <button type="button" onClick={() => void openTab('ubuntu-ssh')}>
          SSH
        </button>
        <button type="button" onClick={() => void openTab('local')}>
          本机
        </button>
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

      <main className="cockpit-main">
        {current ? (
          <TerminalView
            sessionId={current.sessionId}
            incoming={output[current.sessionId]}
            onWrite={(data) => apiRef.current?.terminalWrite(current.sessionId, data)}
            onResize={(cols, rows) => apiRef.current?.terminalResize(current.sessionId, cols, rows)}
          />
        ) : (
          <p className="cockpit-empty">选一个连接开始</p>
        )}
      </main>
    </div>
  );
}
