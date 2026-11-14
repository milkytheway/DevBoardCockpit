import type { CardBroker } from '../cards/broker';
import type { CardInstanceInfo, ConnectionInfo } from '../../shared/ipc-contract';
import type { TagReading } from '../../shared/tag-reading';
import type { LayoutUnit } from '../../shared/layout';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { readingMeta, runtimeText, shortId } from './format';
import { MetricCard } from './MetricCard';
import { ReadingsCard } from './ReadingsCard';
import { ReadingsTable } from './ReadingViews';
import { TargetCard } from './TargetCard';
import { UserGrid } from './UserGrid';
import type { ViewId } from './types';

export interface WorkbenchProps {
  view: ViewId;
  connections: ConnectionInfo[];
  runtime: RuntimeStatus;
  readings: TagReading[];
  history: (tag: string) => readonly number[];
  cards: CardInstanceInfo[];
  units: LayoutUnit[];
  broker: CardBroker | null;
  selectedCardId: string | null;
  activeTag: string | null;
  onSelectTag: (tag: string) => void;
  onSelectCard: (info: CardInstanceInfo) => void;
  onOpenInspector: (info: CardInstanceInfo) => void;
  onLayoutChange: (units: LayoutUnit[]) => void;
  onOpenTerminal: (profileId: string) => void;
  onOpenLibrary: () => void;
}

function CardGrid({
  cards,
  units,
  broker,
  selectedCardId,
  onSelectCard,
  onOpenInspector,
  onLayoutChange,
  onOpenLibrary,
}: Pick<
  WorkbenchProps,
  | 'cards'
  | 'units'
  | 'broker'
  | 'selectedCardId'
  | 'onSelectCard'
  | 'onOpenInspector'
  | 'onLayoutChange'
  | 'onOpenLibrary'
>): JSX.Element {
  if (broker === null) {
    return (
      <article className="host-card host-card--empty">
        <h2>卡片通道还没接上</h2>
        <p>宿主 API 里没有 cardsList：检查 preload 是否是最新构建。</p>
      </article>
    );
  }
  if (cards.length === 0) {
    return (
      <article className="host-card host-card--empty">
        <span className="eyebrow">卡片区</span>
        <h2>还没有卡片</h2>
        <p>卡片就是文件夹：把它放进用户卡片目录就会自己出现；改一行文件就会热更新。</p>
        <button type="button" className="btn btn--primary btn--sm" onClick={onOpenLibrary}>
          去卡片库看看
        </button>
      </article>
    );
  }
  return (
    <UserGrid
      cards={cards}
      units={units}
      broker={broker}
      selectedCardId={selectedCardId}
      onSelect={onSelectCard}
      onOpenInspector={onOpenInspector}
      onLayoutChange={onLayoutChange}
    />
  );
}

function MonitorView({ readings, history }: Pick<WorkbenchProps, 'readings' | 'history'>): JSX.Element {
  const byTag = new Map(readings.map((reading) => [reading.tag, reading]));
  const preferred = ['cpu.usage', 'gpu.usage', 'npu.usage', 'temp.soc', 'mem.used'];
  const labels: Record<string, string> = {
    'cpu.usage': 'CPU 使用率',
    'gpu.usage': 'GPU 使用率',
    'npu.usage': 'NPU 使用率',
    'temp.soc': 'SoC 温度',
    'mem.used': '内存占用',
  };
  const numeric = readings.filter((reading) => typeof reading.value === 'number');
  const tags = preferred.filter((tag) => byTag.has(tag));
  for (const reading of numeric) {
    if (tags.length >= 4) break;
    if (!tags.includes(reading.tag)) tags.push(reading.tag);
  }
  return (
    <>
      <div className="metric-grid">
        {tags.map((tag) => (
          <MetricCard
            key={tag}
            label={labels[tag] ?? tag}
            reading={byTag.get(tag)}
            history={history(tag)}
            footer={tag}
          />
        ))}
        {tags.length === 0 ? (
          <article className="host-card host-card--empty">
            <span className="eyebrow">监控</span>
            <h2>还没有可画的读数</h2>
            <p>等采样跑起来，指标会按语义聚到这里；现在显示的是空态，不是 0。</p>
          </article>
        ) : null}
      </div>
      <article className="host-card host-card--table">
        <header className="host-card__head">
          <span className="eyebrow">读数明细</span>
          <span className="chip chip--ghost">{readings.length} 个 tag</span>
          <span className="spacer" />
          <span className="dim">行高 34 · 密度舒适</span>
        </header>
        <ReadingsTable readings={readings} />
      </article>
    </>
  );
}

