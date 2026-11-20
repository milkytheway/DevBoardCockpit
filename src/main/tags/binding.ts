import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoardPack } from './pack';
import type { BoardPack } from './schema';

/**
 * The binding between a board pack and a connection (contract
 * `docs/spec/02-board-pack.md` section 10).
 *
 * ── The two things the contract asks for ──
 *
 * | Contract | Here |
 * |---|---|
 * | "adopt 'the connection names one, automatic detection as a fallback'" | `boardPackId` is not empty → use it; otherwise read the model and detect |
 * | "what if it cannot be recognised: do not guess. Report 'this board has no board pack'" | zero or several matches → `source: 'none'` plus a reason |
 *
 * ── Why automatic detection reads the model once instead of running the
 *    readers to see what comes back ──
 *
 * Contract section 10 puts it plainly: `board.model` is itself a tag that
 * some board pack provides — "if the binding happens before the readers
 * start, there is a chicken-and-egg problem". The contract therefore does
 * not adopt probe matching (running the readers to see what comes back is
 * infinitely recursive) but a one-shot probe: read the model string and
 * match it against `match.models`.
 *
 * ── Why "do not guess" matters so much ──
 *
 * Contract section 10: "this matters: a board pack is an enhancement, not a
 * precondition." And the consequence of a wrong guess is "binding
 * `gpu.usage` to a board without a GPU — a gauge that is permanently 0".
 *
 * A gauge that is permanently 0 is more dangerous than no gauge at all (the
 * same point as fact G2): it looks real.
 */

/** The capability needed to read the model (only exec is used) */
export interface ModelReader {
  exec(
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr?: string }>;
}

/** The match rules of contract section 10 */
export function matchPack(pack: BoardPack, model: string): boolean {
  const match = pack.match;
  if (match === undefined) return false;
  if (match.models.length === 0) return false;

  const target = model.trim();
  if (target.length === 0) return false;

  if (match.mode === 'exact') {
    return match.models.some((m) => m === target);
  }
  if (match.mode === 'substring') {
    return match.models.some((m) => target.includes(m));
  }
  // An unknown mode → no match (do not guess)
  return false;
}

/** The result of the binding */
export type PackBinding =
  | { pack: BoardPack; source: 'profile'; reason?: undefined }
  | { pack: BoardPack; source: 'auto'; reason?: undefined }
  | { pack: null; source: 'none'; reason: string };

export interface ResolvePackOptions {
  /** The connection (used to read the model) */
  connection: ModelReader;
  /** The board_pack of the connection profile (may be null) */
  boardPackId: string | null;
  /** The parent directory of the board pack directories (the built-in one) */
  packsDir: string;
  /**
   * The user's own board pack directory (optional — it is skipped when it
   * does not exist).
   *
   * → Why it is there (added 2026-11-19): the runtime reads only one
   *   directory → nothing read the packs in the user data directory → what
   *   the wizard instantiates would be dead on arrival.
   * → On the same id the user's pack wins (the same rule as in
   *   `profiles/loader.ts`).
   */
  userPacksDir?: string;
  /** How to read the model. By default the connection's exec reads /proc/device-tree/model */
  readModel?: () => Promise<string>;
}

