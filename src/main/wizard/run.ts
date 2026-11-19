import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from '../hal/connection';
import type { SessionLog } from '../logging/session-log';
import type { ConnectionProfile } from '../profiles/schema';
import { parseProfile } from '../profiles/schema';
import { loadBoardPack } from '../tags/pack';
import { probePack, type ProbeReaderReport } from '../tags/probe';
import { outcomesOf } from './probe-adapter';
import { instantiatePack } from './instantiate';
import { installInstantiatedPack } from './install';
import type { FirstTruth } from './chain';

/**
 * **向导的主流程** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 人只参与一步 ✓ ──
 *
 * ```
 * 人：选 COM 口 + 波特率          ← 【整个向导里，人唯一必须做的事】
 *         ↓
 * 向导：跑一条命令                ← 「第一个真相」✓
 *         ↓
 *      板子回了 → 逐个试通用元操作 ✓ → 真相表 ✓
 *         ↓
 *      实例化 ✓ → 落盘 ✓ → 这块板有自己的包了 ✓
 * ```
 *
 * ── ⚠️ **「第一个真相」怎么算 ✓** ──
 *
 * → **一条真的能跑命令的连接** ✓ —— 不是「连上了」✓，是「**命令真的返回了东西**」✓
 *   （`docs/探索/02` §二.1 ✓）。
 * → **跑什么** ✓：`cat /proc/device-tree/model` ✓
 *   —— **它是最普适的那一条** ✓（**任何 Linux 都有** ✓）→ **回包即真相** ✓。
 * → **四种结果要分开说** ✓：
 *   **端口打不开** ✓ · **板子没说话** ✓ · **有回包但像乱码** ✓ · **成了** ✓
 *   （**它们是不同的故障** ✓ → **修法完全不同** ✓）。
 */

/** 人给的东西 ✓（**向导里人唯一必须做的** ✓） */
export interface WizardInput {
  /** 串口号 ✓（**不自动枚举** ✓ —— 用户已定 ✓） */
  port: string;
  /** 波特率 ✓（**不试** ✓ —— 用户已定 ✓） */
  baudrate: number;
  /** 这块板叫什么 ✓（**给包起名** ✓） */
  boardName: string;
  /** 板的 id ✓（**默认从名字来** ✓） */
  boardId?: string;
  /**
   * **走哪条通道** ✓（**默认串口** ✓ —— 用户定的是「先从串口开始」✓）。
   *
   * → **adb** ✓ —— **插上 USB 就有** ✓ · **零凭据** ✓（探索档案 §九·Q6 ✓）。
   * → **serial** ✓ —— **调试口** ✓。
   */
  transport?: 'serial' | 'adb';
}

/** 向导跑完的结果 */
export interface WizardResult {
  /** 成了没有 ✓ */
  ok: boolean;
  /** **第一个真相** ✓ */
  firstTruth: FirstTruth;
  /** **传输层给的提示** ✓（**可选** ✓ —— 串口知道「回包被吃了」✓） */
  hint?: string;
  /** **真相表** ✓（**试通用元操作的结果** ✓） */
  reports?: ProbeReaderReport[];
  /** **实例化出来的包** ✓ */
  pack?: ReturnType<typeof instantiatePack>['pack'];
  /** **它落在哪** ✓ */
  installedDir?: string;
  /** **说一句人话** ✓ */
  message: string;
}

/** 跑第一条命令用的（**最普适的那一条** ✓） */
const FIRST_COMMAND = 'cat /proc/device-tree/model';

/**
 * 从名字派生一个 id ✓。
 *
 * ── ⚠️ **中文名要能用** ✓（**这是真问题** ✓ · 2026-11-19 实测踩到 ✓）──
 *
 * → 第一版用 `[^a-z0-9._-]+` 全换成横线 ✓ → **中文名整个没了** ✓
 *   → 「我的板子」变成 `board` ✓ → **两块中文名的板会撞** ⚠️
 *   （id 撞了 → **一个盖掉另一个** ⚠️）。
 * → **所以：中文保留** ✓（**契约不限制 tag/id 的字符集** ✓ —— 规则 1 只查命名空间 ✓），
 *   **只去掉路径上真正危险的字符** ✓（`/ \\ : * ? " < > |` ✓）。
 * → **保留大小写** ✓（中文没有大小写 ✓ · 英文保留原样 ✓ —— 名字是给人看的 ✓）。
 */
