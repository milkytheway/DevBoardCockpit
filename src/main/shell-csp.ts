/**
 * 外壳（`cockpit://app/`）的 CSP。
 *
 * ── 为什么单独一个文件 ──
 *
 * `main/index.ts` 引入 Electron，**单元测试进不去**。
 * 而外壳的 CSP 恰好是**「错了不报错、只是什么都不显示」**的那种——
 * 必须有一条能在单测里跑的判据。
 *
 * ── `frame-src` 为什么是 `cockpit:` ──
 *
 * | | scheme | host | origin |
 * |---|---|---|---|
 * | 外壳 | `cockpit:` | `app` | `cockpit://app` |
 * | 卡片 | `cockpit:` | `card` | `cockpit://card` |
 *
 * **两个不同的源**（host 不同）→ 外壳的 `'self'` **盖不住卡片**。
 * CSP 的 host-source 语法只认 http/https/ws/wss/ftp，
 * 所以只能用 **scheme 源** `cockpit:`。
 *
 * ── 踩过的坑（2026-11-14）──
 *
 * 设计基线 `docs/21` §4.7 把**卡片的** CSP 抄给了外壳，
 * 那份里有 `frame-src 'none'` → **生产模式下每张卡片都装不上**，
 * 而且症状只是「卡片区一片空白」，不报任何错。
 *
 * → 所以这张表**不许再从卡片那边抄**。
 */
export const SHELL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-src cockpit:";
