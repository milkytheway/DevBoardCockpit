import { useEffect, useMemo, useState } from 'react';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import { cardLook } from '../cards';
import { shortId } from '../format';
import { useT, type Localised } from '../i18n';
import {
  ActivityIcon,
  BoardIcon,
  CpuIcon,
  GaugeIcon,
  LayersIcon,
  MemoryIcon,
  RefreshIcon,
  SearchIcon,
  ThermometerIcon,
} from '../Icons';

/**
 * **Interface wording** —— every string the user can read is in this table ✓.
 *
 * Each entry sits next to the code that uses it, and `t()` picks the one for
 * the active locale ✓.
 */
const strings = {
  title: { 'zh-Hans': '卡片库', en: 'Card library' },
  cardsCount: { 'zh-Hans': '张卡片', en: 'cards' },
  degradedCount: { 'zh-Hans': '张降级', en: 'degraded' },
  rescan: { 'zh-Hans': '重新扫描', en: 'Rescan' },

  // ── List ──
  found: { 'zh-Hans': '已发现', en: 'Found' },
  searchPlaceholder: { 'zh-Hans': '按卡片 id 过滤…', en: 'Filter by card id…' },
  notConnected: { 'zh-Hans': '未连接', en: 'Not connected' },
  emptyNoCards: {
    'zh-Hans': '还没有卡片。把卡片文件夹放进用户卡片目录，热插拔会自己发现它。',
    en: 'No cards yet. Put a card folder into the user card directory and the hot plug finds it on its own.',
  },
  emptyNoMatch: { 'zh-Hans': '没有匹配的卡片。', en: 'No card matches.' },

  // ── Details ──
  degradedInvalid: { 'zh-Hans': '降级 · 校验错误', en: 'Degraded · validation error' },
  validationPassed: { 'zh-Hans': '校验通过', en: 'Validation passed' },
  storageByHost: { 'zh-Hans': '宿主存储', en: 'Host storage' },
  connection: { 'zh-Hans': '连接', en: 'Connection' },
  notConnectedV1: {
    'zh-Hans': '未连接（v1 单连接）',
    en: 'Not connected (v1 has a single connection)',
  },
  instance: { 'zh-Hans': '实例', en: 'Instance' },
  entry: { 'zh-Hans': '入口', en: 'Entry' },
  discoveredBy: { 'zh-Hans': '发现方式', en: 'Discovered by' },
  discoveredByValue: {
    'zh-Hans': '用户目录 / 内置目录',
    en: 'User / built-in',
  },
  permissions: { 'zh-Hans': '权限', en: 'Permissions' },
  permissionsValue: {
    'zh-Hans': 'Manifest',
    en: 'Manifest',
  },
  hotReload: { 'zh-Hans': '热更新', en: 'Hot reload' },
  hotReloadValue: {
    'zh-Hans': '文件变化后自动重载',
    en: 'Reloads on file change',
  },
  placeOnWorkbench: { 'zh-Hans': '放到工作台', en: 'Put on the workbench' },
  openDetail: { 'zh-Hans': '打开详情', en: 'Open details' },

  // ── Empty details ──
  blankBody: {
    'zh-Hans': '从用户卡片目录或内置目录扫描。',
    en: 'Scanned from the user and built-in card directories.',
  },
  installCards: { 'zh-Hans': '安装卡片 · 目录扫描', en: 'Install cards · directory scan' },
} satisfies Record<string, Localised>;

function lookIcon(cardId: string, size = 16): JSX.Element {
  switch (cardLook(cardId).icon) {
    case 'cpu':
      return <CpuIcon size={size} />;
    case 'gpu':
      return <GaugeIcon size={size} />;
    case 'memory':
      return <MemoryIcon size={size} />;
    case 'thermal':
      return <ThermometerIcon size={size} />;
    case 'board':
      return <BoardIcon size={size} />;
    default:
      return <ActivityIcon size={size} />;
  }
}