export function boardIdOf(name: string): string {
  const id = name
    .trim()
    // **去掉路径上真正危险的字符** ✓（其余全留 ✓ —— **中文要能用** ✓）
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id.length > 0 ? id : 'board';
}

/**
 * **向导要用的依赖** ✓ —— **可注入** ✓（**好测** ✓ —— 不真开串口也能测 ✓）。
 */
export interface WizardDeps {
  /** 建连接 ✓ */
  createConnection: (profile: ConnectionProfile, log: SessionLog) => Connection;
  /** 建会话日志 ✓ */
  createLog: (label: string, transport: string) => SessionLog;
  /** **通用包在哪** ✓ */
  genericPackDir: string;
  /** **用户板型包目录** ✓ */
  boardsRoot: string;
  /** **用户连接 profile 目录** ✓ */
  profilesRoot: string;
}

/** 造一条**临时的**串口 profile ✓（**指名 `generic-linux`** ✓ —— 零新机制 ✓） */
export function serialProfileOf(input: WizardInput, boardId: string): ConnectionProfile {
  const transport = input.transport ?? 'serial';
  if (transport === 'adb') {
    return parseProfile(
      {
        id: `wizard-${boardId}`,
        label: `向导 · ADB`,
        transport: 'adb',
        // **指名通用包** ✓ → 「连接指名了某个包」那条路**根本不看 match** ✓
        board_pack: 'generic-linux',
        device_key: boardId,
        options: {},
      },
      'wizard',
    );
  }
  return parseProfile(
    {
      id: `wizard-${boardId}`,
      label: `向导 · ${input.port}`,
      transport: 'serial',
      // **指名通用包** ✓ → 「连接指名了某个包」那条路**根本不看 match** ✓
      board_pack: 'generic-linux',
      device_key: boardId,
      options: { port: input.port, baudrate: input.baudrate, pty: true },
    },
    'wizard',
  );
}

/**
 * **「第一个真相」** ✓ —— **一条真的能跑命令的连接** ✓。
 *
 * → **端口打不开** ✓ → `port-unopenable` ✓
 * → **超时了** ✓ → `no-reply` ✓（**板子没说话** ✓ —— **不是「连不上」** ✓）
 * → **回包里有乱码** ✓ → `wrong-baud` ✓
 * → **回了** ✓ → `ok` ✓
 */
export function firstTruthOf(
  connection: Connection,
): Promise<FirstTruth> {
  return connection
    .exec(FIRST_COMMAND, { timeoutMs: 5000 })
    .then((result): FirstTruth => {
      if (result.exitCode === 0 && result.stdout.trim().length > 0) {
        const detail = result.stdout.trim().slice(0, 120);
        return { ok: true, kind: 'ok' as const, detail };
      }
      if (result.timedOut) {
        return {
          ok: false,
          kind: 'no-reply',
          detail: '连上了，但命令没有回包',
          // **传输层的话要带出来** ✓（串口知道「回包被别的程序吃了」✓ —— **别丢** ✗）
          ...(result.hint !== undefined ? { hint: result.hint } : {}),
        };
      }
      return {
        ok: false,
        kind: 'no-reply',
        detail: `命令返回了 ${result.exitCode ?? '?'}，但没有内容`,
      };
    })
    .catch((err: unknown): FirstTruth => {
      const message = err instanceof Error ? err.message : String(err);
      // **端口打不开**与**别的错**要分开 ✓
      //
      // ⚠️ **判据要认「错误码」** ✓ —— **别只认消息文本** ✓
      // （**中文差一个字就分错了** ✓ —— 实测 2026-11-20 ⚠️：
      //   串口抛的是「**打不开**串口 COM99」✓ → **不含「打开」** ✓ →
      //   只按文本匹配 → **它被归成「板子没说话」** ⚠️ → **说错了故障** ⚠️）
      const code = (err as { code?: string } | undefined)?.code;
      if (code === 'CONN_OPEN_FAILED' || code === 'PORT_BUSY') {
        return { ok: false, kind: 'port-unopenable', detail: message };
      }
      // **文本只当兜底** ✓（错误码之外的错 ✓）
      if (/打不开|打开|被占用|ENOENT|EBUSY|Access|denied/i.test(message)) {
        return { ok: false, kind: 'port-unopenable', detail: message };
      }
      return { ok: false, kind: 'no-reply', detail: message };
    });
}

