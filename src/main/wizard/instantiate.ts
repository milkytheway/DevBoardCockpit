import type { BoardPack, PollGroupDef, ReaderDef } from '../tags/schema';

/**
 * **实例化** —— 把「通用包」变成「一块板的包」✓。
 *
 * ── 它解决的是「鸡生蛋」✓ ──
 *
 * → **旧路**：要有板型包 → 才能连板 → 才能探针 → 才知道这板能干什么 ✗
 * → **新路**：**用通用包连上板** ✓ → **试通用包** ✓ → **试出来的就是这块板的包** ✓
 *   （`docs/探索/02` §一·1.2 第③条 ✓ · §十 ✓）
 *
 * ── 它是**纯函数** ✓ —— 不碰文件 ✓ 不碰连接 ✓
 *   → **好测** ✓（`tests/unit/wizard-instantiate.test.ts` ✓ · **9 条判据** ✓）
 *   → **落盘是另一件事** ✓（`install.ts` ✓ —— 那是 I/O ✓）
 *
 * ── ⚠️ **它必须改写 `custom.` 前缀**（**最容易漏的一步** ✓）──
 *
 * → **规则 1** ✓：`tag` 必须落在核心词表**或 `custom.<本包 id>.` 下** ✓
 *   （`isCustomTag(name, packId)` → `custom.${packId}.*` ✓）。
 * → 通用包的 id 是 `generic-linux` ✓ → **它的 tag 必然是 `custom.generic-linux.*`** ✓。
 * → **实例化出来的包 id 是 `atk-01`** ✓ → **那些 tag 原样带过去 → 规则 1 立刻拦** ⚠️
 *   → **落盘的包天生是非法的** ⚠️ → **向导的产物落地即废** ⚠️。
 * → **所以：前缀必须重写** ✓ —— `custom.generic-linux.*` → `custom.atk-01.*` ✓。
 *
 * ── 它与现有包**同形** ✓ ──
 *
 * → `rk3588-atk` 那份包里的 `custom.rk3588-atk.*` ✓ → **同一个形状** ✓
 * → **所以产物白拿校验器** ✓ → **判据就是「它必须过真校验器」** ✓。
 */

/** 一条探针结果（**一个 reader 绿不绿** ✓） */
export interface ProbeOutcome {
  /** reader 的 id ✓ */
  readerId: string;
  /** 绿不绿 ✓ */
  ok: boolean;
  /** 为什么红 / 什么形状 ✓（**给人看的** ✓） */
  detail: string;
  /** 它产出的 tag（**绿的时候才有值** ✓） */
  tags: { tag: string; value: unknown }[];
}

/** 连接是「怎么连上的」✓（**进 provenance** ✓ —— 「这份包是怎么来的」✓） */
export interface ProbeConnection {
  transport: string;
  port?: string;
  baudrate?: number;
}

/** 一条「这是猜的」✓ */
export interface GuessedNote {
  /** 猜的是什么（tag 或 reader id ✓） */
  what: string;
  /** 为什么是猜的 ✓ */
  why: string;
  /** 要人/agent 确认吗 ✓ */
  needsHuman: boolean;
}

/** `provenance.json` 的形状（**「这份包是猜的」必须留痕** ✓） */
export interface Provenance {
  /** 从哪个通用包实例化而来 ✓ */
  source: string;
  /** 实例化出来的包 id ✓ */
  targetId: string;
  /** 什么时候探的 ✓ */
  probedAt: string;
  /** 怎么连上的 ✓ */
  connection: ProbeConnection | null;
  /** **猜的**那些 ✓ */
  guessed: GuessedNote[];
  /** **这板没有**的那些 ✓（**也是事实** ✓） */
  missing: { readerId: string; detail: string }[];
}

/** 实例化的结果 */
export interface InstantiateResult {
  /** 实例化出来的包 ✓ */
  pack: BoardPack;
  /** 它的来路 ✓ */
  provenance: Provenance;
}

/** 实例化的输入 */
export interface InstantiateOptions {
  /** 通用包（**配方** ✓） */
  source: BoardPack;
  /** 新包的 id ✓（**一块板一个** ✓） */
  targetId: string;
  /** 新包的名字 ✓（**给人看的** ✓） */
  targetName: string;
  /** 探针的结果 ✓（**每个 reader 一条** ✓） */
  outcomes: ProbeOutcome[];
  /** 怎么连上的 ✓（**可选** ✓） */
  connection?: ProbeConnection;
  /** 现在是什么时候（**可注入** ✓ —— 好测 ✓） */
  now?: () => Date;
}

