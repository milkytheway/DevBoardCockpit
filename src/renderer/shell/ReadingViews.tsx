import type { TagReading } from '../../shared/tag-reading';
import { clockText, readingMeta, readingValueText } from './format';

/** Shape + colour + text: the seven-state language must survive colour blindness. */
export function StatusGlyph({ reading }: { reading: TagReading | undefined }): JSX.Element {
  const meta = readingMeta(reading);
  return (
    <span className={`glyph glyph--${meta.tone}`} title={meta.detail || meta.label} aria-label={meta.label}>
      {meta.glyph}
    </span>
  );
}

export function ReadingRow({
  reading,
  active,
  onClick,
}: {
  reading: TagReading;
  active?: boolean;
  onClick?: (tag: string) => void;
}): JSX.Element {
  const meta = readingMeta(reading);
  const value = readingValueText(reading);
  return (
    <button
      type="button"
      className={`reading-row ${active ? 'is-active' : ''} tone-${meta.tone}`}
      onClick={() => onClick?.(reading.tag)}
    >
      <StatusGlyph reading={reading} />
      <span className="reading-row__tag">{reading.tag}</span>
      <span className="reading-row__value">
        {meta.showValue ? value.value : '—'}
        {meta.showValue && value.unit ? <small>{value.unit}</small> : null}
      </span>
      <span className="reading-row__meta">
        {meta.label}
        {meta.detail ? <span className="reading-row__detail"> · {meta.detail}</span> : null}
      </span>
      <span className="reading-row__age">{meta.showValue ? clockText(reading.at) : ''}</span>
    </button>
  );
}

export function ReadingsTable({
  readings,
  onSelect,
  activeTag,
}: {
  readings: TagReading[];
  onSelect?: (tag: string) => void;
  activeTag?: string | null;
}): JSX.Element {
  if (readings.length === 0) {
    return <p className="empty-note">还没有读数。等板子连上、采样跑起来，这里会自己长出来。</p>;
  }
  return (
    <table className="readings-table">
      <thead>
        <tr>
          <th>状态</th>
          <th>tag</th>
          <th className="num">值</th>
          <th>说明</th>
          <th className="num">最后采样</th>
        </tr>
      </thead>
      <tbody>
        {readings.map((reading) => {
          const meta = readingMeta(reading);
          const value = readingValueText(reading);
          return (
            <tr
              key={reading.tag}
              className={`tone-${meta.tone} ${activeTag === reading.tag ? 'is-active' : ''}`}
              onClick={() => onSelect?.(reading.tag)}
            >
              <td>
                <StatusGlyph reading={reading} /> <span className="readings-table__state">{meta.label}</span>
              </td>
              <td className="mono">{reading.tag}</td>
              <td className="num mono">
                {meta.showValue ? value.value : '—'}
                {meta.showValue && value.unit ? <small> {value.unit}</small> : null}
              </td>
              <td className="dim">{meta.detail || '—'}</td>
              <td className="num dim">{meta.showValue ? clockText(reading.at) : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
