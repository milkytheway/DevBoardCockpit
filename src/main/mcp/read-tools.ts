import { CORE_VOCABULARY } from '../../shared/generated/tag-vocabulary.generated';
import { matchTagPattern } from '../tags/vocabulary';
import type { TagReading } from '../../shared/tag-reading';
import type { PackView, ReaderView } from '../tags/pack-view';
import type { McpHostDeps, McpCardEntry, TagSampleLike } from './host';
import { deviceKeyOf } from '../profiles/schema';
import { withVersion, withVersionEach } from './convention';

export { withVersion, withVersionEach };

/**
 * **读侧工具的投影**（契约 `spec/04` §2.1 / §2.2 / §2.3 ✓ · ADR-D40 ✓）。
 *
 * ── 这一层只做「翻译」──
 *
 * → **宿主侧的词 → 契约的词** ✓：
 * | 宿主侧 | 契约 |
 * |---|---|
 * | `TagReading.tag` | `name` ✓ |
 * | `LayoutUnit.cardId` | `card_id` ✓ |
 * | `LayoutUnit.units` | `cards` ✓ |
 * | `reader.id` | `id` ✓ |
 *
 * → **判断不在这里** ✓ —— 全部在宿主侧算好 ✓（`cards/state.ts` ✓ · `tags/pack-view.ts` ✓）✓
 * → **这里只做形状** ✓（契约 §六「MCP server 应该是薄的」✓）。
 */

/* ══════════════════════════════════════════════════════════════════
   感知现状（契约 §2.1 ✓）
   ══════════════════════════════════════════════════════════════════ */

/** `list_connections` ✓ */
export function listConnections(deps: McpHostDeps): Record<string, unknown>[] {
  const current = deps.currentProfileId();
  return deps.profiles().map((profile) => ({
    id: profile.id,
    label: profile.label,
    transport: profile.transport,
    // **绑定的板型包 id** ✓ —— **没绑就是 `null`** ✓（**不给版本** ✓ —— 版本是包自己的属性 ✓）
    board_pack: profile.board_pack ?? null,
    // **这块板的标识** ✓（契约 `spec/02` §10.2 ✓）——
    // **同一块板的多条连接给同一个** ✓ → agent 才知道哪些连接是同一块板 ✓
    device_key: deviceKeyOf(profile),
    // **它是当前运行时那条连接吗** ✓（**与 `connected` 是两条判据** ✓ —— 不混 ✓）
    current: current === profile.id,
    // **这条 profile 现在有活连接吗** ✓（**光看「运行时记着它」不够** ✓ —— 那个在连不上时仍有值 ✓）
    connected: deps.connected(profile.id),
    // **连接级**能力位 ✓（**不是板级词表** ✓）
    capabilities: deps.capabilities(profile),
  }));
}

/** `list_data_sources` ✓ */
export function listDataSources(deps: McpHostDeps): Record<string, unknown>[] {
  const pack = deps.pack();
  // **没有包 → 空数组** ✓（没有数据源 ✓ —— 不是「一个都没有的包」✓）
  if (pack === null) return [];
  const readings = deps.readings();
  return pack.readers.map((reader) => ({
    // **reader 的 id** ✓（数据源就是 reader 粒度 ✓ —— 契约 §2.1 原话 ✓）
    id: reader.id,
    // **当前板型包的 id** ✓（不是连接 id ✓）
    board: pack.id,
    poll_group: reader.poll_group,
    kind: reader.kind,
    interval_ms: reader.interval_ms,
    // **展开成具体 tag 名** ✓（包里写的是模式 ✓ —— agent 要写卡 ✓ 要具体名 ✓）
    provides: expandProvides(reader, readings),
    status: readerStatus(reader, readings),
  }));
}

/**
 * **一个 reader 提供的具体 tag 名** ✓。
 *
 * → **展开模式** ✓（`cpu.core.*.usage` → 当前实际有的 `cpu.core.0.usage` ✓ · …）✓
 * → **读数里没有的那个核就不给** ✓（**不猜** ✓ —— 采样器也不猜 ✓）
 * → **一个都没有 → 空数组** ✓
 */
function expandProvides(reader: ReaderView, readings: TagReading[]): string[] {
  const out: string[] = [];
  for (const pattern of reader.provides) {
    for (const reading of readings) {
      if (matchTagPattern(pattern, reading.tag)) {
        if (!out.includes(reading.tag)) out.push(reading.tag);
      }
    }
  }
  return out.sort();
}

