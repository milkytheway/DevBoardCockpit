import { PanelIcon, PaletteIcon, SearchIcon } from './Icons';
import type { ThemeName } from '../../shared/theme/seed';

/**
 * The status band: the app's title bar.
 *
 * ── why the link state is not here ──
 *
 * The board state used to sit in this band. It now lives in the secondary
 * sidebar's header, next to the page title: the top band is chrome (brand,
 * window controls, command search), the sidebar header is context ("what am
 * I looking at, and is it alive"). That also gives the cards back a row.
 */
export function StatusBar({
  theme,
  onToggleTheme,
  cardCount,
  placedCount,
  secondaryOpen,
  onToggleSecondary,
  onOpenPalette,
}: {
  theme: ThemeName;
  onToggleTheme: () => void;
  /** How many cards are installed. */
  cardCount: number;
  /** How many of them are placed in the main area. */
  placedCount: number;
  secondaryOpen: boolean;
  onToggleSecondary: () => void;
  onOpenPalette: () => void;
}): JSX.Element {
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
        onClick={onToggleTheme}
        title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        aria-label="切换主题"
      >
        <PaletteIcon size={15} />
      </button>
    </header>
  );
}
