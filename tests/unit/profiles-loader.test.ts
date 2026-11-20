import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfiles } from '../../src/main/profiles/loader';

let builtin: string, user: string;
beforeEach(() => {
  builtin = mkdtempSync(join(tmpdir(), 'builtin-'));
  user = mkdtempSync(join(tmpdir(), 'user-'));
});
afterEach(() => {
  rmSync(builtin, { recursive: true, force: true });
  rmSync(user, { recursive: true, force: true });
});

const prof = (id: string) => JSON.stringify({ id, label: id, transport: 'local', options: {} });

describe('loadProfiles', () => {
  it('the built-in and the user directory are merged, the user one wins with the same id', () => {
    writeFileSync(join(builtin, 'a.json'), prof('dup'));
    writeFileSync(join(user, 'a.json'), JSON.stringify({ id: 'dup', label: 'the one of the user', transport: 'local', options: {} }));
    writeFileSync(join(builtin, 'b.json'), prof('b'));
    const list = loadProfiles({ builtinDir: builtin, userDir: user });
    expect(list.map(p => p.id).sort()).toEqual(['b', 'dup']);
    expect(list.find(p => p.id === 'dup')!.label).toBe('the one of the user');
  });

  it('a broken file does not drag the other profiles down', () => {
    writeFileSync(join(builtin, 'ok.json'), prof('ok'));
    writeFileSync(join(builtin, 'bad.json'), '{ not json');
    expect(loadProfiles({ builtinDir: builtin }).map(p => p.id)).toEqual(['ok']);
  });
});
