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
  /** 远端输出 → 写进终端 */
  incoming?: string;
}

export function TerminalView({ sessionId, onWrite, onResize, incoming }: TerminalViewProps): JSX.Element {
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
      fontFamily: 'var(--cockpit-font-mono)',
      fontSize: 13,
      convertEol: false,
      cursorBlink: true,
      // 板子可能吐出半个 UTF-8 字符或坏字节，终端自己处理，不要崩
      scrollback: 2000,
      theme: {
        background: 'var(--cockpit-bg)',
        foreground: 'var(--cockpit-text)',
        cursor: 'var(--cockpit-accent)',
        selectionBackground: 'var(--cockpit-bg-elevated)',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const disposeData = term.onData((data) => {
      onWriteRef.current(data);
    });

    const report = (): void => {
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

  // 远端输出进来时写进终端
  useEffect(() => {
    if (incoming !== undefined && termRef.current) {
      termRef.current.write(incoming);
    }
  }, [incoming]);

  return <div className="cockpit-terminal" data-testid={`terminal-${sessionId}`} ref={hostRef} />;
}
