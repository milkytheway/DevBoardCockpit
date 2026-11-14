import type { ConnectionInfo } from '../../shared/ipc-contract';
import type { RuntimeStatus } from '../../shared/runtime-status';
import { capabilitiesText, runtimeText, transportLabel } from './format';
import { CpuIcon } from './Icons';

/**
 * The target/link card is host-rendered: it never leaves the shell's trust boundary.
 * It also carries the old toolbar's "open a terminal" affordance, so no capability
 * is lost when the legacy shell goes away.
 */
export function TargetCard({
  connections,
  runtime,
  onOpenTerminal,
}: {
  connections: ConnectionInfo[];
  runtime: RuntimeStatus;
  onOpenTerminal: (profileId: string) => void;
}): JSX.Element {
  const rt = runtimeText(runtime, connections);
  const active = connections.find((c) => c.id === runtime.profileId);
  return (
    <article className="host-card host-card--target">
      <header className="host-card__head">
        <span className="eyebrow">目标与链路</span>
        <span className="spacer" />
        <span className={`chip chip--${rt.tone}`}>
          <span className={`dot dot--${rt.tone}`} />
          {rt.label}
        </span>
      </header>

      <div className="target-hero">
        <span className="target-hero__icon">
          <CpuIcon size={22} />
        </span>
        <div className="target-hero__text">
          <h2>{active ? active.label : '等待一个连接'}</h2>
          <p>
            {active ? (active.boardPack ?? '未识别板型') : '还没有可用的连接'} ·{' '}
            <span className="mono">{runtime.profileId ?? 'no-profile'}</span>
          </p>
        </div>
      </div>

      <ul className="target-list">
        {connections.map((connection) => {
          const isActive = connection.id === runtime.profileId;
          return (
            <li key={connection.id} className={isActive ? 'is-active' : ''}>
              <span className={`dot dot--${isActive ? 'ok' : 'muted'}`} />
              <span className="target-list__label" title={connection.label}>
                {connection.label}
              </span>
              <span className="chip chip--ghost">{transportLabel(connection.transport)}</span>
              <span className="target-list__pack mono" title={connection.boardPack ?? ''}>
                {connection.boardPack ?? '—'}
              </span>
              <span className="target-list__caps">{capabilitiesText(connection)}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onOpenTerminal(connection.id)}
                title="在底部终端里打开这个连接"
              >
                终端
              </button>
            </li>
          );
        })}
        {connections.length === 0 ? (
          <li className="target-list__empty">还没有连接。先在 profiles/targets 里放一个目标。</li>
        ) : null}
      </ul>
    </article>
  );
}
