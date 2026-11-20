import { quoteShellValue } from '../util/shell-quote';
import { placeholdersOf } from './format';

/**
 * The substitution of the placeholders — where the injection line of defence
 * of the workflow layer is.
 *
 * ── Two modes, the difference is "who fills it in" ──
 *
 * | Mode | Where it is used | The input value | The role facts | The path in a slot |
 * |---|---|---|---|---|
 * | Command mode | the command of a step, the second verification command of a readback | encoded by type (an integer without quotes, a string in single quotes) | as they are | wrapped in single quotes |
 * | Value mode | the `expect` / `path` of a readback | as they are | as they are | as they are |
 *
 * ── Why the role facts are quoted as well ──
 *
 * → They come from the connection profile of the host (half trusted ✓)
 *   — but "half trusted" is not "trusted": a hand-written profile with a
 *   host of `; reboot` would carry that into the command ✗.
 * → The rule of the encoding by type: a string is quoted ✓ (a numeric
 *   `port` is not quoted ✓).
 * → The cost ✓: `scp` comes out as `'root'@'192.168.5.100'` ✓
 * → the shell strips the quotes before it glues the words together ✓
 *   (the POSIX word concatenation ✓) → `scp` receives
 *   `root@192.168.5.100` ✓.
 *
 * ── Why the input values are quoted ──
 *
 * The input may come from an agent (untrusted) ✗ — something like
 * `; reboot` has to be treated as a literal ✓.
 * → It follows the type rules of the encoder (`spec/02` section 4.6) ✓ → an
 *   integer without quotes, a string in single quotes ✓.
 */

/** The connection facts of one role (closed: the `ROLE_FACTS` of `format.ts`) */
export interface RoleFacts {
  host: string;
  port: number;
  user: string;
  key?: string;
  profile_id: string;
}

export interface SubstitutionContext {
  /** The raw value of the inputs (used by the value mode; also the object of the readback comparison) */
  inputs: Record<string, unknown>;
  /** The encoded fragment of the inputs (used by the command mode; encoded by type) */
  encoded: Record<string, string>;
  /** The facts of the roles */
  roleFacts: Record<string, RoleFacts>;
  /** The slots that have been produced (paths) */
  outputs: Record<string, string>;
  /** The endpoints of this step (only a `file.transfer` step has them) */
  endpoints?: { from?: string; to?: string };
}

/** Command mode: the input uses the encoded fragment, the path is quoted, the role facts are as they are */
export function substituteCommand(text: string, ctx: SubstitutionContext): string {
  let out = text;
  // ── First replace `{input:x}` with the encoded fragment ──
  out = out.replace(/\{input:([^}]+)\}/g, (_match, name: string) => {
    const encoded = ctx.encoded[name];
    return encoded === undefined ? `{input:${name}}` : encoded;
  });
  // ── The path in a slot and the endpoints: wrapped in single quotes (a path may hold spaces and semicolons) ──
  out = out.replace(/\{output:([^}.]+)(\.name)?\}/g, (_match, slot: string, attr?: string) => {
    const value = ctx.outputs[slot];
    if (value === undefined) return `{output:${slot}}`;
    return attr === '.name' ? quoteShellValue(basenameWithoutExt(value), 'artefact name') : quoteShellValue(value, 'path');
  });
  out = out.replace(/\{(from|to)\.path\}/g, (_match, which: 'from' | 'to') => {
    const value = ctx.endpoints?.[which];
    return value === undefined ? `{${which}.path}` : quoteShellValue(value, 'path');
  });
  // ── The role facts: they are quoted as well ──
  //
  // They come from the connection profile of the host (half trusted ✓)
  // — but "half trusted" is not "trusted": a hand-written profile with a
  // host of `; reboot` would carry that into the command ✗.
  // → The rule of the encoding by type: a string is quoted ✓ (a numeric
  //   `port` is not quoted ✓).
  out = out.replace(/\{role:([^}.]+)\.([^}]+)\}/g, (_match, role: string, fact: string) => {
    const facts = ctx.roleFacts[role];
    if (facts === undefined) return `{role:${role}.${fact}}`;
    const value = (facts as unknown as Record<string, unknown>)[fact];
    if (value === undefined) return `{role:${role}.${fact}}`;
    return typeof value === 'number' ? String(value) : quoteShellValue(String(value), 'connection fact');
  });
  return out;
}

/** Value mode: everything as it is (the `expect` / `path` of a readback compare values, not shell fragments) */
export function substituteValue(text: string, ctx: SubstitutionContext): string {
  let out = text;
  out = out.replace(/\{input:([^}]+)\}/g, (_match, name: string) => {
    const value = ctx.inputs[name];
    return value === undefined ? `{input:${name}}` : String(value);
  });
  out = out.replace(/\{output:([^}.]+)(\.name)?\}/g, (_match, slot: string, attr?: string) => {
    const value = ctx.outputs[slot];
    if (value === undefined) return `{output:${slot}}`;
    return attr === '.name' ? basenameWithoutExt(value) : value;
  });
  out = out.replace(/\{(from|to)\.path\}/g, (_match, which: 'from' | 'to') => {
    const value = ctx.endpoints?.[which];
    return value === undefined ? `{${which}.path}` : value;
  });
  out = out.replace(/\{role:([^}.]+)\.([^}]+)\}/g, (_match, role: string, fact: string) => {
    const facts = ctx.roleFacts[role];
    if (facts === undefined) return `{role:${role}.${fact}}`;
    const value = (facts as unknown as Record<string, unknown>)[fact];
    return value === undefined ? `{role:${role}.${fact}}` : String(value);
  });
  return out;
}

/** The file name without the extension (`hello.ko` → `hello`) */
export function basenameWithoutExt(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

/** Which placeholders this text uses (for the diagnostics) */
export function usedPlaceholders(text: string): ReturnType<typeof placeholdersOf> {
  return placeholdersOf(text);
}