/**
 * **`custom.<旧 id>.` → `custom.<新 id>.`** ✓
 *
 * → **只改 custom 命名空间** ✓ → **核心词表里的 tag 一律不动** ✓
 *   （`cpu.usage` 不是 custom ✓ —— 改它就是**改契约** ✗）。
 */
export function retagCustom(tag: string, fromId: string, toId: string): string {
  const prefix = `custom.${fromId}.`;
  if (!tag.startsWith(prefix)) return tag;
  return `custom.${toId}.${tag.slice(prefix.length)}`;
}

/** 一个 reader 的 tag 前缀全改了 ✓ */
function retagReader(reader: ReaderDef, fromId: string, toId: string): ReaderDef {
  return {
    ...reader,
    provides: reader.provides.map((p) => ({ ...p, tag: retagCustom(p.tag, fromId, toId) })),
  };
}

/**
 * **哪些量是「猜的」** ✓ —— 通用包**给不出**板子特有的名字 ✓。
 *
 * → **温区的归并** ✓（`type_map` 是猜的 ✓ —— 哪个温区是 SoC **要手册才知道** ✓）。
 * → **其余的**：路径是 Linux 的**约定** ✓ → **不是猜** ✓（有没有 ✓ 几个 ✓ 是事实 ✓）。
 */
function guessedOf(pack: BoardPack): GuessedNote[] {
  const out: GuessedNote[] = [];
  for (const reader of [...pack.readers, ...pack.custom]) {
    if (reader.kind !== 'thermal_zone') continue;
    out.push({
      what: reader.id,
      why:
        '**the grouping of the thermal zones is a guess** — the `type_map` of the generic pack is a guess at "common names" ✓;' +
        '**which thermal zone is the SoC / GPU / NPU can only be known from the manual of this board** ✓',
      needsHuman: true,
    });
  }
  return out;
}

/**
 * **实例化**：通用包 + 探针结果 → 这块板的包 ✓。
 *
 * ── 规则只有一条 ──
 *
 * → **「绿的留、红的删」** ✓（`docs/探索/02` §四.1 ✓）
 * → **红的、但板子上确实有别的 → 留给 agent 发现** ✓（**不猜** ✓）。
 */
export function instantiatePack(opts: InstantiateOptions): InstantiateResult {
  const { source, targetId, targetName, outcomes } = opts;
  const okByReader = new Map<string, ProbeOutcome>();
  for (const o of outcomes) okByReader.set(o.readerId, o);

  // ── 1. 绿的留、红的删 ✓ ──
  const keep = (reader: ReaderDef): boolean => okByReader.get(reader.id)?.ok === true;

  const readers = source.readers.filter(keep).map((r) => retagReader(r, source.id, targetId));
  const custom = source.custom.filter(keep).map((r) => retagReader(r, source.id, targetId));

  // ── 2. 组里只留还在的 reader ✓；组空了 → 整个组去掉 ✓ ──
  const alive = new Set([...readers, ...custom].map((r) => r.id));
  const pollGroups: PollGroupDef[] = [];
  for (const group of source.poll_groups) {
    const kept = group.readers.filter((rid) => alive.has(rid));
    if (kept.length === 0) continue;
    pollGroups.push({ id: group.id, interval_ms: group.interval_ms, readers: kept });
  }

  // ── 3. 动作：留 ✓（**动作不探测** ✓ —— 它们要写侧才试得到 ✓）──
  const actions = source.actions;

  const pack: BoardPack = {
    apiVersion: source.apiVersion,
    kind: 'BoardPack',
    id: targetId,
    name: targetName,
    version: source.version,
    description:
      `**the first-draft pack found automatically** ✓ (instantiated from the generic pack "${source.id}" ✓) — ` +
      '**what it states accurately are facts** ✓ (whether it exists ✓ · how many ✓),' +
      '**what it states inaccurately are the names and the semantics** ⚠️ (which thermal zone is the SoC ✓ · that an agent has to fill in ✓)',
    requires: { ...source.requires },
    ...(source.danger_floor_version !== undefined
      ? { danger_floor_version: source.danger_floor_version }
      : {}),
    // **故意不写 `match`** ✓ —— **型号要人来定** ✓（通用包猜的 ✓ · 实例化也猜 ✓）
    // → **不写 → 它不参与自动识别** ✓ → **不会跟别的包抢** ✓
    poll_groups: pollGroups,
    readers,
    custom,
    actions,
  };

  // ── 4. 来路 ✓ ──
  const missing = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ readerId: o.readerId, detail: o.detail }));

  const provenance: Provenance = {
    source: source.id,
    targetId,
    probedAt: (opts.now?.() ?? new Date()).toISOString(),
    connection: opts.connection ?? null,
    guessed: guessedOf(source),
    missing,
  };

  return { pack, provenance };
}