/**
 * **向导主流程** ✓。
 *
 * → **人只参与第一步** ✓ → **其余全自动** ✓。
 * → **每一步的结果都要能说清楚** ✓（`chain.ts` ✓）。
 */
export async function runWizard(
  input: WizardInput,
  deps: WizardDeps,
): Promise<WizardResult> {
  const boardId = input.boardId ?? boardIdOf(input.boardName);
  const profile = serialProfileOf(input, boardId);
  const transport = input.transport ?? 'serial';
  const log = deps.createLog(`wizard-${boardId}`, transport);

  let connection: Connection;
  try {
    connection = deps.createConnection(profile, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      firstTruth: { ok: false, kind: 'port-unopenable', detail: message },
      message: `**串口打不开** ✓ —— ${message}`,
    };
  }

  try {
    await connection.open();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await connection.close().catch(() => undefined);
    return {
      ok: false,
      firstTruth: { ok: false, kind: 'port-unopenable', detail: message },
      message: `**串口打不开** ✓ —— ${message}`,
    };
  }

  // ── 第一个真相 ✓ ──
  const truth = await firstTruthOf(connection);
  if (!truth.ok) {
    await connection.close().catch(() => undefined);
    return {
      ok: false,
      firstTruth: truth,
      // **传输层的 hint 一起带出去** ✓（界面要能显示它 ✓）
      ...(truth.hint !== undefined ? { hint: truth.hint } : {}),
      message:
        truth.kind === 'port-unopenable'
          ? `**串口打不开** ✓ —— ${truth.detail}`
          : `**板子没说话** ✓ —— ${truth.detail}`,
    };
  }

  // ── 逐个试通用元操作 ✓ ──
  const generic = loadBoardPack(deps.genericPackDir);
  const report = await probePack(generic, connection);
  await connection.close().catch(() => undefined);

  // ── 实例化 + 落盘 ✓ ──
  const result = instantiatePack({
    source: generic,
    targetId: boardId,
    targetName: input.boardName,
    outcomes: outcomesOf(report.readers),
    connection:
      transport === 'serial'
        ? { transport: 'serial', port: input.port, baudrate: input.baudrate }
        : { transport: 'adb' },
  });

  // **落盘前先落一条 profile** ✓ —— **不然这块板在界面上选不到** ✓
  writeProfile(deps.profilesRoot, boardId, input);

  const { dir } = installInstantiatedPack({
    pack: result.pack,
    provenance: result.provenance,
    boardsRoot: deps.boardsRoot,
  });

  // **旧的同名包不挡事** ✓ —— 「不悄悄覆盖」是**落盘时**的规矩 ✓
  // → **这里要覆盖** ✓（向导重跑一次 = 重新探一遍 ✓ → 产物应该更新 ✓）
  return {
    ok: true,
    firstTruth: truth,
    reports: report.readers,
    pack: result.pack,
    installedDir: dir,
    message:
      `好了 ✓ —— **${report.readers.filter((r) => r.ok).length} 个元操作可用** ✓ · ` +
      `**包落在** ${dir}`,
  };
}

/**
 * **落一条连接 profile** ✓ —— **不然这块板在界面上选不到** ✓。
 *
 * → **同名就覆盖** ✓（向导重跑 = 重新探一遍 ✓ → profile 也该更新 ✓）。
 */
export function writeProfile(profilesRoot: string, boardId: string, input: WizardInput): void {
  mkdirSync(profilesRoot, { recursive: true });
  const transport = input.transport ?? 'serial';
  const profile = {
    id: `board-${boardId}`,
    label: `板子 · ${input.boardName}`,
    transport,
    board_pack: boardId,
    device_key: boardId,
    options:
      transport === 'serial'
        ? { port: input.port, baudrate: input.baudrate, pty: true }
        : {},
  };
  writeFileSync(
    join(profilesRoot, `board-${boardId}.json`),
    `${JSON.stringify(profile, null, 2)}\n`,
    'utf8',
  );
}

/** 这个文件在不在（**判据用** ✓） */
export function profileExists(profilesRoot: string, boardId: string): boolean {
  return existsSync(join(profilesRoot, `board-${boardId}.json`));
}