function DebugView({
  readings,
  cards,
  connections,
  runtime,
  activeTag,
  onSelectTag,
}: Pick<WorkbenchProps, 'readings' | 'cards' | 'connections' | 'runtime' | 'activeTag' | 'onSelectTag'>): JSX.Element {
  const rt = runtimeText(runtime, connections);
  const active = connections.find((connection) => connection.id === runtime.profileId);
  return (
    <>
      <div className="debug-grid">
        <article className="host-card">
          <header className="host-card__head">
            <span className="eyebrow">运行时</span>
            <span className="spacer" />
            <span className={`chip chip--${rt.tone}`}>
              <span className={`dot dot--${rt.tone}`} />
              {rt.label}
            </span>
          </header>
          <dl className="kv">
            <dt>状态</dt>
            <dd>{rt.label}</dd>
            <dt>目标</dt>
            <dd>{active ? active.label : '—'}</dd>
            <dt>板型包</dt>
            <dd className="mono">{active?.boardPack ?? '—'}</dd>
            <dt>传输</dt>
            <dd className="mono">{active?.transport ?? '—'}</dd>
            <dt>说明</dt>
            <dd>{runtime.detail ?? '—'}</dd>
            <dt>错误码</dt>
            <dd className="mono">{runtime.detailCode ?? '—'}</dd>
          </dl>
        </article>
        <article className="host-card">
          <header className="host-card__head">
            <span className="eyebrow">卡片清单</span>
            <span className="chip chip--ghost">{cards.length} 张</span>
          </header>
          {cards.length === 0 ? (
            <p className="empty-note">没有卡片目录被发现。</p>
          ) : (
            <table className="readings-table">
              <thead>
                <tr>
                  <th>卡片</th>
                  <th>实例</th>
                  <th>连接</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr key={card.instanceId}>
                    <td className="mono">{card.cardId}</td>
                    <td className="mono dim">{shortId(card.instanceId)}</td>
                    <td className="mono dim">{card.connectionId ? shortId(card.connectionId) : '—'}</td>
                    <td>
                      <span className={`chip chip--${card.degraded ? 'warn' : 'ok'} chip--sm`}>
                        {card.degraded ? '降级' : '就绪'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </div>
      <article className="host-card host-card--table">
        <header className="host-card__head">
          <span className="eyebrow">读数 · 全量</span>
          <span className="spacer" />
          <span className="dim">七态：形状 + 颜色 + 文字</span>
        </header>
        <ReadingsTable readings={readings} onSelect={onSelectTag} activeTag={activeTag} />
      </article>
    </>
  );
}

export function Workbench(props: WorkbenchProps): JSX.Element {
  const { view, connections, runtime, readings, history, cards, activeTag, onSelectTag, onOpenTerminal } = props;

  if (view === 'monitor') {
    return (
      <div className="workbench workbench--monitor">
        <MonitorView readings={readings} history={history} />
      </div>
    );
  }

  if (view === 'debug') {
    return (
      <div className="workbench workbench--debug">
        <DebugView
          readings={readings}
          cards={cards}
          connections={connections}
          runtime={runtime}
          activeTag={activeTag}
          onSelectTag={onSelectTag}
        />
      </div>
    );
  }

  return (
    <div className={`workbench workbench--${view}`}>
      <div className="host-strip">
        <TargetCard connections={connections} runtime={runtime} onOpenTerminal={onOpenTerminal} />
        {view === 'overview' ? (
          <ReadingsCard
            readings={readings}
            runtime={runtime}
            connections={connections}
            activeTag={activeTag}
            onSelectTag={onSelectTag}
          />
        ) : (
          <article className="host-card host-card--demo-note">
            <span className="eyebrow">演示视图</span>
            <p>
              只保留目标与卡片，把权限、日志和诊断收起来。切到「调试」能看到完整证据链。
            </p>
            <p className="dim">
              当前 {cards.length} 张卡 · {readings.length} 个 tag
              {readings.some((reading) => readingMeta(reading).tone === 'danger') ? ' · 有读取错误' : ''}
            </p>
          </article>
        )}
      </div>
      <section className="grid-section" aria-label="卡片工作区">
        <header className="grid-section__head">
          <span className="eyebrow">卡片</span>
          <span className="dim">拖标题栏移动 · 拖右下角缩放 · 点标题看检查器</span>
          <span className="spacer" />
          <span className="chip chip--ghost chip--sm">{cards.length} 张</span>
        </header>
        <CardGrid
          cards={props.cards}
          units={props.units}
          broker={props.broker}
          selectedCardId={props.selectedCardId}
          onSelectCard={props.onSelectCard}
          onOpenInspector={props.onOpenInspector}
          onLayoutChange={props.onLayoutChange}
          onOpenLibrary={props.onOpenLibrary}
        />
      </section>
    </div>
  );
}
