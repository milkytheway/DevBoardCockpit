import { useEffect, useRef, useState } from 'react';
import type { ConnectionInfo } from '../../shared/ipc-contract';
import { boardsOf } from './devices';
import { ChevronIcon } from './Icons';

/**
 * **选板子**（板实物与连接是两层 ✓ —— 契约 `spec/02` §10.2 ✓）。
 *
 * ── 为什么是「板」而不是「连接」 ──
 *
 * → 用户 2026-11-16 明确：「**设备要放在界面最顶端，仅支持板卡选择，
 *   当前有 fake 和 3588 的真版，不要把连接这些放进去**」✓
 * → 一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **界面只列板** ✓
 * → **哪条连接能用宿主才知道** ✓ → **宿主挑** ✓ → **界面不暴露连接** ✓。
 *
 * ── 位置 ──
 *
 * → **界面最顶端** ✓（**标题条上** ✓ —— 那是这个窗口的第一行 ✓）
 * → **不是页面头** ✓ —— 页面头会跟着页面换位置 ✗ → 「我在这块板上」**得一直在** ✓。
 *
 * ── v1 的形状（**单连接** ✓）──
 *
 * → **一次只连一块板** ✓（`O11` / `O18` ✓）→ 「选板」= **宿主换一块板** ✓。
 */
export function DevicePicker({
  connections,
  onSelect,
  busy,
}: {
  /** 宿主给的连接清单（**带 `deviceKey` 与 `current`** ✓） */
  connections: ConnectionInfo[];
  /** 选中一块板（**交出的是板的身份** ✓ —— **宿主去挑连接** ✓） */
  onSelect: (deviceKey: string) => void;
  /** 切换中（**别让用户连点** ✓） */
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const boards = boardsOf(connections);
  const currentBoard = boards.find((board) => board.current) ?? null;

  // ── 点外面就关掉 · Esc 也关掉 ──
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="device-picker" ref={rootRef}>
      <button
        type="button"
        className="device-picker__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="选择要操作的板子"
        disabled={busy}
      >
        <span className="device-picker__label">板子</span>
        {boards.length === 0 ? (
          <span className="device-picker__value dim">没有板</span>
        ) : currentBoard === null ? (
          <span className="device-picker__value dim">未连接</span>
        ) : (
          <span className="device-picker__value mono">{currentBoard.deviceKey}</span>
        )}
        <ChevronIcon size={13} />
      </button>

      {open ? (
        <div className="device-picker__menu" role="listbox" aria-label="板子">
          {boards.length === 0 ? <p className="device-picker__empty">没有可用的板</p> : null}
          {boards.map((board) => (
            <button
              key={board.deviceKey}
              type="button"
              role="option"
              aria-selected={board.current}
              className={`device-picker__item${board.current ? ' is-current' : ''}`}
              onClick={() => {
                setOpen(false);
                if (!board.current) onSelect(board.deviceKey);
              }}
              title={board.deviceKey}
            >
              <span className={`dot ${board.current ? 'dot--ok' : 'dot--muted'}`} aria-hidden />
              <span className="device-picker__key mono">{board.deviceKey}</span>
              {board.current ? <span className="device-picker__now">当前</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
