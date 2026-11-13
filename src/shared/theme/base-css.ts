/**
 * 卡片的基础样式：**宿主注入给卡片的那一套**。
 *
 * ── 为什么宿主要给卡片塞样式 ──
 *
 * 契约 §六 说「卡片不得硬编码颜色，只用宿主注入的 CSS 变量」——
 * 但**只给变量不够**：卡片作者仍然可能把 `unavailable` 画成一个灰色的 0。
 * （而「读不到」与「真的是 0」混淆，是这个产品最不能出的错。）
 *
 * → 宿主把**状态的视觉语言也一起给**：卡片作者**只要选一个类名**，
 * 就不可能把状态画错。
 *
 * ── 一条硬规矩 ──
 *
 * **这个文件里不许出现任何色值**——只有 `var(--cockpit-*)`。
 * 皮肤变了，注入的这段跟着变；卡片不用改一行。
 */
export function baseStyleBlock(): string {
  return `/* cockpit 基础样式 —— 宿主注入（__host/theme.css）
   只有 var(--cockpit-*)，没有任何色值：皮肤变了这段自动跟着变。 */
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
/* 不可用：斜纹底 + **没有数字**（航空仪表「此仪表不可用」的惯用符号） */
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
/* 等待第一次采样：骨架（不闪得让人焦虑） */
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
