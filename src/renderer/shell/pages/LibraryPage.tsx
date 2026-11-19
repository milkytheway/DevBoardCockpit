import { useEffect, useMemo, useState } from 'react';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import { cardLook } from '../cards';
import { pick, useLocale } from '../i18n';
import { shortId } from '../format';
import {
  ActivityIcon,
  BoardIcon,
  CpuIcon,
  GaugeIcon,
  LayersIcon,
  MemoryIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ThermometerIcon,
} from '../Icons';

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
  const [query, setQuery] = useState('');
  const locale = useLocale();
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
          <h1 className="page-head__title">卡片库</h1>
          <p className="page-head__sub">
            {cards.length} 张卡片 · {degraded} 张降级 · 卡片是文件，改一行就热更新
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh}>
            <RefreshIcon size={14} />
            重新扫描
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled
            title="AI 造卡依赖 M7 的 MCP 工具集"
          >
            <PlusIcon size={14} />
            AI 造卡 · M7
          </button>
        </div>
      </header>

      <div className="library">
        <aside className="library__list">
          <header className="library__list-head">
            <div>
              <span className="eyebrow">已发现</span>
              <strong>{cards.length} 张卡片</strong>
            </div>
            <span className="library__list-count">{cards.length}</span>
          </header>
          <label className="library__search">
            <SearchIcon size={14} />
            <input
              value={query}
              placeholder="按卡片 id 过滤…"
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
                      <span className="library-row__title">{pick(look.name, locale)}</span>
                      <span className="library-row__sub">
                        {card.cardId} · {card.connectionId ? shortId(card.connectionId) : '未连接'}
                      </span>
                    </span>
                    <span className={`live-dot live-dot--${card.degraded ? 'warn' : 'ok'}`} />
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="library__empty">
                {cards.length === 0
                  ? '还没有卡片。把卡片文件夹放进用户卡片目录，热插拔会自己发现它。'
                  : '没有匹配的卡片。'}
              </li>
            ) : null}
          </ul>
          <div className="library__hint">
            <p>卡片是文件夹，不是插件。</p>
            <p className="dim">AI 造卡 · M7 起；现在先读 docs/spec/03 的 manifest 格式。</p>
          </div>
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
                    <h2>{pick(cardLook(selected.cardId).name, locale)}</h2>
                    <p className="dim mono">{selected.cardId}</p>
                  </div>
                </div>
                <div className="library__badges">
                  <span className={`state-chip state-chip--${selected.degraded ? 'warn' : 'ok'}`}>
                    <span className={`live-dot live-dot--${selected.degraded ? 'warn' : 'ok'}`} />
                    {selected.degraded ? '降级 · 校验错误' : '校验通过'}
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
                    <h3>{pick(cardLook(selected.cardId).note, locale)}</h3>
                    <p>
                      卡片的实际渲染发生在工作台。这里展示实例元信息与沙箱边界——不是又一个
                      iframe。
                    </p>
                  </div>
                </div>
                <div className="library__preview-pills">
                  <span>opaque origin</span>
                  <span>CSP · connect-src none</span>
                  <span>存储 · 宿主代管</span>
                </div>
              </div>

              <dl className="kv kv--compact library__meta">
                <dt>连接</dt>
                <dd className="mono">{selected.connectionId ?? '未连接（v1 单连接）'}</dd>
                <dt>实例</dt>
                <dd className="mono">{shortId(selected.instanceId)}</dd>
                <dt>入口</dt>
                <dd className="mono ellipsis">{selected.url}</dd>
                <dt>发现方式</dt>
                <dd>用户卡片目录 / 内置卡片目录（宿主扫描）</dd>
                <dt>权限</dt>
                <dd>manifest 声明，宿主在 main 过滤 · 本页不猜</dd>
                <dt>热更新</dt>
                <dd>文件变化 → 校验 → 重载 iframe</dd>
              </dl>

              <div className="library__actions">
                {/* **「放到工作台」要真的摆进去**——
                    只切页的话，用户落到一个空网格上，还得自己去侧边栏找这张卡。 */}
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => onPlaceOnWorkbench(selected)}
                >
                  放到工作台
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => onOpenDetail(selected)}
                >
                  打开详情
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh}>
                  重新扫描
                </button>
              </div>
            </>
          ) : (
            <div className="library__blank">
              <LayersIcon size={28} />
              <h2>卡片库</h2>
              <p>卡片是文件。把文件夹放进用户卡片目录就会出现在这里；改一行文件就热更新。</p>
              <button type="button" className="btn btn--primary" disabled>
                安装卡片 · 目录扫描
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
