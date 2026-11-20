import type { BoardPack, PollGroupDef, ReaderDef } from './schema';

/**
 * The redacted read-only projection of a board pack (contract `spec/04`
 * sections 2.1 / 2.4 ✓ · ADR-D40 ✓).
 *
 * ── What it solves ──
 *
 * `TagRuntime.pack` is private ✓ — and the read-side tools of MCP have to
 * see it ✓ (`list_data_sources` ✓ / `describe_tag` ✓ / `list_tags` ✓).
 *
 * → But the raw arguments must not be handed to an agent ✓:
 * the arguments of `exec_regex` carry a `command` ✓ (a bare command that
 * runs on the board ✓), the arguments of `script` carry a `path` (a path on
 * the host filesystem) and an `interpreter` ✓
 * → those two together are "what is on the host and where" plus "a
 *   command" ✗
 * → which is exactly what contract section 1.3 ("no bare send_command") is
 *   there to prevent ✓.
 *
 * ── The allow list is decided per `(kind, argument name)` ──
 *
 * Not decided by the argument name alone ✓ — because `path` is a path on
 * the board in `file_read` (it may be handed out ✓) and a path on the host
 * in `script` (it may not ✓).
 *
 * → Written out per kind ✓ (the table in contract v5 section 2.4 ✓)
 * → An argument that is not in the table is never handed out ✓ (a closed
 *   table ✓, not "hand it out and filter later" ✓).
 */

/** The redacted view of a reader */
export interface ReaderView {
  /** The id of the reader */
  id: string;
  /** The kind of the reader (`proc_stat` / `file_read` / …) */
  kind: string;
  /**
   * The redacted arguments — only the ones in the allow list.
   *
   * → The value is a string or plain JSON — `type_map` is an object (that
   *   is plain data, not sensitive) → it keeps its shape (an agent can read
   *   it); arrays and other objects are JSON-ified.
   */
  args: Record<string, string | Record<string, string>>;
  /** The tag patterns it provides (not the concrete names — the concrete names come from the readings) */
  provides: string[];
  /** The poll group it belongs to (`null` = no group — such a pack does not pass the validator) */
  poll_group: string | null;
  /** The period of the poll group it is in (`null` = no group) */
  interval_ms: number | null;
}

/** The redacted view of a board pack */
export interface PackView {
  id: string;
  name: string;
  version: string;
  /** The poll groups (a group = one round trip) */
  poll_groups: PollGroupDef[];
  /** Every reader (`readers` plus `custom`) */
  readers: ReaderView[];
  /** The list of the action ids (only the ids — the arguments and the command belong to the action definition) */
  actions: string[];
}

/**
 * The allow list — decided per `(kind, argument name)`.
 *
 * → A closed table — an argument that is not in the table is never handed
 *   out.
 * → Adding a kind or changing a table is a contract change (contract v5
 *   section 2.4).
 */
const ALLOWED_ARGS: Readonly<Record<string, readonly string[]>> = {
  proc_stat: ['stat_path', 'cpuinfo_path'],
  meminfo: ['path'],
  devfreq_load: ['path', 'measure'],
  rknpu_load: ['path'],
  thermal_zone: ['glob', 'type_map'],
  file_read: ['path', 'glob', 'format', 'strip_trailing_null'],
  exec_regex: ['pattern', 'format'],
  // `script` is always empty — its `path` is a path on the host, and `interpreter` belongs with it
  script: [],
};

/**
 * How one argument value becomes something a reader can make sense of.
 *
 * → A map of strings to strings like `type_map` keeps its shape (plain
 *   data, not sensitive, an agent can read it)
 * → Other objects and arrays are JSON-ified
 * → Scalars become strings
 */
function argValue(value: unknown): string | Record<string, string> {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isStringMap(value)) {
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) out[key] = String(item);
    return out;
  }
  return JSON.stringify(value);
}

/** Whether this is a map of strings to strings (like `type_map`) */
function isStringMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

/** The redacted arguments of one reader (only the ones in the allow list) */
function sanitizeArgs(reader: ReaderDef): Record<string, string | Record<string, string>> {
  const allowed = ALLOWED_ARGS[reader.kind];
  // This kind is not in the table → not one argument is handed out (do not guess)
  if (allowed === undefined) return {};
  const out: Record<string, string | Record<string, string>> = {};
  for (const name of allowed) {
    const value = reader.args?.[name];
    if (value === undefined) continue;
    out[name] = argValue(value);
  }
  return out;
}

/** The group a reader belongs to (rule 17: every reader belongs to exactly one group) */
function groupOf(pack: BoardPack, readerId: string): PollGroupDef | undefined {
  return pack.poll_groups.find((g) => g.readers.includes(readerId));
}

/**
 * Project a board pack into its redacted view.
 *
 * @param pack the board pack that is bound right now (`null` when there is
 *   none — do not guess)
 * @returns the redacted view; `null` when there is no pack
 */
export function packView(pack: BoardPack | undefined): PackView | null {
  if (pack === undefined) return null;

  const all: ReaderDef[] = [...pack.readers, ...pack.custom];
  const readers: ReaderView[] = all.map((reader) => {
    const group = groupOf(pack, reader.id);
    return {
      id: reader.id,
      kind: reader.kind,
      args: sanitizeArgs(reader),
      provides: reader.provides.map((p) => p.tag),
      poll_group: group?.id ?? null,
      interval_ms: group?.interval_ms ?? null,
    };
  });

  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    poll_groups: pack.poll_groups.map((g) => ({
      id: g.id,
      interval_ms: g.interval_ms,
      readers: [...g.readers],
    })),
    readers,
    actions: pack.actions.map((a) => a.id),
  };
}
