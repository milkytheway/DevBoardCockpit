import { useEffect, useState } from 'react';
import { CardBroker } from './broker';
import { UserCard } from './user-card';
import type { CardInstanceInfo } from '../../shared/ipc-contract';

/**
 * 用户卡区。
 *
 * ── 它做什么 ──
 *
 * 1. 取装着的卡片（`cardsList`）
 * 2. 听「卡片变了」（热插拔）→ 重新取
 * 3. **把窗口的 `message` 事件交给经纪人** —— 卡片的握手就是这么进来的
 * 4. 每张卡渲染一个 `<UserCard>`（沙箱 iframe）
 *
 * ── 它不做什么 ──
 *
 * **不判权限**（那在 main）、**不碰板子**（那也在 main）。
 * 页面只是「把 iframe 摆好、把消息递过去」。
 */
export function CardPanel(): JSX.Element {
  const [cards, setCards] = useState<CardInstanceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  // **用 state 不用 ref**：ref 在渲染时读是「上一帧的值」，
  // 第一次渲染时它是 null，卡片就渲染不出来（要等一次状态变化才补上）。
  const [broker, setBroker] = useState<CardBroker | null>(null);

  useEffect(() => {
    const api = window.cockpit;
    // **宿主没有卡片通道 → 降级**，不把整个应用带崩
    if (api === undefined || typeof api.cardsList !== 'function') {
      setError('宿主 API 里没有卡片通道（preload 没加载？）');
      return () => undefined;
    }

    const broker = new CardBroker(api);
    setBroker(broker);

    const refresh = (): void => {
      void api
        .cardsList()
        .then((list) => {
          setCards(list);
          setError(null);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    refresh();

    const offChanged = typeof api.onCardsChanged === 'function' ? api.onCardsChanged(refresh) : () => undefined;
    const onMessage = (event: MessageEvent): void => {
      broker.handleMessage(event);
    };
    window.addEventListener('message', onMessage);

    return () => {
      offChanged();
      window.removeEventListener('message', onMessage);
      broker.dispose();
      setBroker(null);
    };
  }, []);

  return (
    <section className="card-panel" aria-label="卡片">
      <h2 className="card-panel__title">卡片</h2>
      {error !== null ? <p className="card-panel__error">{error}</p> : null}
      {error === null && cards.length === 0 ? (
        <p className="card-panel__empty">还没有卡片——把一个卡片目录放进卡片根目录就会自动出现。</p>
      ) : null}
      <div className="card-panel__grid">
        {cards.map((info) =>
          broker === null ? null : <UserCard key={info.instanceId} info={info} broker={broker} />,
        )}
      </div>
    </section>
  );
}
