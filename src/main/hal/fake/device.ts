/**
 * ⚠️ **假设备** —— 这里产出的一切都是**合成数据**，不是真板子。
 *
 * 存在的理由：**调 UI 需要一块板子**。
 * 真实板子不插电、adb 没起、串口被占的时候，外壳就调不动。
 *
 * ── 它只吐**原始文本**，不吐解析好的数 ──
 *
 * `/proc/stat` 给 jiffies 计数、`/proc/meminfo` 给 kB、devfreq 给
 * `<占空比>@<频率>Hz`、thermal_zone 给毫度——
 * **百分比与五态由真正的 kind 与真正的 store 算出来**。
 *
 * → 这样「cpu.usage 首读是 pending 而不是 0」「计数器倒退报 parse_error」
 * 「读不到报 unavailable」这些**契约里的行为是被真代码判出来的**，
 * 不是假设备假装出来的。
 *
 * 开关：`COCKPIT_FAKE=1`（假设备优先）或 `COCKPIT_FAKE=only`（只有假设备）。
 */

/**
 * A marker that identifies the fake device in the build output.
 *
 * The build self-check greps for this string: **the production bundle must
 * not contain the fake device** (see `scripts/check-build.ts`).
 *
 * → it lives here (not in `profile.ts`) because this module only ends up
 * in the bundle through the fake device's **dynamic import** ✓.
 */
export const FAKE_DEVICE_MARKER = 'cockpit-fake-device/1';

/** jiffies 每秒（Linux 的 USER_HZ） */
const HZ = 100;

/** 内存总量：8 GiB */
const MEM_TOTAL_KB = 8 * 1024 * 1024;

/** 假的板子有几个核（前 4 个 A55，后 4 个 A76） */
const CORE_COUNT = 8;

/** A55 / A76 的 CPU part（`/proc/cpuinfo` 里认这个） */
const PART_A55 = '0xd05';
const PART_A76 = '0xd0b';

/** 一条确定的「噪声」：同一个时间桶永远是同一个值（测试可复现） */
function noise(seed: number, t: number): number {
  const bucket = Math.floor(t);
  let h = (bucket * 2654435761 + seed * 40503) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h % 1000) / 1000 - 0.5;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export interface FakeDeviceOptions {
  /** The clock (milliseconds). Injected so the tests are reproducible. */
  now: () => number;
}

/**
 * The virtual machine: a file system whose contents move.
 *
 * The **counters integrate a curve** — they are not "the current utilization".
 * That is what makes `cpu.usage` (two samples, differenced) work the way it
 * does on a real board.
 */
export class FakeDevice {
  private readonly now: () => number;
  /** Per core: [busy jiffies, total jiffies]; index 0 is the aggregate. */
  private readonly jiffies: { busy: number; total: number }[] = [];
  /** When the counters were last advanced. */
  private lastAt: number | null = null;

  constructor(opts: FakeDeviceOptions) {
    this.now = opts.now;
    this.jiffies = Array.from({ length: CORE_COUNT + 1 }, () => ({ busy: 0, total: 0 }));
  }

  /** Set before a read: the memory file comes back truncated. */
  brokenMeminfo = false;

  /** The board's "uptime" in seconds (derived from the clock). */
  private uptime(): number {
    return this.now() / 1000;
  }

  /** The CPU utilization at time t (percent). */
  private utilAt(t: number): number {
    return clamp(35 + 22 * Math.sin((2 * Math.PI * t) / 17) + 6 * noise(1, t), 2, 96);
  }

  /** Per core utilization: the A55 cores run lower than the A76 ones. */
  private coreUtilAt(index: number, t: number): number {
    const base = index < 4 ? 18 : 44;
    const amp = index < 4 ? 14 : 26;
    return clamp(base + amp * Math.sin((2 * Math.PI * t) / (19 + index)) + 5 * noise(index + 2, t), 1, 97);
  }

  /** Advance the counters to "now" (called when `/proc/stat` is read). */
  private advance(): void {
    const at = this.now();
    if (this.lastAt === null) {
      // **The first read only records the baseline** — the counter difference
      // is 0 → the kind reports "pending" (not 0) ✓
      this.lastAt = at;
      return;
    }
    const dt = Math.max(0, (at - this.lastAt) / 1000);
    this.lastAt = at;
    const t = this.uptime();
    for (let index = 0; index <= CORE_COUNT; index += 1) {
      const util = index === 0 ? this.utilAt(t) : this.coreUtilAt(index - 1, t);
      const total = dt * HZ;
      this.jiffies[index]!.total += total;
      this.jiffies[index]!.busy += total * (util / 100);
    }
  }

  /** `/proc/stat` — the aggregate line plus one line per core. */
  private procStat(): string {
    this.advance();
    const lines: string[] = [];
    for (let index = 0; index <= CORE_COUNT; index += 1) {
      const { busy, total } = this.jiffies[index]!;
      const idle = total - busy;
      // The kind sums user+nice+system as "busy" and all fields as "total"
      const tag = index === 0 ? 'cpu' : `cpu${index - 1}`;
      lines.push(`${tag} ${Math.round(busy)} 0 0 ${Math.round(idle)} 0 0 0 0 0 0`);
    }
    lines.push('intr 0');
    lines.push('ctxt 0');
    lines.push('btime 1700000000');
    lines.push('processes 1');
    lines.push('procs_running 1');
    lines.push('procs_blocked 0');
    return lines.join('\n');
  }