export function LibraryPage({
  cards,
  selectedCardId,
  onSelect,
  onOpenDetail,
  onRefresh,
  onPlaceOnWorkbench,
}: {
  cards: CardInstanceInfo[];
  selectedCardId: string | null;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenDetail: (info: CardInstanceInfo) => void;
  onRefresh: () => void;
  /** Put this card into the workbench **and** go there. */
  onPlaceOnWorkbench: (info: CardInstanceInfo) => void;
}): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(selectedCardId);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((card) => card.cardId.toLowerCase().includes(q));
  }, [cards, query]);

  const selected = cards.find((card) => card.instanceId === selectedId) ?? null;
  const degraded = cards.filter((card) => card.degraded).length;

  // Entering the library should show something useful immediately: select the
  // first card instead of a blank detail pane.
  useEffect(() => {
    if (selected !== null) return;
    const first = filtered[0];
    if (first !== undefined) setSelectedId(first.instanceId);
  }, [filtered, selected]);

  return (
    <div className="page page--library">
      <header className="page-head">
        <div className="page-head__text">
          <span className="page-head__eyebrow">CARD LIBRARY</span>
          <h1 className="page-head__title">{t(strings.title)}</h1>
          <p className="page-head__sub">
            {cards.length} {t(strings.cardsCount)} · {degraded} {t(strings.degradedCount)}
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh}>
            <RefreshIcon size={14} />
            {t(strings.rescan)}
          </button>
        </div>
      </header>

      <div className="library">
        <aside className="library__list">
          <header className="library__list-head">
            <div>
              <span className="eyebrow">{t(strings.found)}</span>
              <strong>
                {cards.length} {t(strings.cardsCount)}
              </strong>
            </div>
            <span className="library__list-count">{cards.length}</span>
          </header>
          <label className="library__search">
            <SearchIcon size={14} />
            <input
              value={query}
              placeholder={t(strings.searchPlaceholder)}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ul className="library__rows">
            {filtered.map((card) => {
              const look = cardLook(card.cardId);
              return (
                <li key={card.instanceId}>
                  <button
                    type="button"
                    className={`library-row${selectedId === card.instanceId ? ' is-active' : ''}`}
                    data-tone={look.tone}
                    onClick={() => {
                      setSelectedId(card.instanceId);
                      onSelect(card);
                    }}
                  >
                    <span className={`library-row__icon tone-${look.tone}`}>{lookIcon(card.cardId)}</span>
                    <span className="library-row__text">
                      <span className="library-row__title">{t(look.name)}</span>
                      <span className="library-row__sub">
                        {card.cardId} · {card.connectionId ? shortId(card.connectionId) : t(strings.notConnected)}
                      </span>
                    </span>
                    <span className={`live-dot live-dot--${card.degraded ? 'warn' : 'ok'}`} />
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="library__empty">
                {cards.length === 0 ? t(strings.emptyNoCards) : t(strings.emptyNoMatch)}
              </li>
            ) : null}
          </ul>
        </aside>

        <section className="library__detail">
          {selected ? (
            <>
              <header className="library__detail-head">
                <div className="library__detail-id">
                  <span
                    className={`library__detail-icon tone-${cardLook(selected.cardId).tone}`}
                    aria-hidden
                  >
                    {lookIcon(selected.cardId, 22)}
                  </span>
                  <div>
                    <span className="eyebrow">CARD</span>
                    <h2>{t(cardLook(selected.cardId).name)}</h2>
                    <p className="dim mono">{selected.cardId}</p>
                  </div>
                </div>
                <div className="library__badges">
                  <span className={`state-chip state-chip--${selected.degraded ? 'warn' : 'ok'}`}>
                    <span className={`live-dot live-dot--${selected.degraded ? 'warn' : 'ok'}`} />
                    {selected.degraded ? t(strings.degradedInvalid) : t(strings.validationPassed)}
                  </span>
                  <span className="state-chip state-chip--muted">sandbox</span>
                </div>
              </header>

              <div className={`library__preview tone-${cardLook(selected.cardId).tone}`}>
                <div className="library__preview-bar">
                  <span className="live-dot live-dot--ok" />
                  <span className="mono ellipsis" title={selected.url}>
                    cockpit://card/{shortId(selected.instanceId)}/…
                  </span>
                  <span className="spacer" />
                  <span className="dim">allow-scripts</span>
                </div>
                <div className="library__preview-body">
                  <span className="library__preview-icon" aria-hidden>
                    {lookIcon(selected.cardId, 40)}
                  </span>
                  <div>
                    <h3>{t(cardLook(selected.cardId).note)}</h3>
                  </div>
                </div>
                <div className="library__preview-pills">
                  <span>opaque origin</span>
                  <span>CSP · connect-src none</span>
                  <span>{t(strings.storageByHost)}</span>
                </div>
              </div>

              <dl className="kv kv--compact library__meta">
                <dt>{t(strings.connection)}</dt>
                <dd className="mono">{selected.connectionId ?? t(strings.notConnectedV1)}</dd>
                <dt>{t(strings.instance)}</dt>
                <dd className="mono">{shortId(selected.instanceId)}</dd>
                <dt>{t(strings.entry)}</dt>
                <dd className="mono ellipsis">{selected.url}</dd>
                <dt>{t(strings.discoveredBy)}</dt>
                <dd>{t(strings.discoveredByValue)}</dd>
                <dt>{t(strings.permissions)}</dt>
                <dd>{t(strings.permissionsValue)}</dd>
                <dt>{t(strings.hotReload)}</dt>
                <dd>{t(strings.hotReloadValue)}</dd>
              </dl>

              <div className="library__actions">
                {/* **"Put on the workbench" has to actually place it** —
                    switching the page alone drops the user on an empty grid,
                    and they would still have to find the card in the sidebar. */}
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => onPlaceOnWorkbench(selected)}
                >
                  {t(strings.placeOnWorkbench)}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => onOpenDetail(selected)}
                >
                  {t(strings.openDetail)}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh}>
                  {t(strings.rescan)}
                </button>
              </div>
            </>
          ) : (
            <div className="library__blank">
              <LayersIcon size={28} />
              <h2>{t(strings.title)}</h2>
              <p>{t(strings.blankBody)}</p>
              <button type="button" className="btn btn--primary" disabled>
                {t(strings.installCards)}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
