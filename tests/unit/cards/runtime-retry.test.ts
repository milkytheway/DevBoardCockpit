import { describe, it, expect } from 'vitest';
import {
  pickCandidates,
  startWithRetry,
  isPortBusy,
  RETRY_BACKOFF_MS,
  type RuntimeStatus,
} from '../../../src/main/tags/runtime';
import type { ConnectionProfile } from '../../../src/main/profiles/schema';

/**
 * The three decisions of the runtime about "it does not come up".
 *
 * Three real bugs (the P1/P2 of the third audit, measured on 2026-11-13):
 *
 * | # | State | Consequence |
 * |---|---|---|
 * | P2 | the filter of the candidates uses `board_pack !== undefined` | a profile with `board_pack: null` (`local` / `ubuntu-ssh`) **counts as a candidate** → the runtime connects to the host and to the ssh guest, opens two connections for nothing and may even **take the serial port** |
 * | P1 | each candidate is tried once and then it gives up | the board is plugged in later, **the panel stays empty** and the application has to be restarted |
 * | — | a serial port that is held by a terminal is tried as well | a failed serial attempt may **hold the port** and push out the adb that would have worked |
 *
 * The criteria are all here: **who the candidates are · whether the next one is
 * tried after a failure · when it is retried**.
 */

/** Builds a minimally usable profile. The default of `board_pack` = the field was not written at all */
function profile(id: string, boardPack: string | null | undefined): ConnectionProfile {
  return {
    id,
    label: id,
    transport: 'adb',
    ...(boardPack === undefined ? {} : { board_pack: boardPack }),
    options: {},
  };
}

describe('the selection of the candidates of the runtime', () => {
  it('only the profiles that are bound to a board pack are kept — null and the default are both dropped', () => {
    const candidates = pickCandidates([
      profile('local', null),
      profile('no-pack', undefined),
      profile('board', 'rk3588-atk'),
    ]);
    expect(candidates.map((c) => c.profileId)).toEqual(['board']);
  });

  it('a candidate that is bound to a board pack carries its profile along (it is needed later to build the connection)', () => {
    const [candidate] = pickCandidates([profile('board', 'rk3588-atk')]);
    expect(candidate?.profile.id).toBe('board');
    expect(candidate?.profile.board_pack).toBe('rk3588-atk');
  });
});

describe('the criterion of a busy port', () => {
  it('it recognises the error code PORT_BUSY', () => {
    expect(isPortBusy('serial port COM3 is busy', 'PORT_BUSY')).toBe(true);
  });

  it('it does not recognise another failure', () => {
    expect(isPortBusy('adb: device offline')).toBe(false);
    expect(isPortBusy('cannot connect', 'CONN_OPEN_FAILED')).toBe(false);
  });
});

describe('the retry when the runtime is started', () => {
  it('when a candidate fails because the port is busy, the next one is tried', async () => {
    const attempts: string[] = [];
    const runtime = {
      async start(p: ConnectionProfile): Promise<RuntimeStatus> {
        attempts.push(p.id);
        if (p.id === 'serial') {
          return { state: 'error', detail: 'the serial port COM3 is busy', detailCode: 'PORT_BUSY' };
        }
        return { state: 'running', profileId: p.id };
      },
    };

    const status = await startWithRetry(
      runtime,
      pickCandidates([profile('serial', 'rk3588-atk'), profile('adb', 'rk3588-atk')]),
      { sleep: async () => undefined },
    );

    expect(attempts).toEqual(['serial', 'adb']);
    expect(status.state).toBe('running');
  });

  it('when all of them fail it retries with a backoff and stops when the steps are used up', async () => {
    const slept: number[] = [];
    let calls = 0;
    const runtime = {
      async start(): Promise<RuntimeStatus> {
        calls += 1;
        return { state: 'error', detail: 'cannot be reached' };
      },
    };

    const status = await startWithRetry(runtime, pickCandidates([profile('a', 'rk3588-atk')]), {
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([...RETRY_BACKOFF_MS]);
    expect(calls).toBe(RETRY_BACKOFF_MS.length + 1);
    expect(status.state).toBe('error');
  });

  it('when there is no candidate it reports an error right away, it does not spin', async () => {
    const runtime = {
      async start(): Promise<RuntimeStatus> {
        throw new Error('it may not be called');
      },
    };
    const status = await startWithRetry(runtime, [], { sleep: async () => undefined });
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/no connection carries a board pack/);
  });

  it('a candidate whose port is busy is not retried (another program holds the port, waiting for it to exit is the only thing that helps)', async () => {
    const attempts: string[] = [];
    const runtime = {
      async start(p: ConnectionProfile): Promise<RuntimeStatus> {
        attempts.push(p.id);
        if (p.id === 'serial') {
          return { state: 'error', detail: 'the serial port COM3 is busy', detailCode: 'PORT_BUSY' };
        }
        return { state: 'error', detail: 'the board has not come up yet' };
      },
    };

    await startWithRetry(
      runtime,
      pickCandidates([profile('serial', 'rk3588-atk'), profile('adb', 'rk3588-atk')]),
      { sleep: async () => undefined },
    );

    // The serial one was tried only once (the first round), every round after that tries only the adb
    expect(attempts.filter((id) => id === 'serial')).toHaveLength(1);
    expect(attempts.filter((id) => id === 'adb')).toHaveLength(RETRY_BACKOFF_MS.length + 1);
  });
});
