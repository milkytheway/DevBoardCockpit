import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { readXtermTheme, type XtermTheme } from '../shell/theme';

/**
 * 一个终端面板。
 *
 * xterm 自己算字符宽度（含中文与 emoji 的宽字符），
 * **不要自己算列宽**——那是终端渲染里最容易出错的地方。
 * 尺寸变化交给 FitAddon，宿主只需把行列数报回去。
 *
 * 颜色全部走 `--cockpit-*` token（`docs/04-架构设计.md` §6.5）：
 * 换主题 = 换一套变量值 = 所有卡片跟着变，不用重写任何卡片。
 */

export interface TerminalViewProps {
  sessionId: string;
  /** 用户按键或粘贴 → 交给宿主转发给远端 */
  onWrite: (data: string) => void;
  /** 尺寸变化时把行列数报给宿主 */
  onResize?: (cols: number, rows: number) => void;
  /**
   * 订阅远端输出。
   *
   * **传回调，不传累积串。** 传累积串的话，每来一个 chunk 就得把从第一个字符起
   * 的全部内容再写一遍——屏幕上是重复的文本，不是板子说的话。
   */
  subscribe?: (cb: (chunk: string) => void) => () => void;
  /**
   * The xterm palette (already resolved to concrete colours).
   *
   * **xterm is drawn on a canvas — it cannot resolve `var(--x)`.** So the
   * colours have to be read out of the CSS variables and handed over as
   * plain values.
   *
   * Passing them in (instead of reading them here) means every terminal
   * reads the same snapshot, taken at the same moment — and that a theme
   * change reaches all of them at once.
   */
  theme?: XtermTheme;
  /**
   * Is this the terminal the user is looking at?
   *
   * A hidden terminal must not report its size (the container is 0×0, and
   * FitAddon would measure a fake 2×1). When it becomes visible again it
   * has to re-measure and report, otherwise the remote keeps the old
   * window size.
   */
  active?: boolean;
}

/**
 * 读一个 CSS 变量的**解析后**的值。
 *
 * xterm 是用 canvas 画的，canvas 不认 `var(--x)`——
 * 直接把 token 名传给 xterm 会静默失效（终端落在默认色上）。
 * 所以这里用 getComputedStyle 取实际颜色。
 */
function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Measure only when the host really has a box.
 *
 * A pane in a grid transition (or a `display:none` pane) can be measured at
 * 0×0. xterm's renderer then has no dimensions yet and FitAddon throws
 * "Cannot read properties of undefined (reading 'dimensions')". Skipping the
 * measurement is correct: there is nothing to fit until the box exists.
 */
function safeFit(fit: FitAddon, host: HTMLElement): boolean {
  if (host.clientWidth < 20 || host.clientHeight < 20) return false;
  try {
    fit.fit();
    return true;
  } catch {
    return false;
  }
}

export function TerminalView({
  sessionId,
  onWrite,
  onResize,
  subscribe,
  theme,
  active = true,
}: TerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onWriteRef = useRef(onWrite);
  const onResizeRef = useRef(onResize);
  const activeRef = useRef(active);

  onWriteRef.current = onWrite;
  onResizeRef.current = onResize;
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: readToken('--cockpit-font-mono', 'Consolas, monospace'),
      fontSize: 13,
      convertEol: false,
      cursorBlink: true,
      // 板子可能吐出半个 UTF-8 字符或坏字节，终端自己处理，不要崩
      scrollback: 2000,
      // **必须读出解析后的值**：xterm 用 canvas 的 fillStyle 画字，
      // canvas **不解析 CSS 变量**——直接传 'var(--cockpit-bg)' 会静默失效。
      //
      // 兜底也走**同一条路**（`shell/theme.ts` → 种子）。
      // 这里过去另存着一套计划 1 时代的回落色
      // （`#14171c` / `#dfe4ec` / `#58a6ff` / `#1c2027`），
      // 与种子里的 `#0A0C0F` / `#E6EAF2` / `#58A6FF` / `#1C2129` 并存。
      // 两套都在，只是没同时生效过——**这正是「迟早会漂」的样子**。
      theme: theme ?? readXtermTheme(),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    safeFit(fit, host);
    // **把焦点给终端**：否则开完标签直接打字没反应，
    // 而回车还会再开一个标签（焦点还在工具栏的按钮上）。
    term.focus();

    const disposeData = term.onData((data) => {
      onWriteRef.current(data);
    });

    const report = (): void => {
      // **隐藏的标签不要报尺寸**。
      // 标签不活动时面板是 `display:none` → 容器 0×0 → FitAddon 量出
      // 一个极小的尺寸（cols 2 / rows 1 之类）。
      // 把那个尺寸报给远端，远端的窗口尺寸就废了——
      // 而那个标签用户根本没在看。
      if (term.cols <= 2 || term.rows <= 1) return;
      onResizeRef.current?.(term.cols, term.rows);
    };

    const observer = new ResizeObserver(() => {
      // **隐藏时不要 fit**：容器 0×0，FitAddon 会量出一个假尺寸
      if (!activeRef.current) return;
      if (!safeFit(fit, host)) return;
      report();
    });
    observer.observe(host);

    termRef.current = term;
    fitRef.current = fit;
    report();

    return () => {
      observer.disconnect();
      disposeData.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // 订阅远端输出：每个 chunk 写一次，不重放历史
  //
  // **依赖是 `subscribe` 本身**——宿主给每个会话缓存了一个稳定的函数，
  // 所以这个 effect 不会每次渲染都重跑（重跑 = 退订 + 重订 = 中间到的输出丢了）。
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((chunk: string) => {
      termRef.current?.write(chunk);
    });
  }, [subscribe]);

  // 换主题：**原地改 options.theme**，不重建终端
  //
  // 重建（换 `key`）会把 scrollback 一起丢掉 —— 换主题不该丢屏幕。
  // xterm 的 options 是可写的（`term.options.theme = {...}`），换完刷新一下即可。
  useEffect(() => {
    if (!theme) return;
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = { ...theme };
    term.refresh(0, term.rows - 1);
  }, [theme]);

  // 变得可见：重新量尺寸并报给远端（隐藏期间远端停在旧尺寸上）
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (term === null || fit === null || host === null) return;
    if (!safeFit(fit, host)) return;
    if (term.cols > 2 && term.rows > 1) onResizeRef.current?.(term.cols, term.rows);
    term.refresh(0, term.rows - 1);
    term.focus();
  }, [active]);

  return <div className="cockpit-terminal" data-testid={`terminal-${sessionId}`} ref={hostRef} />;
}
