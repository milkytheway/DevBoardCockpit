/**
 * The base styles of a card: the set that the host injects into the cards.
 *
 * ── Why the host pushes styles into the cards ──
 *
 * Contract section 6 says that cards must not hard-code colours and may
 * only use the CSS variables the host injects — but handing over the
 * variables alone is not enough: a card author may still draw
 * `unavailable` as a grey zero. (Mixing up "cannot be read" and "really
 * zero" is the mistake this product must never make.)
 *
 * → So the host hands over the visual language of the states as well: the
 *   card author only has to pick a class name, and then it is impossible to
 *   draw a state wrongly.
 *
 * ── One hard rule ──
 *
 * No colour value may appear in this file — only `var(--cockpit-*)`. When
 * the skin changes, this injected block changes with it, and no card has to
 * change by a single line.
 */
export function baseStyleBlock(): string {
  return `/* The base style of the cockpit - injected by the host (__host/theme.css)
   Only var(--cockpit-*), no colour values at all: the skin changes and this follows. */
html, body {
  user-select: none;
  -webkit-user-select: none;
}
input, textarea, select, [contenteditable='true'] {
  user-select: text;
  -webkit-user-select: text;
}
.cockpit-value {
  font-family: var(--cockpit-font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: var(--cockpit-type-metric);
  line-height: 1.05;
  letter-spacing: -0.02em;
  color: var(--cockpit-text);
}
.cockpit-value--stale { color: var(--cockpit-text-dim); }
.cockpit-value--error { color: var(--cockpit-danger); }
.cockpit-unit {
  font-size: var(--cockpit-type-body);
  color: var(--cockpit-text-dim);
  margin-left: 3px;
}
.cockpit-label {
  font-size: var(--cockpit-type-caption);
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--cockpit-text-dim);
}
.cockpit-note { font-size: var(--cockpit-type-caption); color: var(--cockpit-text-faint); }
.cockpit-age {
  font-family: var(--cockpit-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--cockpit-type-caption);
  color: var(--cockpit-text-faint);
}
/* unavailable: a hatched ground + **no number** (the usual sign of an instrument that does not read) */
.cockpit-unavailable {
  display: inline-block;
  min-width: 54px;
  height: 1.05em;
  border: 1px dashed var(--cockpit-border-strong);
  border-radius: 2px;
  background: repeating-linear-gradient(
    45deg,
    transparent,
    transparent 4px,
    var(--cockpit-border) 4px,
    var(--cockpit-border) 5px
  );
}
/* waiting for the first sample: a skeleton (it must not flash and make people anxious) */
.cockpit-pending {
  display: inline-block;
  width: 54px;
  height: 0.85em;
  border-radius: 2px;
  background: linear-gradient(
    90deg,
    var(--cockpit-bg-elevated),
    var(--cockpit-surface-active),
    var(--cockpit-bg-elevated)
  );
  background-size: 200% 100%;
  animation: cockpit-shimmer 1.6s linear infinite;
}
@keyframes cockpit-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .cockpit-pending { animation: none; }
}
.cockpit-degraded { color: var(--cockpit-warn); }
.cockpit-broken {
  border: 1px solid var(--cockpit-danger);
  border-radius: var(--cockpit-radius-panel);
  padding: var(--cockpit-space-3);
  color: var(--cockpit-danger);
}
`;
}
