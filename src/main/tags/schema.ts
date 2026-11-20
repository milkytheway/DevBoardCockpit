/**
 * The data structures of a board pack (pure types, no logic).
 *
 * Contract: `docs/spec/02-board-pack.md` section 1 (what a pack looks
 * like), section 4 (the actions).
 *
 * These types only describe "what may be written in a pack", they do not
 * judge "whether it is written right" — that is the validator's business
 * (`validator.ts`, the 27 rules). The loader (`pack.ts`) only checks the
 * structure: whether a field is there, whether the type is right, whether it
 * is in the right place.
 *
 * Why the split into three files:
 * - `schema.ts` — the shape (here)
 * - `pack.ts` — read it in + the structural check
 * - `validator.ts` — the semantic check (the 27 rules)
 *
 * The consequence of mixing them is very concrete: an error like "the
 * argument name is misspelled" would be reported as "the pack is broken",
 * while it really is "the argument name of the kind is wrong" — the fixes
 * are completely different.
 */

/** The declaration of an action parameter (contract section 4.3) */
export interface PackParam {
  type: 'integer' | 'number' | 'string' | 'boolean' | 'enum';
  min?: number;
  max?: number;
  default?: unknown;
  /** The list of allowed values for `type: enum`, non-empty (rule 20) */
  values?: string[];
  /** Required for `type: string` (rule 20) — a string parameter without an upper bound is an injection surface */
  maxLength?: number;
  pattern?: string;
}

/** The parameter domain (contract section 5.5). It may only narrow the declared domain of the params, never widen it (rule 22) */
export interface PackGuard {
  min?: number;
  max?: number;
}

/** One binding of `provides`: sample → tag (contract section 1.1) */
export interface ProvidesDef {
  tag: string;
  sample: string;
}

/** One reader (contract section 2) */
export interface ReaderDef {
  id: string;
  /** The name of the kind (the closed list of contract section 2.4) */
  kind: string;
  /** The arguments of the kind. The content is not the loader's business — whether the argument names are right is asked of the schema of the kind (rule 8) */
  args?: Record<string, unknown>;
  provides: ProvidesDef[];
}

/** One poll group (contract section 1.2): one group = one round trip */
export interface PollGroupDef {
  id: string;
  interval_ms: number;
  /** The ids of the readers of this group (rule 17: every reader belongs to exactly one group) */
  readers: string[];
}

/**
 * The readback block (the five forms of contract section 4.4).
 *
 * The shape is flat — it does not fork on `kind` here:
 * "which kinds there are", "`none` has to carry a `consequence`" and
 * "`destructive` may not use `none`" are the business of rules 15 / 23 / 27
 * and belong to the validator. The loader only reports "what was written
 * here", it does not make the judgement for the contract.
 */
export interface ReadbackDef {
  /** Not written means form 1 (read one tag) */
  kind?: string;
  tag?: string;
  expect?: unknown;
  path?: string;
  tolerance?: number;
  command?: string;
  timeout_ms?: number;
  /** Required and non-empty for `kind: none` (rule 27) */
  consequence?: string;
}

/** One action (contract section 4) */
export interface ActionDef {
  id: string;
  label?: string;
  danger: 'reversible' | 'destructive';
  params?: Record<string, PackParam>;
  guard?: Record<string, PackGuard>;
  command: string;
  /** Every action has to have one (rule 27) — `reversible` is no exception */
  readback?: ReadbackDef;
}

/** A board pack */
export interface BoardPack {
  apiVersion: string;
  kind: 'BoardPack';
  id: string;
  name: string;
  version: string;
  description?: string;
  requires: {
    transports: string[];
    /** The board-level capabilities (closed vocabulary, contract section 10.3.1) */
    capabilities: string[];
    min_contract?: string;
  };
  /** The version of the danger floor table (contract section 5.2.1). There is only 1 so far */
  danger_floor_version?: number;
  /** The model rules for the automatic detection (contract section 10). The domain of `mode` is checked by rule 11 */
  match?: { mode: string; models: string[] };
  poll_groups: PollGroupDef[];
  /** The general capabilities of the board (contract section 9) */
  readers: ReaderDef[];
  /** The board-private capabilities (contract section 9). Empty when there are none */
  custom: ReaderDef[];
  actions: ActionDef[];
}
