/**
 * ⚠️ **The fake device** — everything produced here is **synthetic data**, not
 * a real board.
 *
 * The reason it exists: **developing the UI needs a board**.
 * When the real board is not plugged in, adb is not up and the serial line is
 * taken, the shell cannot be worked on.
 *
 * ── It only emits **raw text**, not parsed numbers ──
 *
 * `/proc/stat` gives jiffies counters, `/proc/meminfo` gives kB, devfreq gives
 * `<duty cycle>@<frequency>Hz`, thermal_zone gives millidegrees —
 * **the percentages and the five states are computed by the real kinds and the
 * real store**.
 *
 * → That way the behaviours of the contract — "the first read of `cpu.usage`
 * is pending and not 0", "a counter that goes backwards reports a parse_error",
 * "a file that cannot be read reports unavailable" — are **judged by the real
 * code** and not pretended by the fake device.
 *
 * The switches: `COCKPIT_FAKE=1` (the fake device comes first) or
 * `COCKPIT_FAKE=only` (only the fake device).
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

/** The jiffies per second (the USER_HZ of Linux) */
const HZ = 100;

/** The total memory: 8 GiB */
const MEM_TOTAL_KB = 8 * 1024 * 1024;

/** How many cores the fake board has (the first 4 are A55, the last 4 are A76) */
const CORE_COUNT = 8;

/** The CPU part of the A55 / A76 (this is what `/proc/cpuinfo` recognises) */
const PART_A55 = '0xd05';
const PART_A76 = '0xd0b';

/** A deterministic "noise": the same time bucket always has the same value (reproducible in a test) */
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
  /** Per core: [busy jiffies, total jiffies]. The aggregate is **computed** from these. */
  private readonly jiffies: { busy: number; total: number }[] = [];
  /** When the counters were last advanced. */
  private lastAt: number | null = null;

  constructor(opts: FakeDeviceOptions) {
    this.now = opts.now;
    this.jiffies = Array.from({ length: CORE_COUNT }, () => ({ busy: 0, total: 0 }));
  }

  /** Set before a read: the memory file comes back truncated. */
  brokenMeminfo = false;

  /** The board's "uptime" in seconds (derived from the clock). */
  private uptime(): number {
    return this.now() / 1000;
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
    for (let index = 0; index < CORE_COUNT; index += 1) {
      const util = this.coreUtilAt(index, t);
      const total = dt * HZ;
      this.jiffies[index]!.total += total;
      this.jiffies[index]!.busy += total * (util / 100);
    }
  }

  /** `/proc/stat` — the aggregate line plus one line per core. */
  private procStat(): string {
    this.advance();
    const lines: string[] = [];
    // **The aggregate line is the sum of the cores** (that is how `/proc/stat` looks on a real board):
    // if the aggregate and the cores do **not** add up, the "total utilisation" on the card and the numbers of the eight cores contradict each other.
    let sumBusy = 0;
    let sumTotal = 0;
    for (let index = 0; index < CORE_COUNT; index += 1) {
      const { busy, total } = this.jiffies[index]!;
      sumBusy += busy;
      sumTotal += total;
      const idle = total - busy;
      // The kind sums user+nice+system as "busy" and all fields as "total"
      lines.push(`cpu${index} ${Math.round(busy)} 0 0 ${Math.round(idle)} 0 0 0 0 0 0`);
    }
    {
      const idle = sumTotal - sumBusy;
      lines.unshift(`cpu ${Math.round(sumBusy)} 0 0 ${Math.round(idle)} 0 0 0 0 0 0`);
    }
    lines.push('intr 0');
    lines.push('ctxt 0');
    lines.push('btime 1700000000');
    lines.push('processes 1');
    lines.push('procs_running 1');
    lines.push('procs_blocked 0');
    // **The last line of a real file carries a newline** (that is how `/proc/stat` looks) —
    // without it the separator of the next fragment sticks to the last line.
    return `${lines.join('\n')}\n`;
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
    // **The available memory is of the order of "GiB"** (8 GiB in total, about 4 GiB ± 1.5 GiB available).
    //
    // ⚠️ This used to be written as `4 * 1024 * 1024` (**MiB**) —
    // 8 GiB in total against 4 MiB available → **a utilisation of 99.9%**:
    // **the panel says fully loaded while the board is idle** — the "worst kind of fake number" that contract N2 talks about.
    // (it only showed up once it ran on a real machine: nobody looked at that number in the unit tests.)
    const availableKb = Math.round(
      (4 * 1024 * 1024 * 1024 + 1.5 * 1024 * 1024 * 1024 * Math.sin((2 * Math.PI * t) / 29)) / 1024,
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
      // **The last line of a real file carries a newline**
    ].join('\n') + '\n';
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
