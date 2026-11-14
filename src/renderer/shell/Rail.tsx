import type { PageId } from './types';

/**
 * The rail: the places you can be.
 *
 * ── one entry = one page ──
 *
 * The terminal, the files and the log used to live in a bottom dock, so
 * clicking them in the rail opened a panel underneath. Now each one is a
 * page in the main area and the rail is the only way to reach it.
 */
const ENTRIES: { id: PageId; label: string; glyph: string }[] = [
  { id: 'workbench', label: '工作台', glyph: '▦' },
  { id: 'terminal', label: '终端', glyph: '▤' },
  { id: 'files', label: '文件', glyph: '▥' },
  { id: 'logs', label: '日志', glyph: '▨' },
  { id: 'library', label: '卡片库', glyph: '▩' },
  { id: 'settings', label: '设置', glyph: '⚙' },
];

export function Rail({
  page,
  onPage,
}: {
  page: PageId;
  onPage: (page: PageId) => void;
}): JSX.Element {
  return (
    <nav className="rail" aria-label="主导航">
      {ENTRIES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`rail__item${page === entry.id ? ' is-active' : ''}`}
          aria-current={page === entry.id ? 'page' : undefined}
          title={entry.label}
          onClick={() => onPage(entry.id)}
        >
          <span className="rail__glyph" aria-hidden>
            {entry.glyph}
          </span>
          <span className="rail__label">{entry.label}</span>
        </button>
      ))}
    </nav>
  );
}
