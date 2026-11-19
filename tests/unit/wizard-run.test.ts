import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runWizard, boardIdOf, serialProfileOf, profileExists } from '../../src/main/wizard/run';
import { validatePack, errorsOf } from '../../src/main/tags/validator';
import type { Connection, ExecResult } from '../../src/main/hal/connection';
import type { ConnectionProfile } from '../../src/main/profiles/schema';
import type { SessionLog } from '../../src/main/logging/session-log';

/**
 * **向导主流程** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 为什么用假连接 ✓ ──
 *
 * → **判据不该依赖真板子** ✓（**沙箱里跑不了** ✓ · **CI 跑不了** ✓）。
 * → **假连接要模拟真实行为** ✓（AGENTS.md §3 ✓ · 「替身按行为建模，不按结论建模」✓）
 *   → **它真的回每一行** ✓ → **它真的按命令回不同的东西** ✓
 *   → **而不是「直接返回契约期待的那个答案」** ✓ —— 那样会把协议形状的 bug 盖住 ✓。
 */
const REPO_ROOT = resolve(process.cwd());
const GENERIC_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

/** 假的连接 ✓ —— **按真实行为建模** ✓ */
function fakeConnection(): {
  connection: Connection;
  commands: string[];
} {
  const commands: string[] = [];
  const connection = {
    id: 'fake',
    transport: 'serial' as const,
    lastError: undefined,
    async open(): Promise<void> {
      commands.push('<open>');
    },
    async close(): Promise<void> {
      commands.push('<close>');
    },
    async exec(command: string): Promise<ExecResult> {
      commands.push(command);
      // **按命令回不同的东西** ✓ —— 像真板子那样 ✓
      if (command.includes('/proc/device-tree/model')) {
        return {
          exitCode: 0,
          stdout: 'ATK-DLRK3588 Board\0',
          stderr: '',
          durationMs: 3,
          timedOut: false,
        };
      }
      if (command.includes('/proc/stat')) {
        return { exitCode: 0, stdout: 'cpu  100 0 100 800 0 0 0 0 0 0\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('/proc/meminfo')) {
        return { exitCode: 0, stdout: 'MemTotal:  8107744 kB\nMemAvailable: 7000000 kB\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('/proc/loadavg')) {
        return { exitCode: 0, stdout: '0.11 0.22 0.33 1/234 5678\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('/etc/os-release')) {
        return { exitCode: 0, stdout: 'PRETTY_NAME="Buildroot 2024.02"\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('/proc/version')) {
        return { exitCode: 0, stdout: 'Linux version 6.1.141 (alientek@alientek)\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('/proc/uptime')) {
        return { exitCode: 0, stdout: '6373.95 50598.33\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('backlight')) {
        return { exitCode: 0, stdout: '200\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('leds')) {
        return { exitCode: 0, stdout: '0\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('/sys/class/net')) {
        return { exitCode: 0, stdout: 'e2:21:8b:f5:3f:87\n', stderr: '', durationMs: 2, timedOut: false };
      }
      if (command.includes('thermal_zone')) {
        return { exitCode: 0, stdout: 'gpu-thermal=31461\nnpu-thermal=31461\n', stderr: '', durationMs: 2, timedOut: false };
      }
      // **没接的设备 → 报错** ✓（像真板子那样 ✓）
      return { exitCode: 1, stdout: '', stderr: 'No such file or directory', durationMs: 2, timedOut: false };
    },
    async list(): Promise<never[]> {
      throw new Error('串口不支持文件传输');
    },
    async pull(): Promise<void> {
      throw new Error('串口不支持文件传输');
    },
    async push(): Promise<void> {
      throw new Error('串口不支持文件传输');
    },
    async openSession(): Promise<never> {
      throw new Error('这个测试不需要会话');
    },
  } as unknown as Connection;
  return { connection, commands };
}

function deps(root: string, conn: Connection): {
  createConnection: (p: ConnectionProfile, log: SessionLog) => Connection;
  createLog: (label: string, transport: string) => SessionLog;
  genericPackDir: string;
  boardsRoot: string;
  profilesRoot: string;
} {
  return {
    createConnection: () => conn,
    createLog: () => ({}) as unknown as SessionLog,
    genericPackDir: GENERIC_DIR,
    boardsRoot: join(root, 'boards'),
    profilesRoot: join(root, 'profiles'),
  };
}

describe('向导 · **主流程** ✓', () => {
  it('**从人选串口到包落盘，一条龙** ✓', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-run-'));
    try {
      const { connection } = fakeConnection();
      const r = await runWizard(
        { port: 'COM3', baudrate: 1500000, boardName: '我的板子' },
        deps(root, connection),
      );
      expect(r.ok, r.message).toBe(true);
      expect(r.firstTruth.ok).toBe(true);
      expect(r.installedDir).toBeTruthy();
      expect(existsSync(join(r.installedDir as string, 'board.yaml'))).toBe(true);
      expect(existsSync(join(r.installedDir as string, 'provenance.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**落盘的包过真校验器** ✓（**落地即废 = 白做** ⚠️）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-run-'));
    try {
      const { connection } = fakeConnection();
      const r = await runWizard(
        { port: 'COM3', baudrate: 1500000, boardName: '我的板子' },
        deps(root, connection),
      );
      const errors = errorsOf(validatePack(r.pack as never));
      expect(errors.map((e) => `规则 ${e.rule} · ${e.path}：${e.message}`)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**落一条连接 profile** ✓（**不然这块板在界面上选不到** ✓）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-run-'));
    try {
      const { connection } = fakeConnection();
      const r = await runWizard(
        { port: 'COM3', baudrate: 1500000, boardName: '我的板子' },
        deps(root, connection),
      );
      expect(r.ok).toBe(true);
      expect(profileExists(join(root, 'profiles'), '我的板子')).toBe(true);
      const raw = readFileSync(join(root, 'profiles', 'board-我的板子.json'), 'utf8');
      const profile = JSON.parse(raw) as Record<string, unknown>;
      expect(profile['board_pack']).toBe('我的板子');
      expect(profile['device_key']).toBe('我的板子');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**临时 profile 指名 `generic-linux`** ✓（**零新机制** ✓）', () => {
    const profile = serialProfileOf({ port: 'COM3', baudrate: 1500000, boardName: 'x' }, 'atk-01');
    expect(profile.board_pack).toBe('generic-linux');
    expect(profile.options['port']).toBe('COM3');
    expect(profile.options['baudrate']).toBe(1500000);
  });

  it('**名字派生出 id** ✓（**小写 ✓ · 非法字符换横线** ✓）', () => {
    expect(boardIdOf('我的板子'), '**中文名要能用** ✓').toBe('我的板子');
    expect(boardIdOf('ATK-01')).toBe('ATK-01');
    expect(boardIdOf('a/b')).toBe('a-b');
    expect(boardIdOf('  ')).toBe('board');
  });

  it('**端口打不开 → 立刻停** ✓（**不往下跑** ✓）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-run-'));
    try {
      const conn = {
        ...fakeConnection().connection,
        async open(): Promise<void> {
          throw new Error('Error opening serial port COM3: Access is denied');
        },
      } as unknown as Connection;
      const r = await runWizard(
        { port: 'COM3', baudrate: 1500000, boardName: 'x' },
        deps(root, conn),
      );
      expect(r.ok).toBe(false);
      expect(r.firstTruth.kind).toBe('port-unopenable');
      expect(r.installedDir, '没成就不该落盘 ✓').toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
