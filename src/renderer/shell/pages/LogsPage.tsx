import type { ActivityEntry, ActivityLevel } from '../types';
import { ListIcon } from '../Icons';

/**
 * The log page: what the host did, newest first.
 *
 * ── the host's own story, not the board's data ──
 *
 * Readings belong to the cards. This stream is the **host's** story:
 * sessions opened, cards scanned, transfers done. It is the page you open
 * when something did not happen and you want to know why.
 */
const LEVEL_LABEL: Record<ActivityLevel, string> = {
  info: '信息',
  warn: '警告',
  error: '错误',
};

export function LogsPage({
  activity,
  filter,
}: {
  activity: ActivityEntry[];
  filter: 'all' | ActivityLevel;
}): JSX.Element {
  const shown = filter === 'all' ? activity : activity.filter((entry) => entry.level === filter);
  const errors = activity.filter((entry) => entry.level === 'error').length;
  return (
    <div className="page page--logs">
      <header className="page-head">
        <div className="page-head__text">
          <span className="page-head__eyebrow">ACTIVITY</span>
          <h1 className="page-head__title">运行日志</h1>
          <p className="page-head__sub">
            {activity.length} 条记录 · {errors} 条错误 · 宿主自己的故事，不是板子的数据
          </p>
        </div>
      </header>

      {shown.length === 0 ? (
        <div className="page-empty">
          <span className="page-empty__icon" aria-hidden>
            <ListIcon size={26} />
          </span>
          <h2>{activity.length === 0 ? '还没有记录' : '这个筛选下没有记录'}</h2>
          <p>打开终端、摆卡片、传文件——这些动作会出现在这里。</p>
        </div>
      ) : (
        <ol className="log-list">
          {shown.map((entry) => (
            <li key={entry.id} className={`log-row log-row--${entry.level}`}>
              <span className={`log-row__rail live-dot--${entry.level === 'error' ? 'danger' : entry.level === 'warn' ? 'warn' : 'ok'}`} aria-hidden />
              <span className={`log-row__level log-row__level--${entry.level}`}>
                {LEVEL_LABEL[entry.level]}
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
