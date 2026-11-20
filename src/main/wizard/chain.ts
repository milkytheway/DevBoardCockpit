import type { ProbeReaderReport } from '../tags/probe';

/**
 * The chain of the board setup wizard — added 2026-11-19.
 *
 * ── the person takes part in one step only ──
 *
 * ```
 * The person picks the COM port + the baud rate   ← 【the only thing the person has to do in the whole wizard】
 *         ↓
 * The wizard runs one command over this connection  ← "the first truth"
 *         ↓
 *      The board answered → the truth holds ✓
 *      The board did not answer → report "it is connected but it did not reply" + the common causes ✓
 * ```
 *
 * → Everything else is automatic ✓:
 * try the generic meta-operations one by one ✓ → the truth table ✓ →
 * instantiate the first version of the pack ✓ → write it to disk ✓.
 *
 * ── ⚠️ "it did not reply" and "the connection failed" are two things ✓ ──
 *
 * → The report has to say "the board said nothing" — not "the
 *   connection failed" ✓
 * → These are two different faults → the fixes are completely
 *   different ✓:
 *   the port cannot be opened → the COM port is wrong / another
 *   program is holding it ✓ (a fact of `docs/02-device-facts.md` ✓) →
 *   it opens but there is no output → the baud rate is wrong ✓ / it
 *   is not the debug port ✓ → there is garbage → the baud rate is
 *   wrong ✓.
 *
 * ── It is a pure function ──
 *
 * → It does not touch the serial line · it does not touch the
 *   files → easy to test ✓
 * → The I/O is elsewhere ✓ (`instantiate.ts` · `install.ts`).
 */

/** The steps of the wizard ✓ */
export type WizardStep =
  /** The person picks the serial parameters ✓ — the only thing the person has to do in the whole wizard ✓ */
  | 'choose-serial'
  /** Establish the first truth ✓ — run one command ✓ */
  | 'first-truth'
  /** Try the generic meta-operations one by one ✓ — the truth table comes out of it ✓ */
  | 'probe-generic'
  /** Instantiate + write to disk ✓ */
  | 'instantiate'
  /** Done ✓ */
  | 'done';

/** The state of the wizard (what the person gave + where it is now ✓) */
export interface WizardState {
  step: WizardStep;
  /** The serial parameters the person picked ✓ (not enumerated automatically ✓) */
  serial?: { port: string; baudrate: number };
  /** The result of the first truth ✓ */
  firstTruth?: FirstTruth;
  /** The result of trying the generic meta-operations ✓ */
  outcomes?: ProbeReaderReport[];
}

/** The result of "the first truth" ✓ */
export interface FirstTruth {
  /** Does it hold ✓ */
  ok: boolean;
  /** Which fault ✓ ("it did not reply" and "it cannot be reached" are different ✓) */
  kind: 'ok' | 'port-unopenable' | 'no-reply' | 'wrong-baud';
  /** One sentence ✓ */
  detail: string;
  /**
   * The hint the transport gave ✓ (optional ✓).
   *
   * → The hint of the serial line tells the truth ✓ ("the most
   *   common reason is that the reply was swallowed by another program" ✓
   *   —— the serial HAL knows that itself ✓ → do not throw it away ✗).
   */
  hint?: string;
}

/** The truth table ✓ */
export interface TruthTable {
  /** The green ones (this board has them ✓) */
  green: string[];
  /** The red ones (this board does not have them / the reading is wrong ✓) */
  red: { readerId: string; detail: string }[];
}

/** The "description" of the wizard ✓ — what the interface shows ✓ */
export interface WizardDescription {
  /** Which situation it is right now ✓ */
  kind: 'ok' | 'port-unopenable' | 'no-reply' | 'wrong-baud' | 'connection-dead';
  /** One sentence ✓ (in plain language ✓) */
  message: string;
  /** What to check next ✓ (an empty array = nothing to remind about ✓) */
  hints: string[];
  /** What to do next ✓ (`null` = it stopped ✓ — a human has to solve it ✓) */
  next: WizardStep | null;
  /** The truth table ✓ (it only exists after the probing ✓) */
  summary?: TruthTable;
}

/** The state → the name of the step (a pure function ✓) */
export function wizardStepOf(state: WizardState): WizardStep {
  return state.step;
}

/**
 * The port cannot be opened → say something about the port ✓.
 *
 * → The most common reason is "another program is holding it" ✓
 *   (a fact of `docs/02-device-facts.md` ✓ — the `serial-server.py` of the
 *   plan 1 acceptance run holds COM3 exclusively ✓
 *   → the board is alive and the serial line is fine ✓ → but the
 *   reply is swallowed by that process ✓
 *   → so the exec of the application itself never receives anything ✓ →
 *   every reader reports "timeout" ✓
 *   → saying this clearly keeps a person from looking for "the board
 *   died" ✓).
 */
const PORT_HINTS = [
  '**the most common serial trap: another program is holding the port exclusively** ✓',
  '  (the local `serial-server.py` swallows the replies ✓ — the board is alive, the serial link is fine ✓,',
  '    but the exec of the application itself never receives anything ✓ — so every reader reports "timeout" ✓.)',
  '  stop that process first, then retry ✓.',
];

