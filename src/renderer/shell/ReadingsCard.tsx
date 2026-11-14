import type { TagReading } from '../../shared/tag-reading';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { runtimeText } from './format';
import { ReadingRow } from './ReadingViews';

export function ReadingsCard({
  readings,
  runtime,
  connections,
  activeTag,
  onSelectTag,
}: {
  readings: TagReading[];
  runtime: RuntimeStatus;
  connections: Parameters<typeof runtimeText>[1];
  activeTag: string | null;
  onSelectTag: (tag: string) => void;
}): JSX.Element {
  const rt = runtimeText(runtime, connections);
  return (
    <article className="host-card host-card--readings">
      <header className="host-card__head">
        <span className="eyebrow">读数 · 实时</span>
        <span className="chip chip--ghost">{readings.length} 个 tag</span>
        <span className="spacer" />
        <span className={`chip chip--${rt.tone}`}>
          <span className={`dot dot--${rt.tone}`} />
          {rt.label}
        </span>
      </header>
      {readings.length === 0 ? (
        <div className="host-card__empty">
          <p>{rt.label === '采样中' ? '等待第一条读数…' : rt.label}</p>
          <p className="dim">{rt.detail}</p>
        </div>
      ) : (
        <div className="readings-scroll">
          {readings.map((reading) => (
            <ReadingRow
              key={reading.tag}
              reading={reading}
              active={activeTag === reading.tag}
              onClick={onSelectTag}
            />
          ))}
        </div>
      )}
    </article>
  );
}
