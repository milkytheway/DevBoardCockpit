/** Tiny dependency-free sparkline. Values are normalised; an empty history draws nothing. */
export function Sparkline({
  values,
  height = 30,
  className,
}: {
  values: readonly number[];
  height?: number;
  className?: string;
}): JSX.Element {
  if (values.length < 2) {
    return <svg className={className} height={height} viewBox="0 0 100 30" aria-hidden />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = 100 / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = (index * step).toFixed(2);
      const y = (2 + (1 - (value - min) / span) * 26).toFixed(2);
      return x + ',' + y;
    })
    .join(' ');
  const area = '0,29 ' + points + ' 100,29';
  return (
    <svg
      className={className}
      height={height}
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polygon points={area} fill="currentColor" opacity="0.10" />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
