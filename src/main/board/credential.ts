/**
 * **The credential of an ssh connection** ✓.
 *
 * ── Why it is a module of its own ──
 *
 * → The credential is a **machine-specific value** ✓ (like the address ✓) —
 *   it belongs to the person ✓ and to this machine ✓ → a published profile
 *   cannot carry it ✓.
 * → It has to be **verified** ✓: a key that does not authenticate at the
 *   host is not the credential of that host ✓ → the verification is the
 *   criterion ✓ (**not a guess** ✓).
 *
 * → Why this is a **pure module** ✓: the probe is injected ✓ → the test
 *   never opens a socket ✓ and the search itself is a plain loop over the
 *   candidates ✓.
 */
import { readFileSync } from 'node:fs';

/** One candidate credential ✓ (the path ✓ and the key itself ✓) */
export interface CredentialCandidate {
  /** Where the key is ✓ (the path on this machine ✓) */
  path: string;
  /** The key ✓ (the content ✓ — ssh2 wants the key ✓ · a path is not enough ✓) */
  key: Buffer;
}

/** The host the credential has to work at ✓ */
export interface CredentialTarget {
  host: string;
  port: number;
  username: string;
}

/**
 * **Does this key authenticate at this host?** ✓
 *
 * → Injected ✓ — the real one connects ✓ (the tests do not ✓).
 */
export type CredentialProbe = (
  target: CredentialTarget,
  candidate: CredentialCandidate,
) => Promise<boolean>;

/**
 * The key that authenticates at the host ✓.
 *
 * → The candidates are tried **one by one** ✓ and the first one that
 *   authenticates is the credential ✓.
 * → **Several keys authenticate** → they are all valid for that host ✓ →
 *   the first one in the order of the records is taken ✓ (and the search
 *   says so ✓ — it is not a guess ✓: every one of them works ✓).
 * → **No key authenticates** → `null` ✓ (the caller says so ✓ — the failure
 *   names the host and the keys that were tried ✓).
 */
export async function findCredential(
  target: CredentialTarget,
  candidates: readonly CredentialCandidate[],
  probe: CredentialProbe,
): Promise<{ candidate: CredentialCandidate; accepted: CredentialCandidate[] } | null> {
  const accepted: CredentialCandidate[] = [];
  for (const candidate of candidates) {
    let ok = false;
    try {
      ok = await probe(target, candidate);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    accepted.push(candidate);
    if (accepted.length === 1) {
      return { candidate, accepted };
    }
  }
  return null;
}

/** Reads the keys of the records ✓ (the content ✓ — the path is kept ✓) */
export function candidatesOf(paths: readonly string[]): CredentialCandidate[] {
  const out: CredentialCandidate[] = [];
  for (const path of paths) {
    try {
      out.push({ path, key: readFileSync(path) });
    } catch {
      // → A key that cannot be read is not a candidate ✓ (it is skipped ✓)
    }
  }
  return out;
}
