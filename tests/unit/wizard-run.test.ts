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
 * The **main flow of the wizard**, added on 2026-11-19.
 *
 * Why a fake connection:
 *
 * → **The criterion must not depend on a real board** (it cannot run in the
 *   sandbox and it cannot run in the CI).
 * → **The fake connection has to imitate the real behaviour** (AGENTS.md §3: a
 *   stand-in is modelled by behaviour, not by conclusion) → **it really
 *   answers every line** and **it really answers different things for
 *   different commands**, and **not "it returns the answer the contract
 *   expects"**, which would hide the bugs in the shape of the protocol.
 */
const REPO_ROOT = resolve(process.cwd());
const GENERIC_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

/** A fake connection — **modelled by the real behaviour** */
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
      // **It answers different things for different commands** — as a real board does
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
      // **A device that is not connected → an error** — as a real board does
      return { exitCode: 1, stdout: '', stderr: 'No such file or directory', durationMs: 2, timedOut: false };
    },
    async list(): Promise<never[]> {
      throw new Error('the serial port does not support file transfer');
    },
    async pull(): Promise<void> {
      throw new Error('the serial port does not support file transfer');
    },
    async push(): Promise<void> {
      throw new Error('the serial port does not support file transfer');
    },
    async openSession(): Promise<never> {
      throw new Error('this test needs no session');
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

describe('the wizard · **the main flow**', () => {
  it('**from the operator picking the serial port to the pack on disk, in one chain**', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-run-'));
    try {
      const { connection } = fakeConnection();
      const r = await runWizard(
        { port: 'COM3', baudrate: 1500000, boardName: 'myboard' },
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

  it('**the pack on disk passes the real validator** (**dead on arrival means wasted work**)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-run-'));
    try {
      const { connection } = fakeConnection();
      const r = await runWizard(
        { port: 'COM3', baudrate: 1500000, boardName: 'myboard' },
        deps(root, connection),
      );
      const errors = errorsOf(validatePack(r.pack as never));
      expect(errors.map((e) => `rule ${e.rule} · ${e.path}: ${e.message}`)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**it writes a connection profile** (**otherwise the board cannot be picked in the interface**)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-run-'));
    try {
      const { connection } = fakeConnection();
      const r = await runWizard(
        { port: 'COM3', baudrate: 1500000, boardName: 'myboard' },
        deps(root, connection),
      );
      expect(r.ok).toBe(true);
      expect(profileExists(join(root, 'profiles'), 'myboard')).toBe(true);
      const raw = readFileSync(join(root, 'profiles', 'board-myboard.json'), 'utf8');
      const profile = JSON.parse(raw) as Record<string, unknown>;
      expect(profile['board_pack']).toBe('myboard');
      expect(profile['device_key']).toBe('myboard');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**the temporary profile names `generic-linux`** (**no new mechanism**)', () => {
    const profile = serialProfileOf({ port: 'COM3', baudrate: 1500000, boardName: 'x' }, 'atk-01');
    expect(profile.board_pack).toBe('generic-linux');
    expect(profile.options['port']).toBe('COM3');
    expect(profile.options['baudrate']).toBe(1500000);
  });

  it('**the name derives the id** (**lowercase · an illegal character becomes a hyphen**)', () => {
    expect(boardIdOf('我的板子'), 'a Chinese name has to work').toBe('我的板子');
    expect(boardIdOf('ATK-01')).toBe('ATK-01');
    expect(boardIdOf('a/b')).toBe('a-b');
    expect(boardIdOf('  ')).toBe('board');
  });

  it('without a typed name the board identity comes from the detected model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-run-'));
    try {
      const { connection } = fakeConnection();
      const r = await runWizard(
        { port: 'COM3', baudrate: 1500000 },
        deps(root, connection),
      );
      expect(r.ok, r.message).toBe(true);
      expect(r.pack?.name).toBe('ATK-DLRK3588 Board');
      expect(r.pack?.id).toBe('ATK-DLRK3588-Board');
      const profile = JSON.parse(
        readFileSync(join(root, 'profiles', 'board-ATK-DLRK3588-Board.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(profile['label']).toBe('Board · ATK-DLRK3588 Board');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**the port cannot be opened → it stops at once** (**it does not go on**)', async () => {
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
      expect(r.installedDir, 'nothing was written, so nothing may be on disk').toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
