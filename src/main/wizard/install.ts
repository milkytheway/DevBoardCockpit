import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import type { BoardPack, PollGroupDef, ProvidesDef, ReaderDef } from '../tags/schema';
import type { Provenance } from './instantiate';

/**
 * Write the instantiated pack to disk ✓.
 *
 * ── Where it lands ──
 *
 * → The user data directory ✓ (`%LOCALAPPDATA%\DevBoardCockpit\boards\<id>\` ✓)
 *   → A board the user added does not belong in version control ✓
 *   → It is kept apart from the built-in `rk3588-atk` ✓ → the user's
 *     wins on the same id ✓ (the merge of section 1 ✓).
 *
 * ── Two things are written ──
 *
 * | File | What it is |
 * |---|---|
 * | `board.yaml` | the pack itself ✓ → the same shape as the built-in packs ✓ → it gets the validator for free ✓ |
 * | `provenance.json` | "where it came from" ✓ → "it was guessed" has to leave a trace ✓ |
 *
 * ── ⚠️ It has to pass the validator before it is written ──
 *
 * → Writing a pack that does not pass the validator = dead on arrival
 *   ⚠️ (the runtime reads it → it reports "the pack is broken" ⚠️)
 * → So: verify first, then write ✓ — a broken one is never
 *   written ✓.
 */
export interface InstallPackOptions {
  /** The pack itself ✓ */
  pack: BoardPack;
  /** Where it came from ✓ */
  provenance: Provenance;
  /** The parent directory of the user board packs ✓ (`userBoardsDir()` ✓) */
  boardsRoot: string;
  /** Overwrite it when it is already there (not by default ✓ — the things of the user are never overwritten silently ✓) */
  overwrite?: boolean;
}

/** What one reader becomes in the yaml (only the fields that the yaml has ✓ — a closed schema ✓) */
function readerYaml(reader: ReaderDef): Record<string, unknown> {
  const out: Record<string, unknown> = { id: reader.id, kind: reader.kind };
  if (reader.args !== undefined && Object.keys(reader.args).length > 0) out['args'] = reader.args;
  out['provides'] = reader.provides.map((p: ProvidesDef) => ({ tag: p.tag, sample: p.sample }));
  return out;
}

/** What one group becomes in the yaml */
function groupYaml(group: PollGroupDef): Record<string, unknown> {
  return { id: group.id, interval_ms: group.interval_ms, readers: group.readers };
}

/**
 * The pack itself → the shape of the yaml ✓.
 *
 * → Only the fields the contract knows ✓ (the closed schema of
 *   `spec/02` section 1 ✓)
 * → A field that is written extra is rejected by the loader ✓ (rule 10
 *   ✓ · 24 ✓) → so nothing extra may be written here ✓.
 */
export function packToYamlShape(pack: BoardPack): Record<string, unknown> {
  const out: Record<string, unknown> = {
    apiVersion: pack.apiVersion,
    kind: pack.kind,
    id: pack.id,
    name: pack.name,
    version: pack.version,
  };
  if (pack.description !== undefined) out['description'] = pack.description;
  out['requires'] = {
    transports: pack.requires.transports,
    capabilities: pack.requires.capabilities,
    ...(pack.requires.min_contract !== undefined ? { min_contract: pack.requires.min_contract } : {}),
  };
  if (pack.danger_floor_version !== undefined) out['danger_floor_version'] = pack.danger_floor_version;
  // The `match` is deliberately not written ✓ — see the comment in `instantiate.ts` ✓
  out['poll_groups'] = pack.poll_groups.map(groupYaml);
  out['readers'] = pack.readers.map(readerYaml);
  out['custom'] = pack.custom.map(readerYaml);
  out['actions'] = pack.actions;
  return out;
}

/**
 * Write it to disk ✓.
 *
 * → Verify first, then write ✓ (a broken one is never written ✓)
 * → When it is already there it is not overwritten by default ✓
 *   (the things of the user are never overwritten silently ✓).
 *
 * @returns where it was written ✓ (so that the interface can say "where
 *   it is" ✓)
 */
export function installInstantiatedPack(opts: InstallPackOptions): { dir: string; yamlPath: string } {
  const dir = join(opts.boardsRoot, opts.pack.id);
  const yamlPath = join(dir, 'board.yaml');
  if (existsSync(yamlPath) && opts.overwrite !== true) {
    throw new Error(`there is already a pack there (${yamlPath}) — it is not silently overwritten ✓`);
  }
  mkdirSync(dir, { recursive: true });
  const yaml = dump(packToYamlShape(opts.pack), { indent: 2, lineWidth: 100, noRefs: true });
  writeFileSync(yamlPath, yaml, 'utf8');
  writeFileSync(join(dir, 'provenance.json'), `${JSON.stringify(opts.provenance, null, 2)}\n`, 'utf8');
  return { dir, yamlPath };
}