/**
 * **reader 自身的状态** ✓（契约 §2.1 的映射表 ✓ —— **不是「取最差」** ✓）。
 *
 * | 情形 | 状态 |
 * |---|---|
 * | 它的 tag 一个都不在读数里 | `pending` |
 * | 有 tag，且全部 `unavailable` | `unavailable` |
 * | 有 tag，且存在 `error` | `error` |
 * | 有 tag，且存在 `stale`（无 error） | `stale` |
 * | 全部 `ok` | `ok` |
 */
function readerStatus(reader: ReaderView, readings: TagReading[]): TagReading['status'] {
  const mine = readings.filter((r) =>
    reader.provides.some((p) => matchTagPattern(p, r.tag)),
  );
  if (mine.length === 0) return 'pending';
  if (mine.some((r) => r.status === 'error')) return 'error';
  if (mine.every((r) => r.status === 'unavailable')) return 'unavailable';
  if (mine.some((r) => r.status === 'stale')) return 'stale';
  if (mine.some((r) => r.status === 'pending')) return 'pending';
  return 'ok';
}

/** `list_capabilities` ✓ */
export function listCapabilities(deps: McpHostDeps): Record<string, unknown> {
  const transports = new Set(deps.profiles().map((p) => p.transport));
  return {
    // **连接级**能力的封闭词表 ✓（`exec` / `pty` / `files` / `exitCode` ✓ —— **不是板级那套** ✓）
    transports: [...transports].sort(),
    // **工作台自己的能力位** ✓（封闭 ✓ —— **加值要改契约** ✓）
    features: ['cards', 'mcp', 'layout_share', 'record'],
  };
}

/** `list_tags` ✓ */
export function listTags(deps: McpHostDeps): Record<string, unknown>[] {
  const pack = deps.pack();
  const readings = deps.readings();
  return readings.map((reading) => {
    const vocab = vocabularyEntry(reading.tag);
    return {
      // **契约叫 `name`** ✓（宿主侧叫 `tag` ✓ —— **改名** ✓）
      name: reading.tag,
      // **核心词表里的类型** ✓ —— 没有词表条目是 `null` ✓
      type: vocab?.type ?? null,
      // **单位** ✓ —— 没有词表条目是 `'-'`（**不是 `null`** ✓ —— 无量纲 ✓）
      unit: vocab?.unit ?? '-',
      // **取值域** ✓ —— 二元数组或字符串 ✓ —— 没有词表条目是 `null` ✓
      range: vocab?.range ?? null,
      status: reading.status,
      value: reading.value,
      // **当前板型包的 id** ✓（**不是连接 id** ✓）
      board: pack?.id ?? null,
      // **哪个 reader 提供的** ✓ —— 匹配不上是 `null` ✓（不猜 ✓）
      source_reader: sourceReaderOf(reading.tag, pack),
    };
  });
}

/** 核心词表里匹配这个 tag 的那一条 ✓（**模式匹配** ✓） */
function vocabularyEntry(tag: string): (typeof CORE_VOCABULARY)[number] | undefined {
  return CORE_VOCABULARY.find((entry) => matchTagPattern(entry.pattern, tag));
}

/**
 * **这个 tag 是哪个 reader 提供的** ✓。
 *
 * → **含 `custom` 里的 reader** ✓（否则 `custom.*` 的量全都是 `null` ✓）
 * → **一个 tag 至多匹配一个 reader** ✓（板型包规则 2 保证 ✓ —— 不合规的包运行时根本不加载 ✓）
 * → **匹配不上是 `null`** ✓（不猜 ✓）
 */
function sourceReaderOf(tag: string, pack: PackView | null): string | null {
  if (pack === null) return null;
  for (const reader of pack.readers) {
    if (reader.provides.some((p) => matchTagPattern(p, tag))) return reader.id;
  }
  return null;
}

/** `describe_tag` ✓ */
export function describeTag(deps: McpHostDeps, name: string): Record<string, unknown> | null {
  const pack = deps.pack();
  const reading = deps.readings().find((r) => r.tag === name);
  const vocab = vocabularyEntry(name);
  const readerId = sourceReaderOf(name, pack);
  const reader = pack?.readers.find((r) => r.id === readerId) ?? null;
  return {
    name,
    type: vocab?.type ?? null,
    unit: vocab?.unit ?? '-',
    range: vocab?.range ?? null,
    // **词表原文** ✓（含 Markdown 强调标记 ✓ —— agent 按纯文本读 ✓）
    // → **没有词表条目（`custom.*` 的私有量）是 `null`** ✓
    semantics: vocab?.semantics ?? null,
    status: reading?.status ?? 'unavailable',
    value: reading?.value ?? null,
    board: pack?.id ?? null,
    source: {
      reader: reader?.id ?? null,
      kind: reader?.kind ?? null,
      // **脱敏后的参数** ✓ —— **命令与宿主路径已经挡住了** ✓（`tags/pack-view.ts` ✓）
      args_summary: reader?.args ?? {},
    },
    // **最近的样本** ✓ —— 与 `sample_tag` 同形 ✓
    history: deps.history(name, 64),
  };
}

