import { describe, it, expect } from 'vitest';
import { parseProfile, deviceKeyOf, deviceKeyConflicts } from '../../../src/main/profiles/schema';

/**
 * **连接 profile 的两个新字段**（契约 `spec/02` §10.1–10.3 ✓ · ADR-D43 ✓）。
 *
 * ── `device_key`：**板实物**与**连接**是两层 ✓ ──
 *
 * → 一块板有 **ADB / 串口 / SSH** 三条连接 ✓ → **界面要按板子分组** ✓
 * → 得先知道「哪些连接是同一块板」✓ → **这就是它** ✓。
 * → **缺省 = `id`** ✓（**一板一连** ✓ 的连接就这么办 ✓）。
 *
 * ── `options.ssh`：**这条连接背后那台机器**的 SSH 端点 ✓ ──
 *
 * → **跨机器的动作在另一台机器上发起** ✓ → 那条命令要用**板子的 SSH 地址** ✓
 * → **流程包不该知道板子的地址** ✓ → **它跟着 profile 走** ✓。
 */
describe('连接 profile · device_key 与 options.ssh', () => {
  it('**`device_key` 缺省 = profile id** ✓', () => {
    const p = parseProfile(
      { id: 'board-adb', label: '板子', transport: 'adb', options: {} },
      'x.json',
    );
    expect(p.device_key).toBe('board-adb');
  });

  it('**`device_key` 可以显式写** ✓（**同一块板的多条连接写同一个** ✓）', () => {
    const p = parseProfile(
      {
        id: 'board-adb',
        label: '板子',
        transport: 'adb',
        device_key: 'atk-01',
        options: {},
      },
      'x.json',
    );
    expect(p.device_key).toBe('atk-01');
  });

  it('**`device_key` 必须是字符串** ✓', () => {
    expect(() =>
      parseProfile(
        { id: 'x', label: 'x', transport: 'adb', device_key: 7, options: {} },
        'x.json',
      ),
    ).toThrow(/device_key/);
  });

  it('**`options.ssh` 可以带** ✓（**跨传输的事实** ✓）', () => {
    const p = parseProfile(
      {
        id: 'board-adb',
        label: '板子',
        transport: 'adb',
        options: { ssh: { host: '192.168.5.100', port: 22, username: 'root' } },
      },
      'x.json',
    );
    expect(p.options['ssh']).toEqual({ host: '192.168.5.100', port: 22, username: 'root' });
  });

  it('**ssh 传输的 profile 不许带 `options.ssh`** ✓（**它自己就是那个端点** ✓ —— 双写 = 漂移 ✓）', () => {
    // **判据要精确** ✓ —— 「未知字段 'ssh'」也含 ssh 字样 ✓ → 那会**假通过** ✓
    expect(() =>
      parseProfile(
        {
          id: 'board-ssh',
          label: '板子',
          transport: 'ssh',
          options: { host: '192.168.5.100', ssh: { host: '192.168.5.100' } },
        },
        'x.json',
      ),
    ).toThrow(/双写会漂移/);
  });

  it('**local 传输的 profile 不许带 `options.ssh`** ✓（它是宿主自己 ✓）', () => {
    expect(() =>
      parseProfile(
        {
          id: 'local',
          label: '本机',
          transport: 'local',
          options: { ssh: { host: '1.2.3.4' } },
        },
        'x.json',
      ),
    ).toThrow(/宿主自己/);
  });

  it('**`options.ssh` 的形状封闭** ✓（未知键报错 ✓ —— **报的是内层那个键** ✓）', () => {
    expect(() =>
      parseProfile(
        {
          id: 'board-adb',
          label: '板子',
          transport: 'adb',
          options: { ssh: { host: '1.2.3.4', key: '/root/.ssh/id' } },
        },
        'x.json',
      ),
    ).toThrow(/未知字段 'key'/);
  });

  it('**`options.ssh.host` 必填** ✓', () => {
    expect(() =>
      parseProfile(
        {
          id: 'board-adb',
          label: '板子',
          transport: 'adb',
          options: { ssh: { port: 22 } },
        },
        'x.json',
      ),
    ).toThrow(/host 必填/);
  });

  it('**未知顶层字段报错** ✓（`device_key` 之外的还是报错 ✓）', () => {
    expect(() =>
      parseProfile(
        { id: 'x', label: 'x', transport: 'adb', options: {}, board: 'atk' },
        'x.json',
      ),
    ).toThrow(/未知字段 'board'/);
  });
});

/**
 * **同一个 `device_key` 只能指一块板** ✓（契约 `spec/02` §10.2 ✓）。
 *
 * → **一块板只有一个型号** ✓ → 同一个 `device_key` 声明了**两个板型包** ✗
 * → **那是个配置写错了** ✓ → **要说得出来** ✓（**不静默** ✓）。
 */
describe('连接 profile · device_key 的冲突', () => {
  const board = (id: string, key: string, pack: string | null) =>
    parseProfile(
      { id, label: id, transport: 'adb', board_pack: pack, device_key: key, options: {} },
      `${id}.json`,
    );

  it('**同一个 key + 同一个板型包 → 没有冲突** ✓', () => {
    const conflicts = deviceKeyConflicts([
      board('board-adb', 'atk-01', 'rk3588-atk'),
      board('board-ssh', 'atk-01', 'rk3588-atk'),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('**同一个 key + 两个板型包 → 冲突** ✓（**一块板不能两个型号** ✓）', () => {
    const conflicts = deviceKeyConflicts([
      board('board-adb', 'atk-01', 'rk3588-atk'),
      board('board-other', 'atk-01', 'rk3588-other'),
    ]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.device_key).toBe('atk-01');
    // **说得清是哪两条** ✓
    expect(conflicts[0]?.profile_ids.sort()).toEqual(['board-adb', 'board-other']);
  });

  it('**不同的 key → 没有冲突** ✓（**两块同型号的板** ✓ —— **共享一个包** ✓ 但不是一块 ✓）', () => {
    const conflicts = deviceKeyConflicts([
      board('board-a', 'atk-01', 'rk3588-atk'),
      board('board-b', 'atk-02', 'rk3588-atk'),
    ]);
    expect(conflicts).toEqual([]);
  });
});
