import { useEffect, useRef } from 'react';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import type { CardBroker } from './broker';

/**
 * A user card (a sandboxed iframe).
 *
 * ── The sandbox attribute is `allow-scripts` and nothing else ──
 *
 * **`allow-same-origin` is not granted** (contract `spec/03` §6):
 * with it, all the cards would share one origin and **card A could read the
 * storage of card B** (measured; see ADR-D28).
 * Every iframe is an **independent opaque origin**, so the cards cannot see
 * each other and cannot reach the host.
 */
export function UserCard({
  info,
  broker,
}: {
  info: CardInstanceInfo;
  broker: CardBroker;
}): JSX.Element {
  const ref = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const frame = ref.current;
    // `contentWindow` may be null (not laid out yet / already unmounted)
    if (frame === null || frame.contentWindow === null) return;
    broker.attach({ contentWindow: frame.contentWindow }, info.instanceId);
    return () => {
      broker.detach(info.instanceId);
    };
  }, [broker, info.instanceId]);

  return (
    <iframe
      ref={ref}
      className="user-card"
      sandbox="allow-scripts"
      src={info.url}
      title={info.cardId}
    />
  );
}
