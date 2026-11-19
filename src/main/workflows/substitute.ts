import { quoteShellValue } from '../util/shell-quote';
import { placeholdersOf } from './format';

/**
 * 占位符的替换 —— 流程层的**注入防线**在哪儿。
 *
 * ── 两种模式，差别在「谁来填」 ──
 *
 * | 模式 | 用在哪 | 输入值 | 角色事实 | 槽里的路径 |
 * |---|---|---|---|---|
 * | **命令模式** | 步骤的命令、回读的二次验证命令 | **按类型编码过的**（整数不带引号、字符串单引号） | 原样 | **单引号包住** |
 * | **值模式** | 回读的 `expect` / `path` | 原样 | 原样 | 原样 |
 *
 * ── 为什么角色事实**也包引号** ──
 *
 * → 它来自**宿主的连接 profile**（半可信 ✓）—— 但「半可信」不等于「可信」：
 * 一个手写的 profile 里塞了 `; reboot` 的 host，那条命令就会带着它跑出去 ✗。
 * → **按类型编码的规矩：字符串包引号** ✓（数字类的 `port` 不包 ✓）。
 * → **代价** ✓：`scp` 会写成 `'root'@'192.168.5.100'` ✓
 * → **shell 剥引号后才拼词** ✓（POSIX 的词拼接 ✓）→ `scp` 收到的是 `root@192.168.5.100` ✓。
 *
 * ── 为什么输入值**要**包引号 ──
 *
 * 输入可能来自 **agent**（不可信）✗ ——`; reboot` 这种必须被当字面量 ✓。
 * → 走**编码器那套类型规则**（`spec/02` §4.6）✓ → 整数不带引号、字符串单引号 ✓。
 */

/** 一个角色的连接事实（**封闭**：`format.ts` 的 `ROLE_FACTS`） */
export interface RoleFacts {
  host: string;
  port: number;
  user: string;
  key?: string;
  profile_id: string;
}

export interface SubstitutionContext {
  /** 输入的**原始值**（值模式用；也是回读比较的对象） */
  inputs: Record<string, unknown>;
  /** 输入的**编码片段**（命令模式用；按类型编码过） */
  encoded: Record<string, string>;
  /** 角色的事实 */
  roleFacts: Record<string, RoleFacts>;
  /** 已产出的槽（路径） */
  outputs: Record<string, string>;
  /** 这一步自己的端点（只有 `file.transfer` 步有） */
  endpoints?: { from?: string; to?: string };
}

/** 命令模式：输入用编码片段、路径加引号、角色事实原样 */
export function substituteCommand(text: string, ctx: SubstitutionContext): string {
  let out = text;
  // ── 先把 `{input:x}` 换成编码片段 ──
  out = out.replace(/\{input:([^}]+)\}/g, (_match, name: string) => {
    const encoded = ctx.encoded[name];
    return encoded === undefined ? `{input:${name}}` : encoded;
  });
  // ── 槽里的路径与端点：单引号包住（路径可能有空格与分号）──
  out = out.replace(/\{output:([^}.]+)(\.name)?\}/g, (_match, slot: string, attr?: string) => {
    const value = ctx.outputs[slot];
    if (value === undefined) return `{output:${slot}}`;
    return attr === '.name' ? quoteShellValue(basenameWithoutExt(value), 'artefact name') : quoteShellValue(value, 'path');
  });
  out = out.replace(/\{(from|to)\.path\}/g, (_match, which: 'from' | 'to') => {
    const value = ctx.endpoints?.[which];
    return value === undefined ? `{${which}.path}` : quoteShellValue(value, 'path');
  });
  // ── 角色事实：**也要包引号** ──
  //
  // 它来自**宿主的连接 profile**（半可信 ✓）——但「半可信」不等于「可信」：
  // 一个手写的 profile 里塞了 `; reboot` 的 host，那条命令就会带着它跑出去 ✗。
  // → **按类型编码的规矩：字符串包引号** ✓（数字类的 `port` 不包 ✓）。
  out = out.replace(/\{role:([^}.]+)\.([^}]+)\}/g, (_match, role: string, fact: string) => {
    const facts = ctx.roleFacts[role];
    if (facts === undefined) return `{role:${role}.${fact}}`;
    const value = (facts as unknown as Record<string, unknown>)[fact];
    if (value === undefined) return `{role:${role}.${fact}}`;
    return typeof value === 'number' ? String(value) : quoteShellValue(String(value), 'connection fact');
  });
  return out;
}

/** 值模式：全部原样（回读的 `expect` / `path` 比的是**值**，不是 shell 片段） */
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

/** 文件名去掉扩展名（`hello.ko` → `hello`） */
export function basenameWithoutExt(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

/** 这段文本里用到了哪些占位符（诊断用） */
export function usedPlaceholders(text: string): ReturnType<typeof placeholdersOf> {
  return placeholdersOf(text);
}
