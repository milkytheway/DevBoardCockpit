import type { ProbeReaderReport } from '../tags/probe';

/**
 * **接板向导那条链** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 人只参与一步 ✓（`docs/探索/02` §二 ✓）──
 *
 * ```
 * 人：选 COM 口 + 波特率          ← 【整个向导里，人唯一必须做的事】
 *         ↓
 * 向导：用这条连接跑一条命令        ← 「第一个真相」
 *         ↓
 *      板子回了 → 真相成立 ✓
 *      板子没回 → 报告「连上了但没回话」+ 常见原因 ✓
 * ```
 *
 * → **其余全自动** ✓（§二.2 ✓）：
 * **逐个试通用元操作** ✓ → **真相表** ✓ → **实例化出初版包** ✓ → **落盘** ✓。
 *
 * ── ⚠️ **「没回话」与「连接失败」是两件事** ✓（§二.3 ✓）──
 *
 * → 报告要说「**板子没说话**」✓ —— **不是「连接失败」** ✓
 * → **这两个是不同的故障** ✓ → **修法完全不同** ✓：
 *   **端口打不开** → COM 口不对 / **被别的程序占着** ✓（`docs/02` 事实 ✓）→
 *   **打开但无输出** → 波特率不对 ✓ / **不是调试口** ✓ → **有乱码** → 波特率不对 ✓。
 *
 * ── 它是**纯函数** ✓ ──
 *
 * → **不碰串口** ✓ · **不碰文件** ✓ → **好测** ✓
 * → **I/O 在别处** ✓（`instantiate.ts` ✓ · `install.ts` ✓）。
 */

/** 向导的步骤 ✓ */
export type WizardStep =
  /** **人选串口参数** ✓ —— 整个向导里人唯一必须做的事 ✓ */
  | 'choose-serial'
  /** **建立第一个真相** ✓ —— 跑一条命令 ✓ */
  | 'first-truth'
  /** **逐个试通用元操作** ✓ —— 试出真相表 ✓ */
  | 'probe-generic'
  /** **实例化 + 落盘** ✓ */
  | 'instantiate'
  /** **完了** ✓ */
  | 'done';

/** 向导的状态（**人给什么 + 现在到哪** ✓） */
export interface WizardState {
  step: WizardStep;
  /** 人选的串口参数 ✓（**不自动枚举** ✓） */
  serial?: { port: string; baudrate: number };
  /** 第一个真相的结果 ✓ */
  firstTruth?: FirstTruth;
  /** 试通用元操作的结果 ✓ */
  outcomes?: ProbeReaderReport[];
}

/** 「第一个真相」的结果 ✓ */
export interface FirstTruth {
  /** 成不成立 ✓ */
  ok: boolean;
  /** **哪种故障** ✓（**「没回话」与「连不上」是不同的** ✓） */
  kind: 'ok' | 'port-unopenable' | 'no-reply' | 'wrong-baud';
  /** **一句话** ✓ */
  detail: string;
}

/** 真相表 ✓ */
export interface TruthTable {
  /** 绿的（这板有）✓ */
  green: string[];
  /** 红的（这板没有 / 读法不对）✓ */
  red: { readerId: string; detail: string }[];
}

/** 向导的「描述」✓ —— **给界面看的** ✓ */
export interface WizardDescription {
  /** **现在是哪种情况** ✓ */
  kind: 'ok' | 'port-unopenable' | 'no-reply' | 'wrong-baud' | 'connection-dead';
  /** **一句话** ✓（**说人话** ✓） */
  message: string;
  /** **下一步查什么** ✓（**空数组 = 没什么要提醒的** ✓） */
  hints: string[];
  /** **下一步做什么** ✓（`null` = 停了 ✓ —— 得人来解 ✓） */
  next: WizardStep | null;
  /** **真相表** ✓（**试完才有** ✓） */
  summary?: TruthTable;
}

/** 状态 → 步骤名（**纯函数** ✓） */
export function wizardStepOf(state: WizardState): WizardStep {
  return state.step;
}

/**
 * **端口打不开** → 说端口的事 ✓。
 *
 * → **最常见的原因是「被别的程序占着」** ✓
 *   （`docs/02` 事实 ✓ —— 计划 1 验收留下的 `serial-server.py` 独占打开着 COM3 ✓
 *   → **板子是活的、串口是通的** ✓ → **但回包被那个进程吃掉了** ✓
 *   → **于是应用自己的 exec 永远等不到** ✓ → **每个 reader 都报「超时」** ✓
 *   → **说清楚这一点，人就不会往「板子死了」的方向查** ✓）。
 */
const PORT_HINTS = [
  '**串口最常踩的坑：有别的程序正独占着那个口** ✓',
  '  （本机的 `serial-server.py` 就会把回包吃掉 ✓ —— 板子是活的、串口是通的 ✓，',
  '    但应用自己的 exec 永远收不到 ✓ —— 于是每个 reader 都报「超时」✓。）',
  '  先停掉那个进程，再重试 ✓。',
];

