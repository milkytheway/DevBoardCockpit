import { useCallback, useEffect, useState } from 'react';
import { CardBroker } from './broker';
import { Board } from './board';
import type { CardInstanceInfo } from '../../shared/ipc-contract';
import type { LayoutUnit } from '../../shared/layout';
import { normalizeLayout } from '../../shared/layout';

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
  /** 有效布局（宿主算好的：没挪过的卡用 manifest 的默认尺寸） */
  const [units, setUnits] = useState<LayoutUnit[]>([]);
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
        .then(async (list) => {
          setCards(list);
          setError(null);
          // **布局跟卡片一起取**（新装的卡要用 manifest 的默认尺寸）
          const layout = await api.layoutGet();
          setUnits(layout.units);
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

  /** 拖完了 → 存起来（**宿主的账**） */
  const onLayoutChange = useCallback((next: LayoutUnit[]) => {
    setUnits(next);
    const api = window.cockpit;
    if (api === undefined || typeof api.layoutSet !== 'function') return;
    void api.layoutSet(normalizeLayout({ units: next, updatedAt: Date.now() }, Date.now()));
  }, []);

  return (
    <section className="card-panel" aria-label="卡片">
      <h2 className="card-panel__title">卡片</h2>
      {error !== null ? <p className="card-panel__error">{error}</p> : null}
      {error === null && cards.length === 0 ? (
        <p className="card-panel__empty">还没有卡片——把一个卡片目录放进卡片根目录就会自动出现。</p>
      ) : null}
      {broker === null ? null : (
        <Board units={units} cards={cards} broker={broker} onLayoutChange={onLayoutChange} />
      )}
    </section>
  );
}
