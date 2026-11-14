import { useEffect, useMemo, useState } from 'react';
import type { CardInstanceInfo } from '../../../shared/ipc-contract';
import { shortId } from '../format';
import { LayersIcon, RefreshIcon, SearchIcon } from '../Icons';

export function LibraryPage({
  cards,
  selectedCardId,
  onSelect,
  onOpenDetail,
  onRefresh,
  onOpenWorkbench,
}: {
  cards: CardInstanceInfo[];
  selectedCardId: string | null;
  onSelect: (info: CardInstanceInfo) => void;
  onOpenDetail: (info: CardInstanceInfo) => void;
  onRefresh: () => void;
  onOpenWorkbench: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(selectedCardId);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((card) => card.cardId.toLowerCase().includes(q));
  }, [cards, query]);

  const selected = cards.find((card) => card.instanceId === selectedId) ?? null;

  // Entering the library should show something useful immediately: select the
  // first card instead of a blank detail pane.
  useEffect(() => {
    if (selected !== null) return;
    const first = filtered[0];
    if (first !== undefined) setSelectedId(first.instanceId);
  }, [filtered, selected]);

  return (
    <div className="library">
      <aside className="library__list">
        <header className="library__list-head">
          <div>
            <span className="eyebrow">已发现卡片</span>
            <strong>
              {cards.length} 张 · {cards.filter((card) => card.degraded).length} 张降级
            </strong>
          </div>
          <button type="button" className="icon-btn" onClick={onRefresh} title="重新扫描卡片目录">
            <RefreshIcon size={15} />
          </button>
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
          {filtered.map((card) => (
            <li key={card.instanceId}>
              <button
                type="button"
                className={`library-row ${selectedId === card.instanceId ? 'is-active' : ''}`}
                onClick={() => {
                  setSelectedId(card.instanceId);
                  onSelect(card);
                }}
              >
                <span className="library-row__icon">
                  <LayersIcon size={16} />
                </span>
                <span className="library-row__text">
                  <span className="library-row__title">{card.cardId}</span>
                  <span className="library-row__sub">
                    {card.connectionId ? shortId(card.connectionId) : '未连接'} · {shortId(card.instanceId)}
                  </span>
                </span>
                <span className={`dot dot--${card.degraded ? 'warn' : 'ok'}`} />
              </button>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="library__empty">
              {cards.length === 0 ? '还没有卡片。把卡片文件夹放进用户卡片目录，热插拔会自己发现它。' : '没有匹配的卡片。'}
            </li>
          ) : null}
        </ul>
        <div className="library__hint">
          <p>卡片是文件夹，不是插件：改一行文件就热更新。</p>
          <p className="dim">AI 造卡 · M7 起；现在先读 docs/spec/03 的 manifest 格式。</p>
        </div>
      </aside>

      <section className="library__detail">
        {selected ? (
          <>
            <header className="library__detail-head">
              <div>
                <span className="eyebrow">卡片</span>
                <h2>{selected.cardId}</h2>
                <p className="dim mono">{selected.instanceId}</p>
              </div>
              <div className="library__badges">
                <span className={`chip chip--${selected.degraded ? 'warn' : 'ok'}`}>
                  {selected.degraded ? '降级 · 有校验错误' : '校验通过'}
                </span>
                <span className="chip chip--ghost">iframe</span>
              </div>
            </header>
            <div className="library__preview">
              <div className="library__preview-bar">
                <span className="dot dot--ok" />
                <span className="mono ellipsis" title={selected.url}>
                  {selected.url}
                </span>
                <span className="spacer" />
                <span className="dim">sandbox=&quot;allow-scripts&quot;</span>
              </div>
              <div className="library__preview-body">
                <p>卡片的实际渲染发生在工作台里。这里展示的是实例元信息，不是又一个 iframe。</p>
                <dl className="kv">
                  <dt>连接</dt>
                  <dd className="mono">{selected.connectionId ?? '未连接（v1 单连接）'}</dd>
                  <dt>实例</dt>
                  <dd className="mono">{selected.instanceId}</dd>
                  <dt>入口</dt>
                  <dd className="mono ellipsis">{selected.url}</dd>
                </dl>
              </div>
            </div>
            <dl className="kv library__meta">
              <dt>发现方式</dt>
              <dd>用户卡片目录 / 内置卡片目录（宿主扫描）</dd>
              <dt>权限</dt>
              <dd>manifest 声明 read / write，宿主在 main 过滤；本页不猜</dd>
              <dt>存储</dt>
              <dd>按卡片 id 落在用户数据目录，卸载保留</dd>
              <dt>热更新</dt>
              <dd>文件变化 → 校验 → 重载 iframe；不合法保留上一版</dd>
            </dl>
            <div className="library__actions">
              <button type="button" className="btn btn--primary btn--sm" onClick={onOpenWorkbench}>
                放到工作台
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpenDetail(selected)}>
                打开检查器
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
            <p className="dim">
              工作台的布局属于视图，卡片本身属于目录。这个区分让「AI 造卡」和「人摆布局」互不干扰。
            </p>
            <button
              type="button"
              className="btn btn--primary"
              disabled
              title="AI 造卡依赖 M7 的 MCP 工具集；现在先把卡片目录打通。"
            >
              AI 造卡 · M7 起可用
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
