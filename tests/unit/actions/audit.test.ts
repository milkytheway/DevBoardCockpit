import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionAudit, formatAuditRow, type AuditRow } from '../../../src/main/actions/audit';

/**
 * 动作审计 —— 契约 `docs/spec/02-board-pack.md` §5.4。
 *
 * > 「每次动作执行记一行：时间、卡片 id、动作 id、参数、结果、回读值。
 * > ……追加写、每行 flush、时间戳前缀。」
 *
 * **它是「板子怎么变成这样的」的答案**——
 * 没有它，一次「板子怎么变成这样的」就只能靠猜。
 */
const ROW: AuditRow = {
  at: 1_700_000_000_000,
  actor: 'card:abc',
  actionId: 'backlight.set',
  params: { value: 128 },
  ok: true,
  verified: true,
  value: 128,
  detail: '已确认',
};

describe('审计 · 一行的形状', () => {
  it('时间、actor、动作、参数、结果、回读值都在', () => {
    const line = formatAuditRow(ROW);
    expect(line).toContain('action=backlight.set');
    expect(line).toContain('actor=card:abc');
    expect(line).toContain('params={"value":128}');
    expect(line).toContain('ok=true');
    expect(line).toContain('verified=true');
    expect(line).toContain('value=128');
  });

  it('**参数里的换行不能撑成两行**（一行一个动作）', () => {
    const line = formatAuditRow({ ...ROW, params: { text: 'a\nb' } });
    expect(line.includes('\n')).toBe(false);
    expect(line).toContain('\\n');
  });

  it('没值的时候不留空字段', () => {
    const line = formatAuditRow({ at: ROW.at, actor: 'x', actionId: 'y', params: {}, ok: false, verified: false });
    expect(line.includes('value=')).toBe(false);
  });
});

describe('审计 · 落盘', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('追加写：每次一行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    dirs.push(dir);
    const file = join(dir, 'audit.log');
    const audit = new ActionAudit(file);
    audit.append(ROW);
    audit.append({ ...ROW, actionId: 'second' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('action=backlight.set');
    expect(lines[1]).toContain('action=second');
  });

  it('目录不存在时会建出来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    dirs.push(dir);
    const file = join(dir, 'logs', '2026-11-15', 'audit.log');
    new ActionAudit(file).append(ROW);
    expect(readFileSync(file, 'utf8')).toContain('backlight.set');
  });
});
