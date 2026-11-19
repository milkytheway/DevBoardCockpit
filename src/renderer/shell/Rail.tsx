import {
  FolderIcon,
  GearIcon,
  GridIcon,
  LayersIcon,
  LinkIcon,
  ListIcon,
  SearchIcon,
  TerminalIcon,
} from './Icons';
import type { PageId } from './types';

/**
 * The rail: the app's primary navigation.
 *
 * Seven destinations, one icon each. The glyphs are real inline SVG (not font
 * characters) so they render identically on every Windows box and inherit
 * the current text colour.
 */
const ENTRIES: { id: PageId; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: 'workbench', label: '工作台', icon: GridIcon },
  { id: 'terminal', label: '终端', icon: TerminalIcon },
  { id: 'files', label: '文件', icon: FolderIcon },
  { id: 'logs', label: '日志', icon: ListIcon },
  { id: 'library', label: '卡片库', icon: LayersIcon },
  { id: 'wizard', label: '向导', icon: LinkIcon },
  { id: 'settings', label: '设置', icon: GearIcon },
];

export function Rail({
  page,
  onPage,
  onOpenPalette,
}: {
  page: PageId;
  onPage: (page: PageId) => void;
  onOpenPalette: () => void;
}): JSX.Element {
  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail__stack">
        {ENTRIES.map((entry) => {
          const Icon = entry.icon;
          const active = page === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              className={`rail__item${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              title={entry.label}
              onClick={() => onPage(entry.id)}
            >
              <span className="rail__glyph" aria-hidden>
                <Icon size={19} />
              </span>
              <span className="rail__label">{entry.label}</span>
            </button>
          );
        })}
      </div>
      <div className="rail__foot">
        <button
          type="button"
          className="rail__item rail__palette"
          title="搜索 / 命令（Ctrl K）"
          aria-label="搜索和命令"
          onClick={onOpenPalette}
        >
          <span className="rail__glyph" aria-hidden>
            <SearchIcon size={18} />
          </span>
          <span className="rail__label">搜索</span>
        </button>
        <span className="rail__status" title="本地外壳">
          <span className="live-dot live-dot--ok" aria-hidden />
        </span>
      </div>
    </nav>
  );
}
