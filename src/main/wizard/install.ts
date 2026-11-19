import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import type { BoardPack, PollGroupDef, ProvidesDef, ReaderDef } from '../tags/schema';
import type { Provenance } from './instantiate';

/**
 * **把实例化出来的包落盘** ✓。
 *
 * ── 它落在哪 ──
 *
 * → **用户数据目录** ✓（`%LOCALAPPDATA%\DevBoardCockpit\boards\<id>\` ✓）
 *   → **用户加的板不该进版本库** ✓（`docs/探索/02` §九·Q3 ✓）
 *   → **与 `rk3588-atk` 那份内置的分开** ✓ → **同名用户优先** ✓（§一 合并 ✓）。
 *
 * ── 落两样东西 ──
 *
 * | 文件 | 是什么 |
 * |---|---|
 * | `board.yaml` | **包本体** ✓ → 与内置包**同形** ✓ → **白拿校验器** ✓ |
 * | `provenance.json` | **「它是怎么来的」** ✓ → **「猜的」必须留痕** ✓ |
 *
 * ── ⚠️ **落盘前必须过校验器** ✓ ──
 *
 * → **落一个过不了校验的包 = 落地即废** ⚠️（运行时读它 → 报「包坏了」⚠️）
 * → **所以：先验，再落** ✓ —— **不落坏的** ✓。
 */
export interface InstallPackOptions {
  /** 包本体 ✓ */
  pack: BoardPack;
  /** 它的来路 ✓ */
  provenance: Provenance;
  /** **用户板型包目录的父目录** ✓（`userBoardsDir()` ✓） */
  boardsRoot: string;
  /** 存在就覆盖吗（**默认不** ✓ —— **不悄悄覆盖用户的东西** ✓） */
  overwrite?: boolean;
}

/** 一个 reader 落成什么样（**只留 yaml 里有的字段** ✓ —— 封闭 schema ✓） */
function readerYaml(reader: ReaderDef): Record<string, unknown> {
  const out: Record<string, unknown> = { id: reader.id, kind: reader.kind };
  if (reader.args !== undefined && Object.keys(reader.args).length > 0) out['args'] = reader.args;
  out['provides'] = reader.provides.map((p: ProvidesDef) => ({ tag: p.tag, sample: p.sample }));
  return out;
}

/** 一个组落成什么样 */
function groupYaml(group: PollGroupDef): Record<string, unknown> {
  return { id: group.id, interval_ms: group.interval_ms, readers: group.readers };
}

/**
 * **包本体 → yaml 的形状** ✓。
 *
 * → **只写契约认的字段** ✓（`spec/02` §一 的封闭 schema ✓）
 * → **多写的字段会被加载器拒** ✓（规则 10 ✓ · 24 ✓）→ **所以这里必须不多写** ✓。
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
  // **故意不写 `match`** ✓ —— 见 `instantiate.ts` 的注释 ✓
  out['poll_groups'] = pack.poll_groups.map(groupYaml);
  out['readers'] = pack.readers.map(readerYaml);
  out['custom'] = pack.custom.map(readerYaml);
  out['actions'] = pack.actions;
  return out;
}

/**
 * **落盘** ✓。
 *
 * → **先验再落** ✓（**不落坏的** ✓）
 * → **存在就默认不覆盖** ✓（**不悄悄覆盖用户的东西** ✓）。
 *
 * @returns 落盘的位置 ✓（**给界面说「它在哪」✓**）
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
