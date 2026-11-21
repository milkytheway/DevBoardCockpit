import { useEffect, useRef, useState } from 'react';
import type { ConnectionInfo } from '../../shared/ipc-contract';
import { boardsOf } from './devices';
import { useT, type Localised } from './i18n';
import { ChevronIcon, PlusIcon } from './Icons';

/**
 * **Choosing a board** (the board and its connections are two layers ✓ —
 * contract `spec/02` §10.2 ✓).
 *
 * ── Why a board and not a connection ──
 *
 * → A board has **three connections: ADB / serial / SSH** ✓ → **the interface
 *   lists boards** ✓
 * → **Only the host knows which connection works** ✓ → **the host picks** ✓ →
 *   **the interface does not expose connections** ✓.
 *
 * ── Position ──
 *
 * → **At the very top of the interface** ✓ (in the **title bar** ✓ — that is
 *   the first line of the window ✓)
 * → **Not in the page header** ✓ — the page header moves with the page ✗ →
 *   "the board I am on" **has to stay visible** ✓.
 *
 * ── The shape in v1 (**one connection at a time** ✓) ──
 *
 * → **One board is connected at a time** ✓ (`O11` / `O18` ✓) → "choose a
 *   board" = **the host switches board** ✓.
 */

/** The wording of the picker, in both languages. */
const strings = {
  pickTitle: { 'zh-Hans': '选择要操作的板子', en: 'Choose the board to work with' },
  board: { 'zh-Hans': '板子', en: 'Board' },
  boards: { 'zh-Hans': '板子', en: 'Boards' },
  noBoard: { 'zh-Hans': '没有板', en: 'No board' },
  notConnected: { 'zh-Hans': '未连接', en: 'Not connected' },
  noBoards: { 'zh-Hans': '没有可用的板', en: 'No boards available' },
  current: { 'zh-Hans': '当前', en: 'Current' },
  addBoard: { 'zh-Hans': '添加开发板', en: 'Add board' },
} satisfies Record<string, Localised>;
export function DevicePicker({
  connections,
  onSelect,
  onAddBoard,
  busy,
}: {
  /** The connection list from the host (**with `deviceKey` and `current`** ✓) */
  connections: ConnectionInfo[];
  /** A board was chosen (**what is handed over is the board identity** ✓ — **the host picks the connection** ✓) */
  onSelect: (deviceKey: string) => void;
  /** Opens the independent board setup dialog. */
  onAddBoard?: () => void;
  /** Switching (**do not let the user click again** ✓) */
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const boards = boardsOf(connections);
  const currentBoard = boards.find((board) => board.current) ?? null;
  const t = useT();

  // ── Click outside to close · Esc closes too ──
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

  useEffect(() => {
    if (!open) return;
    const current = rootRef.current?.querySelector<HTMLElement>(
      '.device-picker__item.is-current',
    );
    (current ?? firstOptionRef.current)?.focus();
  }, [open]);

  return (
    <div className="device-picker" ref={rootRef}>
      <button
        type="button"
        className="device-picker__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t(strings.pickTitle)}
        disabled={busy}
      >
        <span className="device-picker__label">{t(strings.board)}</span>
        {boards.length === 0 ? (
          <span className="device-picker__value dim">{t(strings.noBoard)}</span>
        ) : currentBoard === null ? (
          <span className="device-picker__value dim">{t(strings.notConnected)}</span>
        ) : (
          <span className="device-picker__value mono">{currentBoard.deviceKey}</span>
        )}
        <ChevronIcon size={13} />
      </button>

      {open ? (
        <div className="device-picker__menu">
          <div className="device-picker__list" role="listbox" aria-label={t(strings.boards)}>
            {boards.length === 0 ? (
              <p className="device-picker__empty">{t(strings.noBoards)}</p>
            ) : null}
            {boards.map((board, index) => (
              <button
                key={board.deviceKey}
                ref={index === 0 ? firstOptionRef : undefined}
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
                {board.current ? (
                  <span className="device-picker__now">{t(strings.current)}</span>
                ) : null}
              </button>
            ))}
          </div>
          {onAddBoard ? (
            <>
              <div className="device-picker__separator" role="separator" />
              <button
                type="button"
                className="device-picker__item device-picker__add"
                onClick={() => {
                  setOpen(false);
                  onAddBoard();
                }}
              >
                <span className="device-picker__add-icon" aria-hidden>
                  <PlusIcon size={14} />
                </span>
                <span>{t(strings.addBoard)}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
