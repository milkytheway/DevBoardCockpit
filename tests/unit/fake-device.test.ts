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

/**
 * 假设备（调试用的一块**假板子**）。
 *
 * ── 这个测试要证明什么 ──
 *
 * 1. **假设备只吐原始文本**——百分比与五态由**真代码**判出来
 *    （真 kind + 真 store + 真采样器）；
 * 2. **五态都可达**——调 UI 的人必须能看见 `unavailable` 与 `error`，
 *    否则他设计的界面里那两个状态是**没设计过**的状态；
 * 3. **首读是 pending 而不是 0**（规则 5）；
 * 4. **开关关着时它不存在**。
 *
 * ── 为什么用真包 ──
 *
 * 假设备顶替的只是「跟板子说话」那一层。
 * 取数片段怎么合成、marker 怎么切、kind 怎么解析、五态怎么迁移——
 * **全是真代码在跑**，所以这个测试测到的是真的那条链路。
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

/** 一个可推进的时钟（假设备靠它积分计数器） */
function makeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

interface Harness {
  store: TagStore;
  sampler: TagSampler;
  advance: (ms: number) => void;
  close: () => void;
}

/**
 * 搭一套「真包 + 真采样器 + 真 store」，只把连接换成假的。
 */
function makeHarness(
  opts: { timeoutEvery?: number; breakMeminfoEvery?: number } = {},
): Harness {
  const clock = makeClock();
  const log = new SessionLog({ label: 'fake', transport: 'local', dataDir: dir });
  const store = new TagStore();
  const connection = new FakeConnection({ now: clock.now, log, ...opts });
  const sampler = new TagSampler(PACK, connection, store, clock.now);
  return { store, sampler, advance: clock.advance, close: () => log.close() };
}

describe('假设备 · 开关与 profile', () => {
  it('环境变量没给、给的是别的 → 关', () => {
    expect(fakeMode({})).toBe('off');
    expect(fakeMode({ COCKPIT_FAKE: '   ' })).toBe('off');
    expect(fakeMode({ COCKPIT_FAKE: 'maybe' })).toBe('off');
  });

  it('1 / on / true → 开；only → 只有它', () => {
    expect(fakeMode({ COCKPIT_FAKE: '1' })).toBe('on');
    expect(fakeMode({ COCKPIT_FAKE: 'ON' })).toBe('on');
    expect(fakeMode({ COCKPIT_FAKE: 'only' })).toBe('only');
  });

  it('假 profile 带 board_pack —— 不然候选挑选选不上它', () => {
    const profile = fakeProfile();
    expect(profile.id).toBe(FAKE_PROFILE_ID);
    // 候选挑选只留带 board_pack 的 profile（tags/runtime.ts）
    expect(profile.board_pack).toBe('rk3588-atk');
  });
});

describe('假设备 · 原始文本（它不自己算百分比）', () => {
  it('NPU 的 debugfs 路径不存在 → 读不到（于是 npu.usage 报 unavailable）', () => {
    const device = new FakeDevice({ now: () => 0 });
    expect(device.read('/sys/kernel/debug/rknpu/load')).toBeNull();
  });

  it('/proc/stat 的计数器单调递增 —— 占用率是两次做差，得有增量', () => {
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

  it('meminfo 坏掉时少了 MemAvailable —— 不能拿 0 顶上（那会让占用率变 100%）', () => {
    const device = new FakeDevice({ now: () => 0 });
    expect(device.read('/proc/meminfo')).toContain('MemAvailable');
    device.brokenMeminfo = true;
    expect(device.read('/proc/meminfo')).not.toContain('MemAvailable');
  });
});

describe('假设备 · 那个小 shell', () => {
  const device = () => new FakeDevice({ now: () => 1000 });

  it('取数片段里的 echo 也要输出 —— proc_stat 的分隔行不能被吃掉', () => {
    // **这条是回归测试**：曾经按 marker 切字符串，
    // 分隔行 `--- cpuinfo ---` 被当成了 marker，
    // kind 报 parse_error，而原因藏在假设备里。
    const out = fakeExecOutput(
      device(),
      "echo 'S1'; cat -- '/proc/stat'; echo '--- cpuinfo ---'; cat -- '/proc/cpuinfo'; echo 'E1'",
    );
    expect(out).toContain('--- cpuinfo ---');
    // 分隔行之后还有 cpuinfo 的内容（说明那一段没被截断）
    expect(out).toContain('CPU part');
  });

  it('文件不存在 → 一个字都没有（于是那个 tag 报 unavailable，不是 0）', () => {
    const out = fakeExecOutput(device(), "cat -- '/sys/kernel/debug/rknpu/load'");
    expect(out).toBe('');
  });

  it('认不出来的命令 → 什么都不给（不猜）', () => {
    const out = fakeExecOutput(device(), 'rm -rf / ; reboot');
    expect(out).toBe('');
  });

  it('for 循环：glob 展开 + 变量替换', () => {
    const out = fakeExecOutput(
      device(),
      'for d in /sys/class/thermal/thermal_zone*; do printf \'%s=%s\\n\' "$(cat -- "$d/type" 2>/dev/null)" "$(cat -- "$d/temp" 2>/dev/null)"; done',
    );
    expect(out).toContain('soc-thermal=');
    expect(out).toContain('gpu-thermal=');
    expect(out).toContain('npu-thermal=');
    // 三行
    expect(out.trim().split('\n')).toHaveLength(3);
  });
});

describe('假设备 · 走真实链路（真包 + 真 kind + 真 store + 真采样器）', () => {
  it('首读 cpu.usage 是 pending —— 不是 0', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('fast');
    const reading = h.store.get('cpu.usage');
    expect(reading?.status).toBe('pending');
    expect(reading?.value).toBeNull();
    h.close();
  });

  it('第二次采样 cpu.usage 是 ok，且是 0..100 之间的真数', async () => {
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

  it('同一组里的 GPU 一次就出 ok（它不需要两次采样）', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('fast');
    const reading = h.store.get('gpu.usage');
    expect(reading?.status).toBe('ok');
    expect(typeof reading?.value).toBe('number');
    h.close();
  });

  it('NPU 读不到 → unavailable —— 值是 null，不是 0', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('fast');
    const reading = h.store.get('npu.usage');
    expect(reading?.status).toBe('unavailable');
    expect(reading?.value).toBeNull();
    h.close();
  });

  it('往返超时 → stale，且保留上一个值（一次抖动不该让仪表整片消失）', async () => {
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

  it('meminfo 坏掉 → error（值保留，因为之前成功过）', async () => {
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

  it('温度按 type 归并，不按 zone 序号', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('slow');
    const soc = h.store.get('temp.soc');
    expect(soc?.status).toBe('ok');
    // 毫度 → 摄氏度
    expect(soc!.value as number).toBeGreaterThan(20);
    expect(soc!.value as number).toBeLessThan(120);
    h.close();
  });

  it('板子型号读得出来（文件读取那条路也是通的）', async () => {
    const h = makeHarness();
    await h.sampler.sampleGroup('rare');
    const reading = h.store.get('board.model');
    expect(reading?.status).toBe('ok');
    expect(reading?.value).toBe('ATK-DLRK3588');
    h.close();
  });
});
