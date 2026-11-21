import { AdbConnection, adbCapabilities } from './adb';
import { LocalConnection, localCapabilities } from './local';
import { SerialConnection, serialCapabilities } from './serial';
import { SshConnection, sshCapabilities } from './ssh';
import { capabilitiesFor } from './capabilities';
import { loadSettings, resolveAdbPath, settingsPath } from '../util/settings';
import type { ConnectionCapabilities, Connection } from './connection';
import type { HostKeyStore } from './host-keys';
import type { ConnectionProfile } from '../profiles/schema';
import type { SessionLog } from '../logging/session-log';

/**
 * Transport registry.
 *
 * This is where "adding a new board without touching the UI" lands in code:
 * the UI only knows `Connection` and `ConnectionCapabilities`, never the
 * transport name. Register a new transport and the UI does not change by a
 * single line.
 *
 * **There is exactly one implementation of the capability bits**
 * (`./capabilities`). There used to be a second one right here, and that one
 * **ignored the profile's `pty` field** — so the two algorithms disagreed:
 * setting the pty of ssh to false in a profile had no effect at all.
 * "One algorithm for the capability bits" follows the same principle as
 * "one source for the core vocabulary".
 *
 * **2026-11-13**: this sentence went from "convention" to "fact" — the
 * `xxxCapabilities()` in each HAL module used to keep its own copy of the
 * literals (the same table copied five times); they now all delegate to
 * `transportDefaults()`. And `Connection.capabilities()` now calls
 * `capabilitiesFor(this.profile)`, so it **no longer reports a "transport
 * constant"** — it shares its source with the UI's `connections:list` now.
 */

/** Compute the capability bits from a profile (the only implementation, see `./capabilities`) */
export { capabilitiesFor };

/**
 * Build a connection from a profile.
 *
 * ── The default for `adbPath` is **resolved here** ✓ ──
 *
 * Previously only the application passed `adbPath` ✓, the CLI did not ✗ →
 * it fell back to `'adb'` ✗ → **the host's adb is not on PATH** ✗ →
 * `spawn adb ENOENT` ✗ → the "flash onto the board" workflow **does not run
 * in the CLI** ✗ (**while it works fine in the application** ✗).
 * → **Two sources of truth** ✓ — this project has fallen into the very same
 * pit several times ✓.
 *
 * → **Whoever builds the connection resolves the adb path the same way** ✓
 * (`profiles/settings.json` → `hostTools.adb` → PATH → common locations ✓).
 * An explicitly passed `adbPath` still wins ✓ (the application knows where
 * its own app root is ✓).
 */
export function createConnection(
  profile: ConnectionProfile,
  log: SessionLog,
  opts: { adbPath?: string; hostKeys?: HostKeyStore } = {},
): Connection {
  const adbPath = opts.adbPath ?? resolveAdbPath(loadSettings(settingsPath()));
  switch (profile.transport) {
    case 'serial':
      return new SerialConnection(profile, log);
    case 'adb':
      return new AdbConnection(profile, log, { adbPath });
    case 'ssh':
      // → **The keys of the hosts** ✓ (trust on first use ✓ — the store
      //   lives in the host's own data directory ✓).
      return new SshConnection(profile, log, {
        ...(opts.hostKeys === undefined ? {} : { hostKeys: opts.hostKeys }),
      });
    case 'local':
      return new LocalConnection(profile, log);
  }
}

/** Capability defaults per transport. Re-exported so that callers do not need to know the implementation details */
export { serialCapabilities, adbCapabilities, sshCapabilities, localCapabilities };
export type { ConnectionCapabilities };