/**
 * Every board pack of the given directories (sorted by pack id, the order is
 * stable).
 *
 * ── Why several directories instead of one (added 2026-11-19) ──
 *
 * → The state of affairs: only the built-in one — `src/main/index.ts:210`
 *   `packsDir: join(app.getAppPath(), 'profiles', 'boards')`
 *   → it is always the one inside the asar → nothing read the board packs
 *   in the user data directory.
 * → The consequence: what the wizard instantiates is dead on arrival.
 * → And this is not only about the wizard: even today a user who drops a
 *   pack into the user data directory cannot be read by the runtime — a
 *   hole that already existed and that nobody mentioned.
 *
 * ── Which set of rules to follow (of the three merge logics, the cleanest
 *    one wins) ──
 *
 * | Thing | How it is merged | Where it comes from |
 * |---|---|---|
 * | Connection profile | ✅ the built-in first, the user's second — on the same id the user's overrides the built-in ✓ | `profiles/loader.ts` ✓ |
 * | Workflow pack | ✅ the one scanned later overrides the one scanned earlier ✓ | `workflows/registry.ts` ✓ |
 * | Card | ✅ `roots: CardRoot[]` ✓ | `cards/wiring.ts` ✓ |
 * | Board pack | ⚠️ only the built-in ✗ → this entry fills that in ✓ | — |
 *
 * → Follow the pattern of `profiles/loader.ts` — one `Map` plus one
 *   `collect`.
 *
 * ── A broken pack does not take the rest down ──
 *
 * → A pack that fails to load is only skipped (the same as in the profile
 *   loader)
 * → A typo must not keep the whole application from starting.
 */
export function listPacksIn(dirs: readonly string[]): BoardPack[] {
  const merged = new Map<string, BoardPack>();
  for (const packsDir of dirs) {
    if (!existsSync(packsDir)) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(packsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) continue;
      const dir = join(packsDir, entry.name);
      if (!existsSync(join(dir, 'board.yaml'))) continue;
      try {
        const pack = loadBoardPack(dir);
        merged.set(pack.id, pack);
      } catch {
        // A broken pack is only skipped (the same as in the profile loader)
      }
    }
  }
  // The one scanned later overrides the one scanned earlier → the caller puts the user directory last
  return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Read the model once */
async function readModelOf(opts: ResolvePackOptions): Promise<string> {
  if (opts.readModel !== undefined) return opts.readModel();
  const result = await opts.connection.exec('cat /proc/device-tree/model');
  // The model string of the device tree ends with a NUL (measured), strip it before comparing.
  return result.stdout.replace(/\0+$/, '').trim();
}

/**
 * Work out which board pack this connection should use.
 *
 * Do not guess: zero or several candidates both return `source: 'none'`,
 * with the reason spelled out.
 */
export async function resolvePack(opts: ResolvePackOptions): Promise<PackBinding> {
  // Two directories (the built-in plus the user one — the user's last → on the same id the user's wins)
  const packDirs = opts.userPacksDir === undefined ? [opts.packsDir] : [opts.packsDir, opts.userPacksDir];

  // 1) The connection names one → use it (the model is not read)
  const namedId = opts.boardPackId;
  if (namedId !== null && namedId.length > 0) {
    // Both directories are searched — otherwise a pack in the user directory cannot be reached by name
    for (const dir of packDirs) {
      const candidate = join(dir, namedId);
      if (!existsSync(join(candidate, 'board.yaml'))) continue;
      try {
        return { pack: loadBoardPack(candidate), source: 'profile' };
      } catch {
        // A broken pack → say so (not silently)
        return {
          pack: null,
          source: 'none',
          reason: `the connection names the board pack "${opts.boardPackId}", but board.yaml cannot be read in ${candidate}`,
        };
      }
    }
    return {
      pack: null,
      source: 'none',
      reason:
        `the connection names the board pack "${opts.boardPackId}", but ` +
        `none of ${packDirs.map((d) => join(d, namedId)).join(' and ')} holds a board.yaml`,
    };
  }

  // 2) Automatic detection as a fallback: read the model once
  const model = await readModelOf(opts);

  // 3) Compare against the match of every pack (the packs of both directories together)
  const hits = listPacksIn(packDirs).filter((p) => matchPack(p, model));

  if (hits.length === 1) {
    return { pack: hits[0], source: 'auto' };
  }
  if (hits.length === 0) {
    return {
      pack: null,
      source: 'none',
      reason: `this board has no board pack (the model "${model}" matches none of the packs)`,
    };
  }
  return {
    pack: null,
    source: 'none',
    reason:
      `**several** board packs match the model "${model}" (${hits.map((p) => p.id).join(' / ')})` +
      '— never guess, let the connection name the one it wants',
  };
}