/** `sample_tag` ✓ */
export function sampleTag(deps: McpHostDeps, name: string, n: number): TagSampleLike[] {
  return deps.history(name, n);
}

/* ══════════════════════════════════════════════════════════════════
   查已有卡片（契约 §2.2 ✓）
   ══════════════════════════════════════════════════════════════════ */

/** `list_cards` ✓ */
export function listCards(deps: McpHostDeps): Record<string, unknown>[] {
  return deps.cards().map((card: McpCardEntry) => ({
    // **卡片 id = 目录名** ✓（宿主侧一切按它索引 ✓）
    id: card.cardId,
    // **manifest 声明的 id** ✓（**可以与目录名不同** ✓ → 所以是两个字段 ✓）
    manifest_id: card.manifest.id,
    name: card.manifest.name,
    version: card.manifest.version,
    // **绝对路径** ✓（契约 §四 ✓）
    path: card.dir,
    // **目录的最后修改时刻** ✓ —— **不是「人点装上的时刻」** ✓
    installed_at: card.state.installed_at,
    status: card.state.status,
    degraded: card.state.degraded,
    missing_tags: card.state.missing_tags,
    unreadable_tags: card.state.unreadable_tags,
  }));
}

/** `get_card_runtime_log` ✓ */
export function getCardRuntimeLog(
  deps: McpHostDeps,
  cardId: string,
  since: number | undefined,
): Record<string, unknown>[] {
  const entries = deps.cardLog(cardId);
  return entries
    // **`since` 过滤在宿主侧做** ✓（契约 §2.3 ✓）
    .filter((e) => since === undefined || e.at >= since)
    .map((e) => ({ level: e.level, at: e.at, message: e.message, source: e.source }));
}

/* ══════════════════════════════════════════════════════════════════
   布局（契约 §2.5 ✓）
   ══════════════════════════════════════════════════════════════════ */

/** `get_layout` ✓ */
export function getLayout(deps: McpHostDeps): Record<string, unknown> {
  const state = deps.layout();
  return {
    cards: state.units.map((u) => ({
      // **契约叫 `card_id`** ✓（宿主侧叫 `cardId` ✓ —— **改名** ✓）
      card_id: u.cardId,
      // **补上连接 id** ✓ —— 布局的键是 `(card_id, connection_id)` ✓ —— **不补就丢信息** ✗
      connection_id: u.connectionId,
      x: u.x,
      y: u.y,
      w: u.w,
      h: u.h,
    })),
  };
}

/**
 * **布局归一**（契约 §2.5 ✓）✓ —— **越界的格子整条丢掉** ✓。
 *
 * | 项 | 规则 |
 * |---|---|
 * | `x` / `y` | 非负整数 ✓ |
 * | `w` | `1 ≤ w ≤ 12` ✓ |
 * | `h` | `h ≥ 1` ✓ |
 * | **重叠** | **不判** ✓（交给渲染器 ✓） |
 */
export function normalizeLayoutCards(
  cards: unknown,
): { cards: Array<{ card_id: string; connection_id: string | null; x: number; y: number; w: number; h: number }>; dropped: string[] } {
  const out: Array<{
    card_id: string;
    connection_id: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];
  const dropped: string[] = [];
  if (!Array.isArray(cards)) return { cards: out, dropped };
  for (const raw of cards) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const cardId = typeof r['card_id'] === 'string' ? r['card_id'] : null;
    const conn = r['connection_id'];
    const x = r['x'];
    const y = r['y'];
    const w = r['w'];
    const h = r['h'];
    if (cardId === null) continue;
    const ok =
      typeof x === 'number' &&
      Number.isInteger(x) &&
      x >= 0 &&
      typeof y === 'number' &&
      Number.isInteger(y) &&
      y >= 0 &&
      typeof w === 'number' &&
      Number.isInteger(w) &&
      w >= 1 &&
      w <= 12 &&
      typeof h === 'number' &&
      Number.isInteger(h) &&
      h >= 1;
    if (!ok) {
      // **越界的格子整条丢掉** ✓，**并在 `dropped[]` 里报它的 card_id** ✓
      dropped.push(cardId);
      continue;
    }
    out.push({
      card_id: cardId,
      connection_id: typeof conn === 'string' ? conn : null,
      x,
      y,
      w,
      h,
    });
  }
  return { cards: out, dropped };
}
