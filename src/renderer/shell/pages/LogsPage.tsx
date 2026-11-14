import type { ActivityEntry, ActivityLevel } from '../types';

/**
 * The log page: what the host did, newest first.
 *
 * ── the host's own story, not the board's data ──
 *
 * Readings belong to the cards (each card subscribes to the tags it cares
 * about). This stream is the **host's** story: sessions opened, cards
 * scanned, transfers done. It is the page you open when something did not
 * happen and you want to know why.
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
  if (shown.length === 0) {
    return (
      <div className="page page--logs is-empty">
        <p className="logs__empty">还没有记录。</p>
      </div>
    );
  }
  return (
    <div className="page page--logs">
      <ol className="activity-list">
        {shown.map((entry) => (
          <li key={entry.id} className={`activity-list__row is-${entry.level}`}>
            <time className="activity-list__time mono">
              {new Date(entry.at).toLocaleTimeString()}
            </time>
            <span className={`activity-list__level is-${entry.level}`}>
              {LEVEL_LABEL[entry.level]}
            </span>
            <span className="activity-list__message">{entry.message}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