/** It opens but there is no reply → say "the board said nothing" ✓ */
const NO_REPLY_HINTS = [
  '**the board said nothing** — it is connected, but it did not reply ✓.',
  '  the three most common reasons ✓:',
  '  ① **the baud rate is wrong** ✓ (try a few common baud rates in a serial tool ✓ — **this board is 1500000** ✓);',
  '  ② **this port is not the debug port** ✓ (the wrong port was plugged in ✓);',
  '  ③ **the replies are swallowed by another program** ✓ (something holds the port exclusively ✓).',
];

/** There is garbage → say the baud rate ✓ */
const WRONG_BAUD_HINTS = [
  '**there are replies but they look like garbage** — the baud rate is wrong ✓.',
  '  try a few common baud rates in a serial tool ✓ — **this board is 1500000** ✓.',
];

/**
 * The state → the description ✓ (what the interface shows ✓).
 *
 * → "It did not reply" and "the connection failed" have to be said
 *   apart ✓
 * → When everything is red it has to say "that is a problem of the
 *   connection" ✓ (not a problem of the readers ✓ — the same as
 *   `probeHint` ✓).
 */
export function describeWizard(state: WizardState): WizardDescription {
  // ── The first step: the person has not chosen yet ──
  if (state.step === 'choose-serial') {
    return {
      kind: 'ok',
      message: 'choose a serial port and a baud rate — this is the only thing you have to do in the whole wizard ✓',
      hints: [
        '**do not know the baud rate?** ✓ this board is **1500000** ✓ (a fact from `docs/02-device-facts.md` ✓).',
        '**the COM port is in the device manager** ✓ (CH343 USB-UART ✓ — COM3 is common ✓).',
      ],
      next: 'first-truth',
    };
  }

  // ── The first truth ──
  if (state.step === 'first-truth') {
    const truth = state.firstTruth;
    if (truth === undefined) {
      return { kind: 'ok', message: 'establishing the first truth ✓', hints: [], next: null };
    }
    if (truth.ok) {
      return {
        kind: 'ok',
        message: `the first truth holds ✓ —— ${truth.detail}`,
        hints: [],
        next: 'probe-generic',
      };
    }
    if (truth.kind === 'port-unopenable') {
      return {
        kind: 'port-unopenable',
        message: `**the serial port cannot be opened** ✓ —— ${truth.detail}`,
        hints: PORT_HINTS,
        next: null,
      };
    }
    if (truth.kind === 'wrong-baud') {
      return {
        kind: 'wrong-baud',
        message: `**there are replies but they look like garbage** ✓ —— ${truth.detail}`,
        hints: WRONG_BAUD_HINTS,
        next: null,
      };
    }
    // It did not reply ✓ — it explicitly does not say "the connection failed" ✓
    return {
      kind: 'no-reply',
      message: `**the board said nothing** ✓ —— ${truth.detail} (**it is connected, it just did not reply** ✓)`,
      // The hint of the transport goes first ✓ — it is the most accurate one ✓
      // (the serial HAL knows "the reply was swallowed by another program" ✓ → do not push it to the back ✗)
      hints:
        truth.hint !== undefined
          ? [truth.hint, ...NO_REPLY_HINTS]
          : NO_REPLY_HINTS,
      next: null,
    };
  }

  // ── Trying the generic meta-operations ──
  if (state.step === 'probe-generic') {
    const outcomes = state.outcomes ?? [];
    const green = outcomes.filter((o) => o.ok).map((o) => o.readerId);
    const red = outcomes
      .filter((o) => !o.ok)
      .map((o) => ({ readerId: o.readerId, detail: o.problems.join('; ') }));
    const summary: TruthTable = { green, red };

    // Not a single number came out → that is a problem of the connection ✓ (not of the readers ✓)
    if (outcomes.length > 0 && green.length === 0) {
      return {
        kind: 'connection-dead',
        message:
          '**not a single number came out** ✓ —— **it is most likely not the problem of those meta-operations** ✓, ' +
          '**this connection never came up once** ✓',
        hints: [
          '**check the connection itself first** ✓ (can it connect ✓ · is the board there ✓), **then check the meta-operations** ✓.',
          '**the most common serial trap: another program is holding the port exclusively** ✓.',
        ],
        next: null,
        summary,
      };
    }
    return {
      kind: 'ok',
      message:
        `done ✓ —— **${green.length} green** ✓ (this board has them ✓) · ` +
        `**${red.length} red** ✓ (this board does not have them / the reading is wrong ✓)`,
      hints:
        red.length > 0
          ? ['**the red ones** ✓ → **they are dropped when the pack is instantiated** ✓ ("keep the green, drop the red" ✓).']
          : [],
      next: 'instantiate',
      summary,
    };
  }

  // ── Instantiate / done ──
  if (state.step === 'instantiate') {
    return {
      kind: 'ok',
      message: 'turning it into the pack of this board ✓ (and keeping a copy of its provenance ✓)',
      hints: [],
      next: 'done',
    };
  }
  return {
    kind: 'ok',
    message: 'done ✓ —— this board now has a pack of its own ✓',
    hints: [
      '**that is the first-draft pack found automatically** ✓: **what it states accurately are facts** ✓ (whether it exists ✓ · how many ✓),',
      '**what it states inaccurately are the names and the semantics** ⚠️ (which thermal zone is the SoC ✓ · that an agent has to fill in ✓).',
    ],
    next: null,
  };
}
