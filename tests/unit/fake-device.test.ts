import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagSampler } from '../../src/main/tags/sampler';
import { TagStore } from '../../src/main/tags/store';
import { loadBoardPack } from '../../src/main/tags/pack';
import { SessionLog } from '../../src/main/logging/session-log';
import { FakeConnection } from '../../src/main/hal/fake/connection';
import { FakeDevice } from '../../src/main/hal/fake/device';
import { fakeExecOutput } from '../../src/main/hal/fake/exec';
import { fakeMode, fakeProfile, FAKE_PROFILE_ID } from '../../src/main/hal/fake/profile';
import { capabilitiesFor } from '../../src/main/hal/capabilities';

/**
 * The fake device (a **fake board** for debugging).
 *
 * What this test has to prove:
 *
 * 1. **The fake device only emits raw text** — the percentages and the five
 *    states are decided by the **real code** (real kind + real store + real
 *    sampler);
 * 2. **All five states are reachable** — whoever tunes the interface has to
 *    see `unavailable` and `error`, otherwise those two states of the
 *    interface are states that were **never designed**;
 * 3. **The first reading is pending, not 0** (rule 5);
 * 4. **With the switch off it does not exist**.
 *
 * Why a real pack:
 *
 * The fake device replaces only the layer that "talks to the board". How the
 * data snippets are composed, how the markers are cut, how the kinds are
 * parsed, how the states migrate — **all of it is real code**, so this test
 * exercises the real chain.
 */

const REPO = join(__dirname, '../..');
const PACK = loadBoardPack(join(REPO, 'profiles/boards/rk3588-atk'));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-fake-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A clock that can be advanced (the fake device integrates its counters with it) */
function makeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

interface Harness {
  store: TagStore;
  sampler: TagSampler;
  /** The fake connection itself (for the session-level judgments). */
  connection: FakeConnection;
  advance: (ms: number) => void;
  close: () => void;
}

/**
 * Builds a "real pack + real sampler + real store" and replaces only the
 * connection with a fake one.
 */
function makeHarness(
  opts: { timeoutEvery?: number; breakMeminfoEvery?: number } = {},
): Harness {
  const clock = makeClock();
  const log = new SessionLog({ label: 'fake', transport: 'local', dataDir: dir });
  const store = new TagStore();
  const connection = new FakeConnection({ now: clock.now, log, ...opts });
  const sampler = new TagSampler(PACK, connection, store, clock.now);
  return { store, sampler, connection, advance: clock.advance, close: () => log.close() };
}

describe('the fake device · the switch and the profile', () => {
  it('**it is on by default** ✓ (the user decided it on 2026-11-21 ✓) — `off` turns it off ✓', () => {
    expect(fakeMode({})).toBe('on');
    expect(fakeMode({ COCKPIT_FAKE: '   ' })).toBe('on');
    expect(fakeMode({ COCKPIT_FAKE: 'maybe' })).toBe('on');
    expect(fakeMode({ COCKPIT_FAKE: 'off' })).toBe('off');
    expect(fakeMode({ COCKPIT_FAKE: '0' })).toBe('off');
  });

  it('1 / on / true → on; only → only it', () => {
    expect(fakeMode({ COCKPIT_FAKE: '1' })).toBe('on');
    expect(fakeMode({ COCKPIT_FAKE: 'ON' })).toBe('on');
    expect(fakeMode({ COCKPIT_FAKE: 'only' })).toBe('only');
  });

  it('the fake profile carries a board_pack — otherwise the candidate selection does not pick it', () => {
    const profile = fakeProfile();
    expect(profile.id).toBe(FAKE_PROFILE_ID);
    // The candidate selection keeps only the profiles that carry a board_pack
// (tags/runtime.ts)
    expect(profile.board_pack).toBe('rk3588-atk');
  });
});

describe('the fake device · the raw text (it does not compute percentages itself)', () => {
  it('the debugfs path of the NPU does not exist → it cannot be read (so npu.usage reports unavailable)', () => {
    const device = new FakeDevice({ now: () => 0 });
    expect(device.read('/sys/kernel/debug/rknpu/load')).toBeNull();
  });

  it('the counters of /proc/stat increase monotonically — the usage is a difference of two samples, so there has to be an increment', () => {
    const clock = makeClock(0);
    const device = new FakeDevice({ now: clock.now });
    const totalOf = (text: string): number => {
      const line = text.split('\n')[0]!;
      return line
        .split(/\s+/)
        .slice(1)
        .reduce((sum, field) => sum + Number(field), 0);
    };
    const first = device.read('/proc/stat')!;
    clock.advance(1000);
    const second = device.read('/proc/stat')!;
    expect(totalOf(second)).toBeGreaterThan(totalOf(first));
  });

  it('when meminfo is broken MemAvailable is missing — it may not be replaced by 0 (that would make the usage 100%)', () => {
    const device = new FakeDevice({ now: () => 0 });
    expect(device.read('/proc/meminfo')).toContain('MemAvailable');
    device.brokenMeminfo = true;
    expect(device.read('/proc/meminfo')).not.toContain('MemAvailable');
  });
});

