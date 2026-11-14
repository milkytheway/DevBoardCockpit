import type { ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { runtimeText } from './format';
import { PanelIcon, PaletteIcon, SearchIcon } from './Icons';

/**
 * The status band: the app's title bar and its one-line health report.
 *
 * It is also the window's drag region (the frame is hidden), which is why
 * every interactive child opts out of `-webkit-app-region: drag`.
 */
export function StatusBar({
  runtime,
  connections,
  cardCount,
  placedCount,
  secondaryOpen,
  onToggleSecondary,
  onOpenPalette,
}: {
  runtime: RuntimeStatus;
  connections: ConnectionInfo[];
  /** How many cards are installed. */
  cardCount: number;
  /** How many of them are placed in the main area. */
  placedCount: number;
  secondaryOpen: boolean;
  onToggleSecondary: () => void;
  onOpenPalette: () => void;
}): JSX.Element {
  const rt = runtimeText(runtime, connections);
  const board = rt.detail || rt.label;

  return (
    <header className="statusbar" data-testid="statusbar">
      <div className="statusbar__brand">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none">
            <rect x="2.5" y="4.5" width="15" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6.5 8.5h7M6.5 11.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M7 2.8v1.7M13 2.8v1.7M7 15.5v1.7M13 15.5v1.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </span>
        <span className="statusbar__title">DevBoard Cockpit</span>
        <span className="statusbar__version">M5b</span>
      </div>

      <span className="statusbar__link" data-testid="runtime-chip">
        <span className={`live-dot live-dot--${rt.tone}`} aria-hidden />
        <span className="statusbar__link-label">{rt.label}</span>
        <span className="statusbar__link-detail">{board}</span>
      </span>

      <span className="statusbar__count" title="已摆进主区 / 已装卡片">
        <span className="mono">{placedCount}</span>
        <span className="statusbar__slash">/</span>
        <span className="mono">{cardCount}</span>
        <span className="statusbar__count-label">张卡片</span>
      </span>

      <span className="statusbar__gap" />

      <button type="button" className="palette-trigger" onClick={onOpenPalette}>
        <SearchIcon size={14} />
        <span>搜索、命令</span>
        <kbd>Ctrl K</kbd>
      </button>
      <button
        type="button"
        className={`icon-btn icon-btn--bar${secondaryOpen ? ' is-on' : ''}`}
        onClick={onToggleSecondary}
        title={secondaryOpen ? '收起二级栏' : '展开二级栏'}
        aria-label={secondaryOpen ? '收起二级栏' : '展开二级栏'}
        aria-pressed={secondaryOpen}
      >
        <PanelIcon size={15} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--bar"
        disabled
        title="深色主题；浅色外壳待卡片主题通道接入（M6）"
        aria-label="主题：深色（浅色待接入）"
      >
        <PaletteIcon size={15} />
      </button>
    </header>
  );
}
