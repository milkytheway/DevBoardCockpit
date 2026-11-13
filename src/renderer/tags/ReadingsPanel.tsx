import { useEffect, useState } from 'react';
import type { TagReading } from '../../shared/tag-reading';
import type { RuntimeStatus } from '../../shared/runtime-status';

/**
 * 最小读数面板。
 *
 * ── 判据是「面板上的数自己在动」──
 *
 * 不是「有一条 IPC 通道」——那只能抓到一种失败。
 * 「自己在动」能抓到三种：**调度器没跑**、**store 没更新**、**renderer 没订阅**。
 *
 * ── 显示规则照抄契约 §2.1，**别自己简化** ──
 *
 * | status | 显示什么 |
 * |---|---|
 * | `ok` | 值 |
 * | `stale` | **旧值** + 「（已过时）」 |
 * | `error` + 有值 | **旧值** + 「（读取失败，显示的是上一次的值）」 |
 * | `error` + 无值 | 「读取失败」 |
 * | `unavailable` | 「不可用」+ reason（**不显示数值**） |
 * | `pending` | 「…」 |
 *
 * ⚠️ `stale` 与 `error` **要显示旧值**——
 * 契约 §2.1.1：「`stale` 保留旧值」「拿到 `error` 且有值时，
 * 显示『读取失败（显示的是上一次的值）』」。
 * **「状态不对就不显示数值」是错的**：那会把契约特意保留的旧值也藏掉。
 */

/** 值的显示 */
function formatValue(reading: TagReading): string {
  if (reading.value === null) return '—';
  const text = String(reading.value);
  return reading.unit === '-' ? text : `${text} ${reading.unit}`;
}

/** 一个读数该显示什么 */
export function describeReading(reading: TagReading): string {
  switch (reading.status) {
    case 'ok':
      return formatValue(reading);
    case 'stale':
      return `${formatValue(reading)}（已过时）`;
    case 'error':
      return reading.value === null
        ? '读取失败'
        : `${formatValue(reading)}（读取失败，显示的是上一次的值）`;
    case 'unavailable':
      return reading.detail ? `不可用：${reading.detail}` : '不可用';
    case 'pending':
      return '…';
    default:
      return '—';
  }
}

/** 状态对应的 CSS 类（用现有的 token，不引 UI 库——O1 未拍板） */
function statusClass(reading: TagReading): string {
  switch (reading.status) {
    case 'ok':
      return 'readings-panel__value readings-panel__value--ok';
    case 'stale':
      return 'readings-panel__value readings-panel__value--stale';
    case 'error':
      return 'readings-panel__value readings-panel__value--error';
    case 'unavailable':
      return 'readings-panel__value readings-panel__value--unavailable';
    default:
      return 'readings-panel__value';
  }
}

/**
 * 没有读数时，**按运行时的状态说人话**。
 *
 * 「还没有读数——等一个采样周期」这句话**在板子没插上的时候是假的**：
 * 真实原因是「连不上：串口 COM3 被占用」或「这块板没有板型包」，
 * 等一个采样周期解决不了「板子没插」。
 *
 * `status === null` = **宿主没有这个通道**（旧宿主）→ 退回旧文案，不崩。
 */
export function describeEmptyState(status: RuntimeStatus | null): string {
  if (status === null) return '还没有读数——等一个采样周期。';
  switch (status.state) {
    case 'error':
      return status.detail !== undefined ? `连不上：${status.detail}` : '连不上。';
    case 'no-pack':
      return status.detail !== undefined ? status.detail : '这块板没有板型包。';
    case 'running':
      return '正在采样——还没有读数。';
    default:
      return '还没有读数——等一个采样周期。';
  }
}

export function ReadingsPanel(): JSX.Element {
  const [readings, setReadings] = useState<TagReading[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const api = window.cockpit;
    // **面板取不到读数，不该把整个应用带崩**——
    // preload 少了通道（或者根本不是我们这个版本）时，面板自己降级，
    // 终端与文件浏览器照常能用。
    if (
      api === undefined ||
      typeof api.tagsReadings !== 'function' ||
      typeof api.onTagChanged !== 'function'
    ) {
      setError('宿主 API 里没有读数通道（preload 没加载？）');
      return () => undefined;
    }

    // 1) **先取快照**：晚订阅的人不该看到一片空白
    void api
      .tagsReadings()
      .then((list) => {
        if (alive) setReadings(list);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });

    // 2) 再听变化：值自己会动
    const off = api.onTagChanged((reading) => {
      setReadings((prev) => {
        const at = prev.findIndex((r) => r.tag === reading.tag);
        if (at < 0) return [...prev, reading];
        const next = prev.slice();
        next[at] = reading;
        return next;
      });
    });

    return () => {
      alive = false;
      off();
    };
  }, []);

  /**
   * 运行时的状态**只在没有读数时**才有意义
   * （有读数时，读数自己的五态已经在说同一件事了）。
   *
   * 所以：**没有读数时每 3 秒问一次**；一旦有读数就停——
   * 板子插上以后，状态会自己从「连不上」变成「运行中」。
   */
  useEffect(() => {
    if (readings.length > 0) return () => undefined;
    const api = window.cockpit;
    // **旧宿主没有这个通道**：面板自己降级（不是每个宿主都有新通道）
    if (api === undefined || typeof api.tagsStatus !== 'function') return () => undefined;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (): void => {
      void api
        .tagsStatus()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => undefined);
      timer = setTimeout(ask, 3000);
    };
    ask();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [readings.length]);

  return (
    <section className="readings-panel" aria-label="读数">
      <h2 className="readings-panel__title">读数</h2>
      {error !== null ? <p className="readings-panel__error">{error}</p> : null}
      {error === null && readings.length === 0 ? (
        <p className="readings-panel__empty">{describeEmptyState(status)}</p>
      ) : null}
      <ul className="readings-panel__list">
        {readings.map((reading) => (
          <li key={reading.tag} className="readings-panel__row" data-testid={`reading-${reading.tag}`}>
            <span className="readings-panel__tag">{reading.tag}</span>
            <span className={statusClass(reading)}>{describeReading(reading)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
