/**
 * **MCP 响应的共同约定**（契约 `spec/04` §四 ✓）。
 *
 * ── 为什么单独一个模块 ──
 *
 * → **每个响应都要带 `apiVersion`** ✓（契约 §四 ✓）——
 *   流程工具与读侧工具**都要用** ✓ → **一份实现** ✓（各抄一份迟早漂 ✓）。
 *
 * → **列表是每一项都带** ✓（不是只在顶层带一个 ✓）——
 *   契约原话：「`apiVersion` 字段在每个响应里都带上」✓。
 */

/** 契约版本（**响应里的 `apiVersion` 表示契约版本** ✓ —— 不是工具集自己的版本 ✓） */
export const API_VERSION = 'devboard/v1';

/** 给一个值补上 `apiVersion` ✓ */
export function withVersion<T>(value: T): T & { apiVersion: string } {
  return { apiVersion: API_VERSION, ...value };
}

/** 列表的每一项都补上 ✓ */
export function withVersionEach<T>(items: T[]): (T & { apiVersion: string })[] {
  return items.map((item) => ({ apiVersion: API_VERSION, ...item }));
}
