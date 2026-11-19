import type { ActivityEntry, ActivityLevel } from '../types';
import { useT, type Localised } from '../i18n';
import { ListIcon } from '../Icons';

/**
 * **界面文案** —— 用户读得到的字都在这一张表里 ✓。
 *
 * 词条挨着用到它的代码，`t()` 按当前语言挑一条 ✓。
 */
const strings = {
  title: { 'zh-Hans': '运行日志', en: 'Activity log' },
  subtitleTail: {
    'zh-Hans': '宿主自己的故事，不是板子的数据',
    en: 'the story of the host, not the data of the board',
  },
  entriesCount: { 'zh-Hans': '条记录', en: 'entries' },
  errorsCount: { 'zh-Hans': '条错误', en: 'errors' },
  levelInfo: { 'zh-Hans': '信息', en: 'Info' },
  levelWarn: { 'zh-Hans': '警告', en: 'Warn' },
  levelError: { 'zh-Hans': '错误', en: 'Error' },
  emptyTitle: { 'zh-Hans': '还没有记录', en: 'Nothing recorded yet' },
  emptyFilterTitle: { 'zh-Hans': '这个筛选下没有记录', en: 'Nothing recorded under this filter' },
  emptyBody: {
    'zh-Hans': '打开终端、摆卡片、传文件——这些动作会出现在这里。',
    en: 'Opening a terminal, placing a card, moving a file — those actions show up here.',
  },
} satisfies Record<string, Localised>;

/**
 * The log page: what the host did, newest first.
 *
 * ── the host's own story, not the board's data ──
 *
 * Readings belong to the cards. This stream is the **host's** story:
 * sessions opened, cards scanned, transfers done. It is the page you open
 * when something did not happen and you want to know why.
 */
const LEVEL_LABEL: Record<ActivityLevel, Localised> = {
  info: strings.levelInfo,
  warn: strings.levelWarn,
  error: strings.levelError,
};

export function LogsPage({
  activity,
  filter,
}: {
  activity: ActivityEntry[];
  filter: 'all' | ActivityLevel;
}): JSX.Element {
  const t = useT();
  const shown = filter === 'all' ? activity : activity.filter((entry) => entry.level === filter);
  const errors = activity.filter((entry) => entry.level === 'error').length;
  return (
    <div className="page page--logs">
      <header className="page-head">
        <div className="page-head__text">
          <span className="page-head__eyebrow">ACTIVITY</span>
          <h1 className="page-head__title">{t(strings.title)}</h1>
          <p className="page-head__sub">
            {activity.length} {t(strings.entriesCount)} · {errors} {t(strings.errorsCount)} · {t(strings.subtitleTail)}
          </p>
        </div>
      </header>

      {shown.length === 0 ? (
        <div className="page-empty">
          <span className="page-empty__icon" aria-hidden>
            <ListIcon size={26} />
          </span>
          <h2>{activity.length === 0 ? t(strings.emptyTitle) : t(strings.emptyFilterTitle)}</h2>
          <p>{t(strings.emptyBody)}</p>
        </div>
      ) : (
        <ol className="log-list">
          {shown.map((entry) => (
            <li key={entry.id} className={`log-row log-row--${entry.level}`}>
              <span className={`log-row__rail live-dot--${entry.level === 'error' ? 'danger' : entry.level === 'warn' ? 'warn' : 'ok'}`} aria-hidden />
              <span className={`log-row__level log-row__level--${entry.level}`}>
                {t(LEVEL_LABEL[entry.level])}
              </span>
              <span className="log-row__message">{entry.message}</span>
              <time className="log-row__time mono">{new Date(entry.at).toLocaleTimeString()}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}