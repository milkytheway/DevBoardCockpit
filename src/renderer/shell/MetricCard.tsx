import type { TagReading } from '../../shared/tag-reading';
import { readingMeta, readingValueText } from './format';
import { Sparkline } from './Sparkline';

/** A single metric with its sparkline. Missing readings say "unavailable", never 0. */
export function MetricCard({
  label,
  reading,
  history,
  toneClass,
  footer,
}: {
  label: string;
  reading: TagReading | undefined;
  history: readonly number[];
  toneClass?: string;
  footer?: string;
}): JSX.Element {
  const meta = readingMeta(reading);
  const value = readingValueText(reading);
  const values = history.filter((n) => Number.isFinite(n));
  const min = values.length > 0 ? Math.min(...values) : null;
  const max = values.length > 0 ? Math.max(...values) : null;
  const avg =
    values.length > 0 ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
  return (
    <article className={`host-card metric-card ${toneClass ?? ''} tone-${meta.tone}`}>
      <header className="host-card__head">
        <span className="eyebrow">{label}</span>
        <span className="spacer" />
        <span className="glyph-wrap">
          <span className={`glyph glyph--${meta.tone}`} title={meta.detail || meta.label}>
            {meta.glyph}
          </span>
          <span className="metric-card__state">{meta.label}</span>
        </span>
      </header>
      <div className="metric-card__value">
        {meta.showValue ? (
          <>
            <strong>{value.value}</strong>
            {value.unit ? <small>{value.unit}</small> : null}
          </>
        ) : (
          <span className="metric-card__na">不可用</span>
        )}
      </div>
      <div className="metric-card__spark">
        <Sparkline values={values} height={34} />
      </div>
      <footer className="metric-card__foot">
        <span>
          min <b className="mono">{min === null ? '—' : min.toFixed(1)}</b>
        </span>
        <span>
          avg <b className="mono">{avg === null ? '—' : avg.toFixed(1)}</b>
        </span>
        <span>
          max <b className="mono">{max === null ? '—' : max.toFixed(1)}</b>
        </span>
        <span className="spacer" />
        <span className="dim">{footer ?? (values.length > 0 ? `${values.length} 个样本` : meta.detail)}</span>
      </footer>
    </article>
  );
}
