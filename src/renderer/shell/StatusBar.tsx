import type { ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { ageText, runtimeText } from './format';
import { PaletteIcon, SearchIcon } from './Icons';
import type { ThemeMode } from './theme';

export function StatusBar({
  theme,
  onToggleTheme,
  runtime,
  connections,
  readingCount,
  cardCount,
  lastReadingAt,
  onOpenPalette,
}: {
  theme: ThemeMode;
  onToggleTheme: () => void;
  runtime: RuntimeStatus;
  connections: ConnectionInfo[];
  readingCount: number;
  cardCount: number;
  lastReadingAt: number | null;
  onOpenPalette: () => void;
}): JSX.Element {
  const rt = runtimeText(runtime, connections);
  return (
    <header className="statusbar" data-testid="statusbar">
      <div className="statusbar__brand">
        <span className="statusbar__mark" aria-hidden>
          <span className="statusbar__mark-dot" />
        </span>
        <span className="statusbar__name">DevBoard Cockpit</span>
        <span className="statusbar__version">v0.5 · M5b</span>
      </div>
      <span className="statusbar__divider" />
      <span className={`chip chip--${rt.tone}`} data-testid="runtime-chip">
        <span className={`dot dot--${rt.tone}`} />
        {rt.label}
        <span className="chip__detail">{rt.detail}</span>
      </span>
      <span className="chip chip--ghost chip--sm">
        <span className="mono">{readingCount}</span> tags
      </span>
      <span className="chip chip--ghost chip--sm">
        <span className="mono">{cardCount}</span> cards
      </span>
      <span className="spacer" />
      <span className="statusbar__meta">
        {lastReadingAt === null ? '暂无采样' : '最后更新 ' + ageText(lastReadingAt)}
      </span>
      <button type="button" className="statusbar__palette" onClick={onOpenPalette}>
        <SearchIcon size={13} />
        <span>搜索 / 命令</span>
        <kbd>Ctrl K</kbd>
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--status"
        onClick={onToggleTheme}
        title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
        aria-label="切换主题"
      >
        <PaletteIcon size={15} />
      </button>
    </header>
  );
}
