/**
 * **Is anybody listening there?** ✓
 *
 * ── Why this exists ──
 *
 * → A connection profile carries an address ✓ → **an address that is
 *   written down proves nothing** ✓ (a stale one ✓ · a wrong segment ✓ · a
 *   NAT gateway ✓ — the address of the board in the old notes was
 *   `192.168.5.100` ✓ and the guest's was `192.168.100.10` ✓ and **the
 *   VMware gateway on that segment is `192.168.100.2`** ✓ — it looks like a
 *   plausible address ✓ and it is not a board ✓).
 * → **The only honest criterion is a connection** ✓ — the port has to
 *   answer ✓.
 *
 * → **A probe that fails is not an error** ✓ — it is an answer ✓ ("nobody
 *   is there" ✓) → the caller decides what to do with it ✓.
 */
import { createConnection } from 'node:net';

export interface ProbeResult {
  /** Did something answer? */
  ok: boolean;
  /** Why not (when it did not ✓) — the raw system message ✓ */
  error?: string;
  /** How long it took (milliseconds ✓) */
  durationMs: number;
}

/**
 * Try to open a TCP connection to `host:port` ✓.
 *
 * → **It answers one question**: is somebody listening there? ✓
 * → It says **nothing** about who ✓ (an SSH server on the other side would
 *   not answer a bare TCP probe with its banner ✓ — the connection is
 *   accepted by the kernel ✓ and then closed ✓ — that is enough ✓).
 * → **The timeout is short** ✓ — a probe that waits twenty seconds is a
 *   hang with extra steps ✓.
 */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      finish({ ok: true, durationMs: Date.now() - started });
    });
    socket.once('timeout', () => {
      socket.destroy();
      finish({ ok: false, error: 'timeout', durationMs: Date.now() - started });
    });
    socket.once('error', (err: Error) => {
      socket.destroy();
      finish({ ok: false, error: err.message, durationMs: Date.now() - started });
    });
  });
}

/** Probe several addresses in order ✓ → the first one that answers wins ✓ */
export async function probeTcpAll(
  candidates: readonly { host: string; port: number }[],
  timeoutMs = 1500,
): Promise<{ found: { host: string; port: number } | null; tried: { host: string; error: string }[] }> {
  const tried: { host: string; error: string }[] = [];
  for (const candidate of candidates) {
    const result = await probeTcp(candidate.host, candidate.port, timeoutMs);
    if (result.ok) return { found: { host: candidate.host, port: candidate.port }, tried };
    tried.push({ host: candidate.host, error: result.error ?? 'no answer' });
  }
  return { found: null, tried };
}