  /** `/proc/cpuinfo` — the core numbers and their clusters. */
  private procCpuinfo(): string {
    const lines: string[] = [];
    for (let index = 0; index < CORE_COUNT; index += 1) {
      lines.push(`processor\t: ${index}`);
      lines.push('model name\t: ARMv8 Processor rev 0 (v8l)');
      lines.push(`CPU part\t: ${index < 4 ? PART_A55 : PART_A76}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * `/proc/meminfo` — total and available (in kB).
   *
   * `brokenMeminfo` drops the `MemAvailable` line — which is what a real
   * board does when the file is truncated, and it makes the memory reader
   * report `parse_error` (never "100% used" — that would be a lie).
   */
  private procMeminfo(): string {
    const t = this.uptime();
    const availableKb = Math.round(
      (4 * 1024 * 1024 + 1.5 * 1024 * 1024 * Math.sin((2 * Math.PI * t) / 29)) / 1024,
    );
    return [
      `MemTotal:       ${MEM_TOTAL_KB} kB`,
      'MemFree:         262144 kB',
      ...(this.brokenMeminfo ? [] : [`MemAvailable:    ${availableKb} kB`]),
      'Buffers:          65536 kB',
      'Cached:          1048576 kB',
      'SwapCached:            0 kB',
      'Active:          524288 kB',
      'Inactive:        393216 kB',
      'SwapTotal:             0 kB',
      'SwapFree:              0 kB',
      'Dirty:                 0 kB',
      'AnonPages:       262144 kB',
      'Mapped:           65536 kB',
      'Shmem:            32768 kB',
      'Slab:            131072 kB',
      'SReclaimable:     65536 kB',
      'SUnreclaim:       65536 kB',
      'KernelStack:       16384 kB',
      'PageTables:        32768 kB',
      'NFS_Unstable:         0 kB',
      'Percpu:             4096 kB',
      'HardwareCorrupted:     0 kB',
      'AnonHugePages:         0 kB',
      'ShmemPmdMapped:        0 kB',
      'FilePmdMapped:         0 kB',
      'Hugetlb:            0 kB',
      'DirectMap4k:      65536 kB',
      'DirectMap2M:       8192 kB',
      'DirectMap1G:          0 kB',
    ].join('\n');
  }

  /** The thermal zones: `type` and `temp` (millidegrees). */
  private thermalZones(): { dir: string; type: string; temp: number }[] {
    const t = this.uptime();
    const mk = (base: number, period: number, seed: number): number =>
      Math.round((base + 6 * Math.sin((2 * Math.PI * t) / period) + 0.4 * noise(seed, t)) * 1000);
    return [
      { dir: '/sys/class/thermal/thermal_zone0', type: 'soc-thermal', temp: mk(55, 43, 3) },
      { dir: '/sys/class/thermal/thermal_zone1', type: 'gpu-thermal', temp: mk(47, 37, 4) },
      { dir: '/sys/class/thermal/thermal_zone2', type: 'npu-thermal', temp: mk(44, 31, 5) },
    ];
  }

  /**
   * Read a virtual file.
   *
   * @returns The content, or `null` when the file does not exist
   *          (which is how the NPU reports itself absent ✓).
   */
  read(path: string): string | null {
    const p = path.trim();
    if (p === '/proc/stat') return this.procStat();
    if (p === '/proc/cpuinfo') return this.procCpuinfo();
    if (p === '/proc/meminfo') return this.procMeminfo();
    if (p === '/proc/device-tree/model') return 'ATK-DLRK3588';

    for (const zone of this.thermalZones()) {
      if (p === `${zone.dir}/type`) return zone.type;
      if (p === `${zone.dir}/temp`) return String(zone.temp);
    }

    if (p === '/sys/class/devfreq/fb000000.gpu/load') {
      const t = this.uptime();
      const duty = clamp(40 + 25 * Math.sin((2 * Math.PI * t) / 13) + 8 * noise(6, t), 0, 100);
      const freq = Math.round((300e6 + duty * 6e6) / 1e6) * 1e6;
      return `${duty.toFixed(0)}@${freq}Hz`;
    }
    if (p === '/sys/class/devfreq/fb000000.gpu/cur_freq') return '600000000';
    if (p === '/sys/class/devfreq/fdab0000.npu/load') return '100@1000000000Hz';
    if (p === '/sys/class/devfreq/fdab0000.npu/cur_freq') return '1000000000';
    if (p === '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor') return 'schedutil';
    if (p === '/sys/class/backlight/backlight/brightness') return '128';
    if (p === '/sys/class/backlight/backlight1/brightness') return '64';

    // **The NPU's real load file is not there** — the real board does not
    // mount debugfs reliably either → npu.usage reports "unavailable" ✓
    return null;
  }

  /**
   * Expand a glob (only the thermal zones use one).
   */
  glob(pattern: string): string[] {
    if (pattern === '/sys/class/thermal/thermal_zone*') {
      return this.thermalZones().map((zone) => zone.dir);
    }
    return [];
  }
}
