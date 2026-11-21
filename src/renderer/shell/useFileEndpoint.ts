import { useCallback, useEffect, useState } from 'react';
import type { FileEndpointInfo } from '../../shared/ipc-contract';

/**
 * **The link that carries the files** ✓.
 *
 * ── Why the page asks the host for it ──
 *
 * → **The file page does not need an open terminal** ✓ → it asks the host
 *   which link it should use ✓ → the host picks it ✓ (ADB → SSH → serial ✓
 *   · the previous one that is not there ✓ → the next one ✓).
 * → **The page never guesses** ✓ — it does not decide "adb is probably
 *   right" ✓ (that is the host's business ✓ — it knows which board is
 *   current ✓ and whether the credential works ✓).
 *
 * ── Why it is asked **only when the page is open** ✓ ──
 *
 * → The endpoint opens a **connection** ✓ → on the serial line that is
 *   exclusive ✗ → opening it at boot would fight the runtime for the port
 *   ✗ → the file page asks for it ✓ and the page is the one that wants it
 *   ✓.
 */
export function useFileEndpoint(
  /** Is the page open? (then the host is asked ✓) */
  enabled: boolean,
  /** The board that is current ✓ (`null` = none ✓) — the endpoint follows it ✓ */
  boardKey: string | null,
): {
  endpoint: FileEndpointInfo | null;
  busy: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [endpoint, setEndpoint] = useState<FileEndpointInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setEndpoint(null);
      setError(null);
      setBusy(false);
      return undefined;
    }
    const api = window.cockpit;
    if (!api) return undefined;
    let disposed = false;
    setBusy(true);
    setError(null);
    void api
      .filesEndpoint()
      .then((info) => {
        if (disposed) return;
        setEndpoint(info);
        setBusy(false);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        // → **The failure is the page's own business** ✓ (the host said why ✓)
        setEndpoint(null);
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      });
    return () => {
      disposed = true;
    };
    // → **The board changed** ✓ → the endpoint has to be asked again ✓ (the
    //   links of another board are not the links of this one ✓).
  }, [enabled, boardKey, nonce]);

  return { endpoint, busy, error, refresh };
}