describe('the fake device · that little shell', () => {
  const device = () => new FakeDevice({ now: () => 1000 });

  it('the echo inside the data snippet is printed as well — the separator line of proc_stat may not be swallowed', () => {
    // **This is a regression test**: it used to cut the string by marker,
    // the separator line `--- cpuinfo ---` was taken for a marker,
    // the kind reported parse_error while the cause was hidden in the fake device.
    const out = fakeExecOutput(
      device(),
      "echo 'S1'; cat -- '/proc/stat'; echo '--- cpuinfo ---'; cat -- '/proc/cpuinfo'; echo 'E1'",
    );
    expect(out).toContain('--- cpuinfo ---');
    // Behind the separator line there is still the content of the cpuinfo (that
// section was not cut off)
    expect(out).toContain('CPU part');
  });

  it('the file does not exist → not a single byte (so that tag reports unavailable, not 0)', () => {
    const out = fakeExecOutput(device(), "cat -- '/sys/kernel/debug/rknpu/load'");
    expect(out).toBe('');
  });

  it('an unrecognised command → nothing at all (it does not guess)', () => {
    const out = fakeExecOutput(device(), 'rm -rf / ; reboot');
    expect(out).toBe('');
  });

  it('a for loop: the glob expansion and the substitution of variables', () => {
    const out = fakeExecOutput(
      device(),
      'for d in /sys/class/thermal/thermal_zone*; do printf \'%s=%s\\n\' "$(cat -- "$d/type" 2>/dev/null)" "$(cat -- "$d/temp" 2>/dev/null)"; done',
    );
    expect(out).toContain('soc-thermal=');
    expect(out).toContain('gpu-thermal=');
    expect(out).toContain('npu-thermal=');
    // Three lines
    expect(out.trim().split('\n')).toHaveLength(3);
  });
});

describe('the fake device · the terminal session', () => {
  it('the banner really has to be sent (at the moment of the construction there is no listener yet, so sending at that moment is sending nothing)', async () => {
    const h = makeHarness();
    const session = await h.connection.openSession();
    const chunks: string[] = [];
    session.onData((chunk: string) => chunks.push(chunk));
    const text = chunks.join('');
    // **The terminal has to say that this is synthetic data** (otherwise somebody
// reads the fake numbers as real ones)
    expect(text).toContain('synthetic data');
    expect(text).toContain('cockpit-fake-device/1');
    h.close();
  });

  it('typing exit has to end the session really (otherwise the interface keeps a dead tab)', async () => {
    const h = makeHarness();
    const session = await h.connection.openSession();
    let exited: number | null | undefined;
    session.onExit((code: number | null) => {
      exited = code;
    });
    session.write('exit\r');
    expect(exited).toBe(0);
    h.close();
  });

  it('the fake profile declares the pipe mode (with pty=true the host only forwards the raw keys, and the command never matches)', () => {
    // **The consequence of pty=true**: xterm sends one key as one byte,
    // so `uname` arrives in the session as the five characters 'u','n','a','m','e'
// — it never matches,
    // and there is no prompt and no echo (those are the things the host does in
// the pipe mode).
    expect(fakeProfile().options['pty']).toBe(false);
  });

  it('the capability bits are decided by the profile (the connection may not keep a copy of its own)', async () => {
    const h = makeHarness();
    // `capabilitiesFor` is the **only implementation** of the capability bits
// (hal/capabilities.ts)
    expect(h.connection.capabilities()).toEqual(capabilitiesFor(fakeProfile()));
    h.close();
  });

  it('the fake device **has a disk now**, but **a thing that is not there still reports an error** (reporting success and transferring nothing is lying)', async () => {
    const h = makeHarness();
    // The file is not on the disk → **an error**, not "reporting success and
// transferring nothing"
    await expect(h.connection.pull('/tmp/nothing-here', join(dir, 'y'))).rejects.toThrow(/fake device/);
    // The file is not on this machine → **an error**
    await expect(h.connection.push(join(dir, 'not-there'), '/tmp/')).rejects.toThrow(/on this host/);
    h.close();
  });
});

