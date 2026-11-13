import { useEffect, useRef } from 'react';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import type { CardBroker } from './broker';

/**
 * 一张用户卡（沙箱 iframe）。
 *
 * ── 沙箱属性只有 `allow-scripts` ──
 *
 * **不给 `allow-same-origin`**（契约 `spec/03` §六）：
 * 给了它，所有卡就共享一个源 → **A 卡能读 B 卡的存储**（实测，见 ADR-D28）。
 * 每个 iframe 是一个**独立的不透明源** → 卡片之间互不可见，也碰不到宿主。
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
    // `contentWindow` 可能是 null（还没布局 / 已被卸载）
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
