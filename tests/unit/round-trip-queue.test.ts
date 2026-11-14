import { describe, it, expect } from 'vitest';
import { RoundTripQueue } from '../../src/main/hal/round-trip-queue';

/**
 * 一次往返的队列（契约 `docs/spec/02-board-pack.md` §1.2.1）。
 *
 * ── 契约要的四件事 ──
 *
 * | 契约 | 这份测试的哪一条 |
 * |---|---|
 * | 一个连接上有一个往返队列，采样与动作都进同一个队列 | 「串行」「动作插队」 |
 * | **动作优先于采样**，采样让路 | 「动作插队」 |
 * | 采样因让路错过本周期 → **跳过本周期**，不补发 | （那是调度器的责任，Task 2） |
 * | 往返超时后必须等 marker 收齐或明确放弃才能开始下一次 | （那是**传输层**的责任——队列**不**自己超时） |
 *
 * ── 最要紧的一条 ──
 *
 * **同一时刻只有一次往返在飞。**
 * 串口上只有一根线、一个读线程、一份 transcript——
 * 两次往返并发会让两个 marker 的回包在同一份 transcript 里交错。
 * 契约点名的症状是：「**点了按钮，监控卡数值乱跳**」。
 */

/** 一个可控的闭包：记录自己被调用的顺序，并让调用方决定何时放行 */
function deferred<T>(): { fn: () => Promise<T>; release: (v: T) => void; called: number } {
  let release!: (v: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  let called = 0;
  return {
    fn: () => {
      called += 1;
      return promise;
    },
    release,
    get called() {
      return called;
    },
  };
}

describe('RoundTripQueue · ADR-D23 的四级优先级', () => {
  it('四级：action-verify > manual-refresh > card-sampling > diagnostics', async () => {
    const queue = new RoundTripQueue();
    const order: string[] = [];

    // 先占住队列（**队列空时先到的先跑** —— 优先级只对**等着的那几条**生效，
    // 不可能为了等一个还没来的高优先级请求而空等）
    const blocker = deferred<string>();
    const p0 = queue.run('diagnostics', () => blocker.fn());

    // **倒着入队** —— 谁先跑，看的是优先级，不是入队顺序
    const p1 = queue.run('diagnostics', async () => {
      order.push('diagnostics');
      return 'd';
    });
    const p2 = queue.run('card-sampling', async () => {
      order.push('card-sampling');
      return 'c';
    });
    const p3 = queue.run('manual-refresh', async () => {
      order.push('manual-refresh');
      return 'm';
    });
    const p4 = queue.run('action-verify', async () => {
      order.push('action-verify');
      return 'a';
    });

    blocker.release('blocker');
    await Promise.all([p0, p1, p2, p3, p4]);
    expect(order).toEqual([
      'action-verify',
      'manual-refresh',
      'card-sampling',
      'diagnostics',
    ]);
  });

  it('排队超过上限 → 报 conn_busy（不无限排队）', async () => {
    const queue = new RoundTripQueue({ maxPending: 2 });
    const d = deferred<string>();
    const p1 = queue.run('card-sampling', () => d.fn());
    const p2 = queue.run('card-sampling', async () => 'second');

    // 第三个**立刻**被拒（不排队）
    await expect(queue.run('card-sampling', async () => 'third')).rejects.toMatchObject({
      code: 'CONN_BUSY',
    });

    d.release('first');
    await Promise.all([p1, p2]);
  });

  it('排队超过 deadline → 报 conn_busy（那条事务被丢掉，不执行）', async () => {
    let clock = 1000;
    const queue = new RoundTripQueue({ now: () => clock });
    const order: string[] = [];

    const d = deferred<string>();
    const p1 = queue.run('card-sampling', async () => {
      order.push('first');
      return d.fn();
    });
    const p2 = queue.run('action-verify', async () => {
      order.push('second');
      return 'second';
    });

    // 排队期间时间过去了 → 它的 deadline 到了
    clock += 5000;
    d.release('first');

    await expect(p2).rejects.toMatchObject({ code: 'CONN_BUSY' });
    await p1;
    expect(order).toEqual(['first']); // 第二条**没有被执行**
  });

  it('deadline 可以按事务覆盖', async () => {
    let clock = 0;
    const queue = new RoundTripQueue({ now: () => clock, deadlineMs: 10_000 });
    const d = deferred<string>();
    const p1 = queue.run('card-sampling', () => d.fn());
    const p2 = queue.run('action-verify', async () => 'second', { deadlineMs: 50 });

    clock += 100;
    d.release('first');

    await expect(p2).rejects.toMatchObject({ code: 'CONN_BUSY' });
    await p1;
  });
});

describe('RoundTripQueue · 排队与动作优先', () => {
  it('两个采样**串行**：前一个没回来，后一个的闭包不会被调用', async () => {
    const queue = new RoundTripQueue();
    const order: string[] = [];

    const first = deferred<string>();
    const p1 = queue.run('card-sampling', async () => {
      order.push('sample1');
      return first.fn();
    });
    const p2 = queue.run('card-sampling', async () => {
      order.push('sample2');
      return 'second';
    });

    // sample1 还没放行 → sample2 的闭包**不应该**被调用
    await Promise.resolve();
    expect(order).toEqual(['sample1']);

    first.release('first');
    await Promise.all([p1, p2]);
    expect(order).toEqual(['sample1', 'sample2']);
  });

  it('**动作插队**：两个采样在排队时，动作插到它们中间', async () => {
    const queue = new RoundTripQueue();
    const order: string[] = [];

    const first = deferred<string>();
    const p1 = queue.run('card-sampling', async () => {
      order.push('sample1');
      return first.fn();
    });
    const p2 = queue.run('card-sampling', async () => {
      order.push('sample2');
      return 'second';
    });
    const p3 = queue.run('action-verify', async () => {
      order.push('action');
      return 'acted';
    });

    first.release('first');
    await Promise.all([p1, p2, p3]);

    // 动作优先于**排队中的**采样，但它**不能**插到飞行中的那次往返中间
    expect(order).toEqual(['sample1', 'action', 'sample2']);
  });

  it('**任何时刻只有一次往返在飞**——哪怕后来的那个是动作', async () => {
    const queue = new RoundTripQueue();
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    let inFlight = 0;
    let maxInFlight = 0;

    const p1 = queue.run('card-sampling', async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const v = await d1.fn();
      inFlight -= 1;
      return v;
    });
    const p2 = queue.run('action-verify', async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const v = await d2.fn();
      inFlight -= 1;
      return v;
    });

    await Promise.resolve();
    await Promise.resolve();

    // 动作**还没**被调用 —— 飞行中的那次往返必须等它回来
    expect(maxInFlight).toBe(1);
    expect(queue.busy).toBe(true);

    d1.release('one');
    await Promise.resolve();
    await Promise.resolve();
    expect(maxInFlight).toBe(1);

    d2.release('two');
    await Promise.all([p1, p2]);
    expect(maxInFlight).toBe(1);
  });

  it('`run` 的返回值是闭包的返回值（await 透传）', async () => {
    const queue = new RoundTripQueue();
    await expect(queue.run('card-sampling', async () => 42)).resolves.toBe(42);
    await expect(queue.run('action-verify', async () => 'acted')).resolves.toBe('acted');
  });

  it('闭包**抛错**时 run reject 同样的错误，且**队列继续可用**', async () => {
    const queue = new RoundTripQueue();
    const boom = new Error('boom');

    await expect(
      queue.run('card-sampling', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // 「一把锁坏了，通道就废了」是更糟的失败
    await expect(queue.run('card-sampling', async () => 'still works')).resolves.toBe('still works');
  });

  it('同一个 run 里闭包**被调用恰好一次**', async () => {
    const queue = new RoundTripQueue();
    let called = 0;
    await queue.run('card-sampling', async () => {
      called += 1;
      return 'x';
    });
    expect(called).toBe(1);
  });

  it('`busy` 反映「有没有往返在飞」，`pending` 反映「还没开始的个数」', async () => {
    const queue = new RoundTripQueue();
    expect(queue.busy).toBe(false);
    expect(queue.pending).toBe(0);

    const d = deferred<string>();
    const p1 = queue.run('card-sampling', () => d.fn());
    const p2 = queue.run('card-sampling', async () => 'second');

    await Promise.resolve();
    expect(queue.busy).toBe(true);
    expect(queue.pending).toBe(1);

    d.release('first');
    await Promise.all([p1, p2]);
    expect(queue.busy).toBe(false);
    expect(queue.pending).toBe(0);
  });
});