describe('the fake device · where the failures are injected', () => {
  it('the broken meminfo is injected only when meminfo is really read (the fast group may not break the memory)', async () => {
    const h = makeHarness({ breakMeminfoEvery: 1 });
    await h.sampler.sampleGroup('fast');
    // The commands of the fast group do not include meminfo → the memory may not
// be broken
    expect(h.store.get('mem.usage')).toBeUndefined();
    await h.sampler.sampleGroup('slow');
    expect(h.store.get('mem.usage')?.status).toBe('error');
    h.close();
  });

  it('the timeout lands only on the fast group (the readings of the slow group may not be taken away by the timeout of the fast group)', async () => {
    const h = makeHarness({ timeoutEvery: 1 });
    await h.sampler.sampleGroup('fast');
    await h.sampler.sampleGroup('slow');
    // A timeout of the fast group: cpu.usage never succeeded → error (not stale)
    expect(h.store.get('cpu.usage')?.status).toBe('error');
    // The slow group is not affected
    expect(h.store.get('mem.usage')?.status).toBe('ok');
    h.close();
  });
});

describe('the fake device · over the real chain (real pack + real kind + real store + real sampler)', () => {
  it('the first reading of cpu.usage is pending — not 0', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('fast');
    const reading = h.store.get('cpu.usage');
    expect(reading?.status).toBe('pending');
    expect(reading?.value).toBeNull();
    h.close();
  });

  it('the second sample of cpu.usage is ok, and it is a real number between 0 and 100', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('fast');
    h.advance(1000);
    await h.sampler.sampleGroup('fast');
    const reading = h.store.get('cpu.usage');
    expect(reading?.status).toBe('ok');
    expect(typeof reading?.value).toBe('number');
    expect(reading!.value as number).toBeGreaterThan(0);
    expect(reading!.value as number).toBeLessThan(100);
    h.close();
  });

  it('the GPU of the same group is ok on the first sample (it does not need two samples)', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('fast');
    const reading = h.store.get('gpu.usage');
    expect(reading?.status).toBe('ok');
    expect(typeof reading?.value).toBe('number');
    h.close();
  });

  it('the NPU cannot be read → unavailable — the value is null, not 0', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('fast');
    const reading = h.store.get('npu.usage');
    expect(reading?.status).toBe('unavailable');
    expect(reading?.value).toBeNull();
    h.close();
  });

  it('the round trip times out → stale, and the previous value is kept (one hiccup may not make the whole instrument disappear)', async () => {
    const h = makeHarness({ timeoutEvery: 2 });
    await h.sampler.sampleGroup('fast');
    h.advance(1000);
    await h.sampler.sampleGroup('fast');
    const reading = h.store.get('gpu.usage');
    expect(reading?.status).toBe('stale');
    expect(reading?.reason).toBe('timeout');
    expect(reading?.value).not.toBeNull();
    h.close();
  });

  it('meminfo is broken → error (the value is kept, because it had succeeded before)', async () => {
    const h = makeHarness({ breakMeminfoEvery: 2 });
    await h.sampler.sampleGroup('slow');
    const first = h.store.get('mem.usage');
    expect(first?.status).toBe('ok');
    h.advance(1000);
    await h.sampler.sampleGroup('slow');
    const reading = h.store.get('mem.usage');
    expect(reading?.status).toBe('error');
    expect(reading?.reason).toBe('parse_error');
    h.close();
  });

  it('the available memory is on the scale of GiB (a few MiB would make the usage 99.9%)', async () => {
    // **A bug found by measurement**: the fake device wrote the available memory
// as "4 MiB ± 1.5 MiB",
    // while the total is 8 GiB → the usage is 99.9% — **the panel says the board
// is busy while it is idle**.
    // That is exactly the "worst kind of false number" the contract N2 describes.
    const h = makeHarness();
    await h.sampler.sampleGroup('slow');
    const available = h.store.get('mem.available_bytes');
    const total = h.store.get('mem.total_bytes');
    expect(available?.status).toBe('ok');
    expect(total?.status).toBe('ok');
    // The available amount is at least a quarter of the total
    expect((available!.value as number) / (total!.value as number)).toBeGreaterThan(0.25);
    // The usage may not be "fully loaded"
    expect(h.store.get('mem.usage')!.value as number).toBeLessThan(90);
    h.close();
  });

  it('the temperatures are merged by type, not by the number of the zone', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('slow');
    const soc = h.store.get('temp.soc');
    expect(soc?.status).toBe('ok');
    // Millidegrees → degrees Celsius
    expect(soc!.value as number).toBeGreaterThan(20);
    expect(soc!.value as number).toBeLessThan(120);
    h.close();
  });

  it('the model of the board can be read (the way through file reading works as well)', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('rare');
    const reading = h.store.get('board.model');
    expect(reading?.status).toBe('ok');
    expect(reading?.value).toBe('ATK-DLRK3588');
    h.close();
  });
});
