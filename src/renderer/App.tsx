import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [status, setStatus] = useState<string | null>(null);
  const apiRef = useRef<CockpitApi | null>(null);

  /**
   * 每个会话的输出写入者（TerminalView 注册）。
   *
   * **为什么不让 TerminalView 自己订阅**：
   * `terminalOpen` 返回到 React 挂载之间到达的输出（SSH 的欢迎语、
   * shell 提示符、ADB 的 banner）会**直接丢掉**——
   * 订阅是在组件挂载之后才建立的，而会话在 `open` 时就开始发数据了。
   *
   * 所以：**App 在挂载时就订阅一次全部会话的输出**，
   * 按 sessionId 分发；没人接的先攒着，等 TerminalView 来认领。
   */
  const writersRef = useRef(new Map<string, (chunk: string) => void>());
  /** 还没人认领的输出。TerminalView 挂载时一次性补上 */
  const pendingRef = useRef(new Map<string, string[]>());

  useEffect(() => {
    apiRef.current = window.cockpit ?? null;
    if (!apiRef.current) return;

    // 连接与能力位都问宿主要——UI 不该自己猜哪个传输能干什么。
    // 拉失败也要有去处：没有 catch 就是未处理的 promise rejection——
    // 界面上什么都不会出现，用户只看到「一个连接都没有」。
    void apiRef.current
      .connectionsList()
      .then(setConnections)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });

    const offData = apiRef.current.onTerminalData((sessionId, chunk) => {
      const writer = writersRef.current.get(sessionId);
      if (writer) {
        writer(chunk);
        return;
      }
      // 还没人接——先攒着。TerminalView 挂载时会来认领。
      const pending = pendingRef.current.get(sessionId) ?? [];
      pending.push(chunk);
      pendingRef.current.set(sessionId, pending);
    });

    const offExit = apiRef.current.onTerminalExit((sessionId, exitCode) => {
      // 会话自己结束了：标签页要关掉，active 不能悬空指向死会话
      setTabs((prev) => {
        const next = prev.filter((t) => t.sessionId !== sessionId);
        setActive((cur) => (cur === sessionId ? next[next.length - 1]?.sessionId ?? null : cur));
        return next;
      });
      setStatus(
        exitCode === null ? '会话已结束' : `会话已结束（退出码 ${exitCode}）`,
      );
    });

    return () => {
      offData();
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
      writersRef.current.set(sessionId, cb);

      // 把「还没人接」时攒下的输出补上——只补一次
      const pending = pendingRef.current.get(sessionId);
      if (pending) {
        pendingRef.current.delete(sessionId);
        for (const chunk of pending) cb(chunk);
      }

      return () => {
        writersRef.current.delete(sessionId);
      };
    },
    [],
  );

  /**
   * 每个会话的订阅函数**要稳定**。
   *
   * `TerminalView` 的订阅 effect 依赖 `subscribe`——
   * 每次渲染都造一个新函数的话，effect 每渲染一次就重跑一次：
   * 先取消旧的监听、再装新的，中间到达的输出就丢了。
   */
  const subscribeRef = useRef(new Map<string, (cb: (chunk: string) => void) => () => void>());
  const getSubscribe = useCallback(
    (sessionId: string) => {
      let fn = subscribeRef.current.get(sessionId);
      if (!fn) {
        fn = subscribeOutput(sessionId);
        subscribeRef.current.set(sessionId, fn);
      }
      return fn;
    },
    [subscribeOutput],
  );

  const openTab = useCallback(async (profileId: string) => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const { sessionId } = await api.terminalOpen(profileId);
      setTabs((prev) => [...prev, { sessionId, profileId }]);
      setActive(sessionId);
      setError(null);
      setStatus(null);
    } catch (err) {
      // 失败要让人看见——「串口被占用」这种错误藏在控制台里等于没报（RF-5）
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const closeTab = useCallback((sessionId: string) => {
    const api = apiRef.current;
    setTabs((prev) => {
      const next = prev.filter((t) => t.sessionId !== sessionId);
      // 关掉活动标签时**回落到相邻标签**——不然主区一片空白，
      // 看起来像什么都没在跑
      setActive((cur) => (cur === sessionId ? next[next.length - 1]?.sessionId ?? null : cur));
      return next;
    });
    if (!api) return;
    void api.terminalClose(sessionId).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const current = tabs.find((t) => t.sessionId === active) ?? null;
  const currentInfo = connections.find((c) => c.id === current?.profileId) ?? null;

  /** 文件互传的失败与成功，都要让人看见（R-20） */
  const reportTransfer = useCallback((err: unknown, ok?: string) => {
    if (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
      return;
    }
    setError(null);
    if (ok) setStatus(ok);
  }, []);

  const onPush = useCallback(
    (sessionId: string, file: File, remoteDir: string) => {
      const api = apiRef.current;
      if (!api) return;
      // **必须是宿主的绝对路径**：传 `file.name`（只有 basename）的话，
      // 宿主会在**自己的 CWD** 里找同名文件——要么失败，
      // 要么**传走另一个文件**（数据安全问题）。
      // Electron 32 起 `File.path` 已被移除，受支持的做法是
      // `webUtils.getPathForFile(file)`，由 preload 代理。
      const localPath = api.getPathForFile(file);
      if (!localPath) {
        setError('拿不到这个文件的本地路径（可能不是从磁盘选的文件）');
        return;
      }
      void api
        .filesPush(sessionId, localPath, remoteDir)
        .then((r) => reportTransfer(null, `已上传 ${file.name} → ${r.remotePath}`))
        .catch(reportTransfer);
    },
    [reportTransfer],
  );

  const onPull = useCallback(
    (sessionId: string, remotePath: string) => {
      const api = apiRef.current;
      if (!api) return;
      // 本地落盘位置**由宿主定**（下载目录 + 远端文件名），
      // 宿主定完会把路径回传，界面据此告诉用户「存到哪了」。
      void api
        .filesPull(sessionId, remotePath, '')
        .then((r) => reportTransfer(null, `已保存到 ${r.localPath}`))
        .catch(reportTransfer);
    },
    [reportTransfer],
  );

  /** 每个标签都挂着自己的终端面板——切标签不该销毁它 */
  const panels = useMemo(
    () =>
      tabs.map((tab) => (
        <div
          key={tab.sessionId}
          className="cockpit-tabpanel"
          hidden={tab.sessionId !== active}
        >
          <TerminalView
            sessionId={tab.sessionId}
            subscribe={getSubscribe(tab.sessionId)}
            onWrite={(data) => apiRef.current?.terminalWrite(tab.sessionId, data)}
            onResize={(cols, rows) =>
              apiRef.current?.terminalResize(tab.sessionId, cols, rows)
            }
          />
        </div>
      )),
    [tabs, active, getSubscribe],
  );

  return (
    <div className="cockpit-app">
      <header className="cockpit-toolbar">
        <span className="cockpit-toolbar__title">开发板驾驶舱</span>
        {connections.map((conn) => (
          <button key={conn.id} type="button" onClick={() => void openTab(conn.id)}>
            {conn.label}
            <span className="cockpit-toolbar__transport">{conn.transport}</span>
          </button>
        ))}
      </header>

      <nav className="cockpit-tabs" role="tablist">
        {tabs.map((tab) => (
          // 标签本身不是 button：里面要放一个真正的关闭按钮，
          // **嵌套的交互元素是无效 HTML**，而且原来的 <span role="button">
          // 没有 onKeyDown —— 键盘用户按 Enter/Space 关不掉标签（R-15）。
          <div
            key={tab.sessionId}
            role="tab"
            tabIndex={0}
            aria-selected={tab.sessionId === active}
            className={
              tab.sessionId === active
                ? 'cockpit-tab is-active'
                : 'cockpit-tab'
            }
            onClick={() => setActive(tab.sessionId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActive(tab.sessionId);
              }
            }}
          >
            <span className="cockpit-tab__label">{tab.profileId}</span>
            <button
              type="button"
              className="cockpit-tab__close"
              aria-label={`关闭 ${tab.profileId}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.sessionId);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </nav>

      {error ? (
        <p className="cockpit-error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="cockpit-status" role="status">
          {status}
        </p>
      ) : null}

      <main className="cockpit-main">
        {tabs.length === 0 ? (
          <p className="cockpit-empty">选一个连接开始</p>
        ) : (
          <>
            <div className="cockpit-terminals">{panels}</div>
            {current && currentInfo ? (
              <FileBrowser
                connectionId={current.sessionId}
                capabilities={currentInfo.capabilities}
                onPush={(file, remoteDir) => onPush(current.sessionId, file, remoteDir)}
                onPull={onPull}
                listRemote={(connectionId, remotePath) =>
                  apiRef.current?.filesList(connectionId, remotePath) ?? Promise.resolve([])
                }
              />
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
