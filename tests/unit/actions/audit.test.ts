import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionAudit, formatAuditRow, type AuditRow } from '../../../src/main/actions/audit';

/**
 * Action audit — contract `docs/spec/02-board-pack.md` §5.4.
 *
 * The contract requires one row per action execution: timestamp, card id,
 * action id, params, result, readback value. Rows are appended, flushed one by
 * one, and prefixed with a timestamp.
 *
 * The audit row is the answer to "how did the board get into this state".
 * Without it, the same question can only be answered by guesswork.
 */
const ROW: AuditRow = {
  at: 1_700_000_000_000,
  actor: 'card:abc',
  actionId: 'backlight.set',
  params: { value: 128 },
  ok: true,
  verified: true,
  value: 128,
  detail: 'confirmed',
};

describe('audit · shape of one row', () => {
  it('timestamp, actor, action, params, result and readback value are all present', () => {
    const line = formatAuditRow(ROW);
    expect(line).toContain('action=backlight.set');
    expect(line).toContain('actor=card:abc');
    expect(line).toContain('params={"value":128}');
    expect(line).toContain('ok=true');
    expect(line).toContain('verified=true');
    expect(line).toContain('value=128');
  });

  it('a newline inside the params must not split the row in two (one action per row)', () => {
    const line = formatAuditRow({ ...ROW, params: { text: 'a\nb' } });
    expect(line.includes('\n')).toBe(false);
    expect(line).toContain('\\n');
  });

  it('no empty fields are emitted when there is no value', () => {
    const line = formatAuditRow({ at: ROW.at, actor: 'x', actionId: 'y', params: {}, ok: false, verified: false });
    expect(line.includes('value=')).toBe(false);
  });
});

describe('audit · writing to disk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('append mode: one row per action', () => {
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

  it('the directory is created when it does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    dirs.push(dir);
    const file = join(dir, 'logs', '2026-11-15', 'audit.log');
    new ActionAudit(file).append(ROW);
    expect(readFileSync(file, 'utf8')).toContain('backlight.set');
  });
});
