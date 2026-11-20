import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The **discovery file** (contract `spec/04` §7.2 ✓).
 *
 * ── What it is ──
 *
 * How does the agent learn the port and the token? **It reads this file** ✓.
 * → It is the **only coupling point** between the agent and the GUI ✓ (the
 *   words of the contract ✓).
 * → When the transport changes, the agent only has to change the way it reads
 *   the file ✓.
 *
 * ── Its fields (copied from contract §7.2 ✓) ──
 *
 * ```json
 * { "apiVersion": "devboard/v1", "transport": "http", "host": "127.0.0.1",
 *   "port": 51234, "pid": 12345, "token": "…", "cards_dir": "…", "started_at": "…" }
 * ```
 */

/** The content of the discovery file (**the fields are copied from the contract** ✓ — one field missing and the agent cannot connect ✓) */
export interface DiscoveryInfo {
  apiVersion: string;
  transport: 'http';
  host: string;
  port: number;
  pid: number;
  /** The bearer token generated for this start ✓ (**it changes on every restart** ✓) */
  token: string;
  /** The card directory (the agent writes its cards here ✓ — contract §3 ✓) */
  cards_dir: string;
  started_at: string;
}

/** The path of the discovery file in the **user data directory** (contract §7.2 ✓) */
export function discoveryFilePath(dataDir: string): string {
  return join(dataDir, 'mcp.json');
}

/**
 * **Writes the discovery file** ✓ — a temporary file first, then an **atomic
 * rename** ✓.
 *
 * → **Why it cannot be written directly** ✓: the agent may read it while it is
 *   being written ✓
 *   → it reads half a JSON ✓ → the parsing fails ✓ → **the agent does not
 *   retry** ✓ (the contract: when it cannot connect it **reports the error
 *   directly** ✓)
 *   → **one half-written file makes the agent believe the service is gone** ✗.
 * → **The rename is atomic** ✓ (within the same filesystem ✓) → the agent
 *   reads either the old one ✓ or the new one ✓, **never half of one** ✓.
 *
 * → **The mode 0600** ✓ (readable by the current user only ✓ — contract §7.2
 *   ✓).
 *   Windows has no POSIX mode ✓ → there the **ACL of the user data directory
 *   itself** takes care of it ✓ (only the current user can get into the user
 *   data directory anyway ✓).
 */
export function writeDiscoveryFile(path: string, info: DiscoveryInfo): void {
  const tmp = `${path}.tmp`;
  // **`mode: 0o600` is enough** ✓ (the permissions at the moment the file is **created** ✓ — the umask masks them once more ✓,
  // but 0600 & ~umask **is still 0600** ✓ — the umask can at most clear the two bits of "group / others" ✓,
  // and those two bits were 0 anyway ✓).
  // → **No chmod afterwards is needed** ✓ (that would be **dead code** ✓ — a line of code that looks like it does something is the best liar ✓).
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * **Deletes the discovery file** ✓ (when the GUI exits ✓ / also when the
 * listening fails ✓).
 *
 * → **A discovery file that points at a dead process must not be left
 *   behind** ✓ (contract §7.2 ✓):
 *   the agent reads it → it tries to connect → it cannot connect → **it does
 *   not try another port** ✓ (the contract ✓)
 *   → it reports the error directly ✓ → **the agent believes the GUI did not
 *   start** ✗ → while the GUI did start, only the port changed ✗.
 *
 * → **Deleting a file that does not exist does not blow up** ✓ (the exit
 *   sequence must not die because of it ✓).
 */
export function removeDiscoveryFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // **If it cannot be deleted, so be it** ✓ (the exit sequence must not break here ✓)
  }
}

/** Whether the discovery file is there (**for the diagnostics** ✓) */
export function discoveryExists(path: string): boolean {
  return existsSync(path);
}
