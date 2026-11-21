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
import { pick, useLocale, useT, type Localised } from './i18n';
import type { PageId } from './types';

/**
 * The rail: the app's primary navigation.
 *
 * Seven destinations, one icon each. The glyphs are real inline SVG (not font
 * characters) so they render identically on every Windows box and inherit
 * the current text colour.
 */
const ENTRIES: { id: PageId; label: Localised; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: 'workbench', label: { 'zh-Hans': '工作台', en: 'Workbench' }, icon: GridIcon },
  { id: 'terminal', label: { 'zh-Hans': '终端', en: 'Terminal' }, icon: TerminalIcon },
  { id: 'files', label: { 'zh-Hans': '文件', en: 'Files' }, icon: FolderIcon },
  { id: 'logs', label: { 'zh-Hans': '日志', en: 'Logs' }, icon: ListIcon },
  { id: 'library', label: { 'zh-Hans': '卡片库', en: 'Card library' }, icon: LayersIcon },
  { id: 'wizard', label: { 'zh-Hans': '向导', en: 'Wizard' }, icon: LinkIcon },
  { id: 'settings', label: { 'zh-Hans': '设置', en: 'Settings' }, icon: GearIcon },
];

/** The wording of the rail, in both languages. */
const strings = {
  mainNav: { 'zh-Hans': '主导航', en: 'Main navigation' },
  searchHint: { 'zh-Hans': '搜索 / 命令（Ctrl K）', en: 'Search / commands (Ctrl K)' },
  searchAndCommands: { 'zh-Hans': '搜索和命令', en: 'Search and commands' },
  search: { 'zh-Hans': '搜索', en: 'Search' },
  localShell: { 'zh-Hans': '本地外壳', en: 'Local shell' },
} satisfies Record<string, Localised>;

export function Rail({
  page,
  onPage,
  onOpenPalette,
}: {
  page: PageId;
  onPage: (page: PageId) => void;
  onOpenPalette: () => void;
}): JSX.Element {
  const t = useT();
  const locale = useLocale();
  return (
    <nav className="rail" aria-label={t(strings.mainNav)}>
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
              title={pick(entry.label, locale)}
              // → **A stable e2e hook** ✓ (not a class name ✓ — the shell's
              //   DOM may be replaced wholesale ✓) → the e2e test goes to a
              //   page without knowing the language ✓.
              data-cockpit-page={entry.id}
              onClick={() => onPage(entry.id)}
            >
              <span className="rail__glyph" aria-hidden>
                <Icon size={19} />
              </span>
              <span className="rail__label">{pick(entry.label, locale)}</span>
            </button>
          );
        })}
      </div>
      <div className="rail__foot">
        <button
          type="button"
          className="rail__item rail__palette"
          title={t(strings.searchHint)}
          aria-label={t(strings.searchAndCommands)}
          onClick={onOpenPalette}
        >
          <span className="rail__glyph" aria-hidden>
            <SearchIcon size={18} />
          </span>
          <span className="rail__label">{t(strings.search)}</span>
        </button>
        <span className="rail__status" title={t(strings.localShell)}>
          <span className="live-dot live-dot--ok" aria-hidden />
        </span>
      </div>
    </nav>
  );
}
