import { randomUUID } from 'node:crypto';
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
  /**
   * 这一行的 id（**追责单位**）。
   *
   * 契约 `spec/04` §2.4：动作的结果里带 `audit_id`——
   * 「发生了什么」与「谁让它发生的」要能互相指认。
   * （ADR-D31 R8：流程层的时间线每一阶段也引用这个 id。）
   */
  id?: string;
  /** 时刻（毫秒 UTC） */
  at: number;
  /** 谁触发的（卡片 id / agent / 用户） */
  actor: string;
  /** 板型包里的动作 id */
  actionId: string;
  /** 本次调用的参数（原始值） */
  params: Record<string, unknown>;
  /**
   * **最终命令**（编码之后的 ✓）。
   *
   * → 追责链的第一环：**「到底执行了什么」** ✓
   *   （只有动作 id 与参数，事后拼不出命令 ✓）。
   * → 流程层尤其需要它：**流程的命令是包给的** ✓（不是板型包里的动作 ✓）。
   */
  command?: string;
  /**
   * **这一步的输入值**（流程层用 ✓）。
   *
   * → 流程的参数在**流程包**里声明，不在**板型包**里 ✓
   *   → 不记的话，事后只看到「跑了某一步」，看不到「用了哪个工程」✗。
   */
  inputs?: Record<string, unknown>;
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
    ...(row.id === undefined ? [] : [`id=${row.id}`]),
    `actor=${row.actor}`,
    `action=${row.actionId}`,
    `params=${JSON.stringify(row.params)}`,
    `ok=${String(row.ok)}`,
    `verified=${String(row.verified)}`,
  ];
  if (row.command !== undefined) parts.push(`command=${JSON.stringify(row.command)}`);
  if (row.inputs !== undefined) parts.push(`inputs=${JSON.stringify(row.inputs)}`);
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
  /** 行号（同一份审计里的顺序） */
  private seq = 0;

  constructor(private readonly filePath: string) {}

  /**
   * 记一行，**返回这一行的 id**。
   *
   * → 结果里的 `audit_id` 就是它（契约 `spec/04` §2.4）。
   */
  append(row: AuditRow): string {
    this.seq += 1;
    // **id 不可预测**（评审 35 的 V2-M10 ✓）：
    // 时间戳 + 序号**能被猜到** ✗ → 而 audit_id 会被卡片/agent 拿到 ✓
    // → 猜到一个别人的 audit_id 就能**指着别人的记录说「这是他干的」** ✗。
    const id = row.id ?? `audit-${randomUUID().slice(0, 8)}`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${formatAuditRow({ ...row, id })}\n`, 'utf8');
    return id;
  }
}
