import { describe, it, expect } from 'vitest';
import {
  findCredential,
  type CredentialCandidate,
  type CredentialTarget,
} from '../../../src/main/board/credential';

/**
 * **The credential of an ssh connection** ✓.
 *
 * | Criterion | Why |
 * |---|---|
 * | the key that authenticates is found | a key that does not authenticate is not the credential ✓ |
 * | no key → nothing is found | the caller has to say so ✓ — never invented ✓ |
 * | a key that throws is not a credential | one broken key must not hide the others ✓ |
 * | the candidates are tried one by one | the search stops at the first one that works ✓ |
 */
const TARGET: CredentialTarget = { host: '192.168.5.100', port: 22, username: 'root' };

function candidate(name: string): CredentialCandidate {
  return { path: `C:\\keys\\${name}`, key: Buffer.from(name) };
}

/** A probe that accepts exactly the named candidates */
function probeOf(accepted: readonly string[]) {
  const tried: string[] = [];
  const probe = async (
    _target: CredentialTarget,
    cand: CredentialCandidate,
  ): Promise<boolean> => {
    tried.push(cand.path);
    return accepted.includes(cand.path);
  };
  return { probe, tried };
}

describe('the credential · the search', () => {
  it('**the key that authenticates is found** ✓', async () => {
    const board = candidate('board');
    const { probe } = probeOf([board.path]);
    const found = await findCredential(TARGET, [candidate('wrong'), board], probe);
    expect(found?.candidate.path).toBe(board.path);
  });

  it('**no key authenticates → nothing is found** ✓ (the caller says so ✓)', async () => {
    const { probe } = probeOf([]);
    expect(await findCredential(TARGET, [candidate('a'), candidate('b')], probe)).toBeNull();
  });

  it('**a key that throws is not a credential** ✓ (the others are still tried ✓)', async () => {
    const good = candidate('good');
    const probe = async (
      _target: CredentialTarget,
      cand: CredentialCandidate,
    ): Promise<boolean> => {
      if (cand.path.endsWith('bad')) throw new Error('the key is not a key');
      return cand.path === good.path;
    };
    const found = await findCredential(TARGET, [candidate('bad'), good], probe);
    expect(found?.candidate.path).toBe(good.path);
  });

  it('**the candidates are tried one by one and the search stops at the first one that works** ✓', async () => {
    const board = candidate('board');
    const { probe, tried } = probeOf([board.path]);
    await findCredential(TARGET, [candidate('a'), board, candidate('c')], probe);
    expect(tried).toEqual(['C:\\keys\\a', 'C:\\keys\\board']);
  });
});
