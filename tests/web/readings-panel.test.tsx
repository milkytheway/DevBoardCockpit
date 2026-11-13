import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReadingsPanel, describeReading } from '../../src/renderer/tags/ReadingsPanel';
import type { TagReading } from '../../src/shared/tag-reading';
import type { RuntimeStatus } from '../../src/shared/runtime-status';

/**
 * 最小读数面板。
 *
 * ── 两条要守住的 ──
 *
 * 1. **晚订阅不丢当前值**：先取快照，再听推送。
 *    只听推送的话，晚打开的窗口会看到一片空白——
 *    而「面板上那个数看起来是真的」比空白更坏（它不动）。
 * 2. **显示规则照抄契约 §2.1**：`stale` 与 `error` **要显示旧值**。
 */

function reading(over: Partial<TagReading> = {}): TagReading {
  return {
    tag: 'cpu.usage',
    value: 12.5,
    unit: 'percent',
    status: 'ok',
    at: 1,
    seq: 1,
    ...over,
  };
}

/** 装一个假的宿主 API。`status` 不给 = 宿主没有 `tagsStatus` 这个通道（旧宿主） */
function installHost(
  initial: TagReading[] = [],
  status?: RuntimeStatus,
): { push: (r: TagReading) => void } {
  const listeners: ((r: TagReading) => void)[] = [];
  (window as unknown as { cockpit: unknown }).cockpit = {
    tagsReadings: async () => initial,
    ...(status === undefined
      ? {}
      : { tagsStatus: async () => status }),
    onTagChanged: (cb: (r: TagReading) => void) => {
      listeners.push(cb);
      return () => {
        const at = listeners.indexOf(cb);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
  return {
    push: (r) => {
      for (const cb of listeners) cb(r);
    },
  };
}

describe('读数面板 · 快照与推送', () => {
  it('**先取快照**：订阅之前就有的读数要显示出来', async () => {
    installHost([reading({ tag: 'cpu.usage', value: 12.5 })]);
    render(<ReadingsPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('reading-cpu.usage')).toBeTruthy();
    });
    expect(screen.getByTestId('reading-cpu.usage').textContent).toContain('12.5');
  });

  it('**听推送**：值自己会变', async () => {
    const host = installHost([reading({ value: 1 })]);
    render(<ReadingsPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('reading-cpu.usage').textContent).toContain('1');
    });

    host.push(reading({ value: 99, seq: 2 }));

    await waitFor(() => {
      expect(screen.getByTestId('reading-cpu.usage').textContent).toContain('99');
    });
  });

  it('宿主 API 不在 → 说清楚，不是一片空白', async () => {
    (window as unknown as { cockpit: unknown }).cockpit = undefined;
    render(<ReadingsPanel />);
    await waitFor(() => {
      expect(screen.getByText(/宿主 API/)).toBeTruthy();
    });
  });

  it('宿主 API **没有读数通道** → 面板降级，**不把应用带崩**', async () => {
    // 「一个面板取不到读数，不该让整个应用崩掉」——
    // preload 少了通道时，终端与文件浏览器照常能用。
    (window as unknown as { cockpit: unknown }).cockpit = {
      connectionsList: async () => [],
    };
    expect(() => render(<ReadingsPanel />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText(/没有读数通道/)).toBeTruthy();
    });
  });
});

describe('显示规则 · 照抄契约 §2.1', () => {
  it('ok → 值', () => {
    expect(describeReading(reading({ status: 'ok', value: 12.5 }))).toBe('12.5 percent');
  });

  it('stale → **旧值** + 「（已过时）」', () => {
    const text = describeReading(reading({ status: 'stale', value: 12.5 }));
    expect(text).toContain('12.5');
    expect(text).toContain('已过时');
  });

  it('error + 有值 → **旧值** + 「显示的是上一次的值」', () => {
    const text = describeReading(reading({ status: 'error', value: 12.5 }));
    expect(text).toContain('12.5');
    expect(text).toContain('上一次的值');
  });

  it('error + 无值 → 「读取失败」', () => {
    expect(describeReading(reading({ status: 'error', value: null }))).toBe('读取失败');
  });

  it('unavailable → 「不可用」+ detail，**不显示数值**', () => {
    const text = describeReading(
      reading({ status: 'unavailable', value: null, detail: 'debugfs 没挂载' }),
    );
    expect(text).toContain('不可用');
    expect(text).toContain('debugfs');
    expect(text).not.toContain('12.5');
  });

  it('pending → 「…」', () => {
    expect(describeReading(reading({ status: 'pending', value: null }))).toBe('…');
  });
});

/**
 * 没有读数的时候，**面板要说人话**。
 *
 * ── 为什么 ──
 *
 * 「还没有读数——等一个采样周期」这句话**在板子没插上的时候是假的**：
 * 真实原因是「连不上：串口 COM3 被占用」或「这块板没有板型包」。
 * **等一个采样周期**解决不了「板子没插」——
 * 这是这个仓库最恨的那种静默失败：**面板看起来在等，其实永远不会来**。
 */
describe('读数面板 · 没有读数时要说人话', () => {
  it('状态是 error：显示原因（而不是「等一个采样周期」）', async () => {
    installHost([], { state: 'error', detail: '串口 COM3 被占用' });
    render(<ReadingsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/串口 COM3 被占用/)).toBeTruthy();
    });
  });

  it('状态是 no-pack：说「没有板型包」', async () => {
    installHost([], { state: 'no-pack', detail: '这块板没有板型包' });
    render(<ReadingsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/板型包/)).toBeTruthy();
    });
  });

  it('宿主没有 tagsStatus 通道（旧宿主）：**不崩**，退回旧文案', async () => {
    installHost([]);
    render(<ReadingsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/还没有读数/)).toBeTruthy();
    });
  });
});