/** **打开但没回话** → 说「板子没说话」✓ */
const NO_REPLY_HINTS = [
  '**板子没说话** —— 连上了，但它没回话 ✓。',
  '  最常见的三种原因 ✓：',
  '  ① **波特率不对** ✓（串口工具里换几个常见的波特率试试 ✓ —— **这块板是 1500000** ✓）；',
  '  ② **这个口不是调试口** ✓（插错口了 ✓）；',
  '  ③ **回包被别的程序吃掉了** ✓（有程序独占着那个口 ✓）。',
];

/** **乱码** → 说波特率 ✓ */
const WRONG_BAUD_HINTS = [
  '**有回包但像乱码** —— 波特率不对 ✓。',
  '  串口工具里换几个常见的波特率试试 ✓ —— **这块板是 1500000** ✓。',
];

/**
 * **状态 → 描述** ✓（**给界面看的** ✓）。
 *
 * → **「没回话」与「连接失败」必须分开说** ✓（§二.3 ✓）
 * → **全红时要说「那是连接的问题」** ✓（不是 reader 的问题 ✓ —— `probeHint` 同款 ✓）。
 */
export function describeWizard(state: WizardState): WizardDescription {
  // ── 第一步：人还没选完 ──
  if (state.step === 'choose-serial') {
    return {
      kind: 'ok',
      message: '选一个串口和波特率 —— 这是整个向导里你唯一必须做的事 ✓',
      hints: [
        '**不知道波特率？** ✓ 这块板是 **1500000** ✓（`docs/02` 事实 ✓）。',
        '**COM 口从设备管理器看** ✓（CH343 USB-UART ✓ —— 常见的是 COM3 ✓）。',
      ],
      next: 'first-truth',
    };
  }

  // ── 第一个真相 ──
  if (state.step === 'first-truth') {
    const truth = state.firstTruth;
    if (truth === undefined) {
      return { kind: 'ok', message: '正在建立第一个真相 ✓', hints: [], next: null };
    }
    if (truth.ok) {
      return {
        kind: 'ok',
        message: `第一个真相成立 ✓ —— ${truth.detail}`,
        hints: [],
        next: 'probe-generic',
      };
    }
    if (truth.kind === 'port-unopenable') {
      return {
        kind: 'port-unopenable',
        message: `**串口打不开** ✓ —— ${truth.detail}`,
        hints: PORT_HINTS,
        next: null,
      };
    }
    if (truth.kind === 'wrong-baud') {
      return {
        kind: 'wrong-baud',
        message: `**有回包但像乱码** ✓ —— ${truth.detail}`,
        hints: WRONG_BAUD_HINTS,
        next: null,
      };
    }
    // **没回话** ✓ —— **明确不说「连接失败」** ✓
    return {
      kind: 'no-reply',
      message: `**板子没说话** ✓ —— ${truth.detail}（**连上了，只是它没回话** ✓）`,
      hints: NO_REPLY_HINTS,
      next: null,
    };
  }

  // ── 试通用元操作 ──
  if (state.step === 'probe-generic') {
    const outcomes = state.outcomes ?? [];
    const green = outcomes.filter((o) => o.ok).map((o) => o.readerId);
    const red = outcomes
      .filter((o) => !o.ok)
      .map((o) => ({ readerId: o.readerId, detail: o.problems.join('；') }));
    const summary: TruthTable = { green, red };

    // **一个数都没出来** → **那是连接的问题** ✓（不是 reader 的问题 ✓）
    if (outcomes.length > 0 && green.length === 0) {
      return {
        kind: 'connection-dead',
        message:
          '**一个数都没出来** ✓ —— **多半不是那些元操作的问题** ✓，' +
          '**是这条连接一次都没通** ✓',
        hints: [
          '**先查连接本身** ✓（能不能连上 ✓ · 板子在不在 ✓），**再查元操作** ✓。',
          '**串口最常踩的坑：有别的程序正独占着那个口** ✓。',
        ],
        next: null,
        summary,
      };
    }
    return {
      kind: 'ok',
      message:
        `试完了 ✓ —— **${green.length} 个绿** ✓（这板有 ✓）· ` +
        `**${red.length} 个红** ✓（这板没有 / 读法不对 ✓）`,
      hints:
        red.length > 0
          ? ['**红的那些** ✓ → **实例化时会被删掉** ✓（「绿的留、红的删」✓）。']
          : [],
      next: 'instantiate',
      summary,
    };
  }

  // ── 实例化 / 完了 ──
  if (state.step === 'instantiate') {
    return {
      kind: 'ok',
      message: '正在把它变成这块板的包 ✓（并留一份来路 ✓）',
      hints: [],
      next: 'done',
    };
  }
  return {
    kind: 'ok',
    message: '好了 ✓ —— 这块板现在有自己的包了 ✓',
    hints: [
      '**那是自动探出来的初版包** ✓：**说得准的地方是事实** ✓（有没有 ✓ · 几个 ✓），',
      '**说得不准的地方是命名与语义** ⚠️（哪个温区是 SoC ✓ · 那要 agent 去补 ✓）。',
    ],
    next: null,
  };
}
