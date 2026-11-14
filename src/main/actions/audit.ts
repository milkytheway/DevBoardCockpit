import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 动作审计 —— 契约 `docs/spec/02-board-pack.md` §5.4。
 *
 * > 「每次动作执行记一行：时间、卡片 id、动作 id、参数、结果、回读值。
 * > ……追加写、每行 flush、时间戳前缀。」
 *
 * ── 记的是「每一次尝试」，不只是执行成功的那些 ──
 *
 * 契约的最低要求是「每次执行一行」；这里**每一次尝试**都记一行
 * （含被拒的与等确认的）——
 * **「谁试了什么但没被允许」恰恰是最该留痕的那一类**。
 *
 * ── 行式文本，不是 JSON 文件 ──
 *
 * 与会话日志同一种形态（`logging/session-log.ts`）：
 * **能 grep、能 tail、能 cat**。一行一个动作，追加写、每行 flush。
 */
export interface AuditRow {
  /** 时刻（毫秒 UTC） */
  at: number;
  /** 谁触发的（卡片 id / agent / 用户） */
  actor: string;
  /** 板型包里的动作 id */
  actionId: string;
  /** 本次调用的参数（原始值） */
  params: Record<string, unknown>;
  /** 动作成功了吗 */
  ok: boolean;
  /** **确认**板子真的进入目标状态了吗 */
  verified: boolean;
  /** 回读到的值 */
  value?: unknown;
  /** 给人看的一句话 */
  detail?: string;
}

/** 时间戳前缀（ISO，去掉毫秒后的可读形态） */
function stamp(at: number): string {
  return new Date(at).toISOString();
}

/** 一行审计（行式文本，字段用空格隔开） */
export function formatAuditRow(row: AuditRow): string {
  const parts = [
    stamp(row.at),
    `actor=${row.actor}`,
    `action=${row.actionId}`,
    `params=${JSON.stringify(row.params)}`,
    `ok=${String(row.ok)}`,
    `verified=${String(row.verified)}`,
  ];
  if (row.value !== undefined) parts.push(`value=${JSON.stringify(row.value)}`);
  if (row.detail !== undefined) parts.push(`detail=${JSON.stringify(row.detail)}`);
  return parts.join(' ');
}

/**
 * 审计的落盘处。
 *
 * **追加写、每行 flush** —— 崩溃/断电不能丢掉已经发生的写入
 * （契约 §5.4 的理由与会话日志一样：事实 G4）。
 */
export class ActionAudit {
  constructor(private readonly filePath: string) {}

  /** 记一行 */
  append(row: AuditRow): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${formatAuditRow(row)}\n`, 'utf8');
  }
}
