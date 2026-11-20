import { describe, it, expect } from 'vitest';
import { RoundTripQueue } from '../../src/main/hal/round-trip-queue';

/**
 * The queue of one round trip (contract `docs/spec/02-board-pack.md` §1.2.1).
 *
 * The four things the contract asks for:
 *
 * | Contract | Which case of this test |
 * |---|---|
 * | one connection has one queue of round trips, the samples and the actions go into the same queue | "serially", "an action cuts the queue" |
 * | **an action has priority over a sample**, the sample gives way | "an action cuts the queue" |
 * | a sample that missed its period because it gave way → **the period is skipped**, it is not made up | (that is the duty of the scheduler) |
 * | after a round trip timed out the next one may only start once the markers are complete or the attempt was given up | (that is the duty of the **transport** — the queue does **not** time out by itself) |
 *
 * The most important one:
 *
 * **Only one round trip is in flight at a time.** A serial port has one
 * wire, one reader thread and one transcript — two concurrent round trips
 * let the answers of two markers interleave in the same transcript. The
 * symptom the contract names is: "**the operator pressed a button and the
 * values on the monitor jumped around**".
 */

/** A controllable closure: it records the order of its calls and lets the caller decide when to let it through */
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

describe('RoundTripQueue · the four levels of priority of ADR-D23', () => {
  it('the four levels: action-verify > manual-refresh > card-sampling > diagnostics', async () => {
    const queue = new RoundTripQueue();
    const order: string[] = [];

    // The queue is occupied first (**when the queue is empty the one that arrived
// first runs** — the priority only applies to **the ones that are waiting**,
    // it cannot idle in the hope of a higher priority request that has not arrived
// yet)
    const blocker = deferred<string>();
    const p0 = queue.run('diagnostics', () => blocker.fn());

    // **Enqueued in reverse order** — which one runs first depends on the priority,
// not on the order of the queue
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

  it('the queue exceeds the limit → it reports conn_busy (it does not queue without end)', async () => {
    const queue = new RoundTripQueue({ maxPending: 2 });
    const d = deferred<string>();
    const p1 = queue.run('card-sampling', () => d.fn());
    const p2 = queue.run('card-sampling', async () => 'second');

    // The third one is **immediately** refused (it does not queue)
    await expect(queue.run('card-sampling', async () => 'third')).rejects.toMatchObject({
      code: 'CONN_BUSY',
    });

    d.release('first');
    await Promise.all([p1, p2]);
  });

  it('the queue exceeds the deadline → it reports conn_busy (that transaction is dropped and not executed)', async () => {
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

    // Time passed while it was queued → its deadline was reached
    clock += 5000;
    d.release('first');

    await expect(p2).rejects.toMatchObject({ code: 'CONN_BUSY' });
    await p1;
    expect(order).toEqual(['first']); // The second one **was not executed**
  });

  it('the deadline can be overridden per transaction', async () => {
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

describe('RoundTripQueue · the queue and the priority of an action', () => {
  it('two samples run **serially**: while the first has not returned, the closure of the second is not called', async () => {
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

    // sample1 has not been let through → the closure of sample2 **must not** be
// called
    await Promise.resolve();
    expect(order).toEqual(['sample1']);

    first.release('first');
    await Promise.all([p1, p2]);
    expect(order).toEqual(['sample1', 'sample2']);
  });

  it('**an action cuts the queue**: while two samples are queued, the action steps between them', async () => {
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

    // An action has priority over a **queued** sample, but it **may not** step
// into the middle of the round trip that is in flight
    expect(order).toEqual(['sample1', 'action', 'sample2']);
  });

  it('**only one round trip is in flight at any moment** — even when the later one is an action', async () => {
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

    // The action **has not** been called — the round trip in flight has to wait
// for it to come back
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

  it('the return value of `run` is the return value of the closure (await passes it through)', async () => {
    const queue = new RoundTripQueue();
    await expect(queue.run('card-sampling', async () => 42)).resolves.toBe(42);
    await expect(queue.run('action-verify', async () => 'acted')).resolves.toBe('acted');
  });

  it('when the closure **throws**, run rejects with the same error and **the queue stays usable**', async () => {
    const queue = new RoundTripQueue();
    const boom = new Error('boom');

    await expect(
      queue.run('card-sampling', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // "a broken lock wastes the channel" is a worse failure
    await expect(queue.run('card-sampling', async () => 'still works')).resolves.toBe('still works');
  });

  it('inside one run the closure is **called exactly once**', async () => {
    const queue = new RoundTripQueue();
    let called = 0;
    await queue.run('card-sampling', async () => {
      called += 1;
      return 'x';
    });
    expect(called).toBe(1);
  });

  it('`busy` reflects "whether a round trip is in flight", `pending` reflects "how many have not started"', async () => {
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
