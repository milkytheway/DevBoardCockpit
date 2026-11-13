import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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

export function TerminalView({ sessionId, onWrite, onResize, subscribe }: TerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onWriteRef = useRef(onWrite);
  const onResizeRef = useRef(onResize);

  onWriteRef.current = onWrite;
  onResizeRef.current = onResize;

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
      theme: {
        background: readToken('--cockpit-bg', '#14171c'),
        foreground: readToken('--cockpit-text', '#dfe4ec'),
        cursor: readToken('--cockpit-accent', '#58a6ff'),
        selectionBackground: readToken('--cockpit-bg-elevated', '#1c2027'),
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
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
      fit.fit();
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
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((chunk: string) => {
      termRef.current?.write(chunk);
    });
  }, [subscribe]);

  return <div className="cockpit-terminal" data-testid={`terminal-${sessionId}`} ref={hostRef} />;
}
