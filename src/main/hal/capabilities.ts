import type { ConnectionCapabilities } from '../../shared/ipc-contract';
import type { ConnectionProfile } from '../profiles/schema';

/**
 * Capability bits are decided by the **profile**, not by the transport name.
 *
 * The old project paid for this: terminal mode (pty/pipe) used to be inferred
 * from the transport name, so a newly registered transport was treated as a
 * real terminal — the architecture notes of the old project record that
 * mistake.
 *
 * The **defaults** per transport:
 * - `serial`: a serial console is a real terminal (it echoes by itself, it
 *   prints its own prompt) — default true
 * - `adb`: `adb shell` has no PTY; `adb shell -t -t` lags by one reply on
 *   Windows (Fact A1) — default false
 * - `ssh`: the remote side provides a real terminal — default true
 * - `local`: a local pty — default true
 *
 * A profile may set `pty` explicitly to override the default (the schema
 * allows this field on every transport). But `pty: true` on `adb` is rejected
 * by the schema — Fact A1 admits no exception.
 */

/** Capability defaults per transport. `files` and `exitCode` are decided by the transport; `pty` can be overridden by the profile. */
const TRANSPORT_DEFAULTS: Record<
  ConnectionProfile['transport'],
  { exec: boolean; files: boolean; exitCode: boolean; pty: boolean }
> = {
  // Serial cannot carry files (Fact S7); serial cannot obtain an exit status (Fact S5)
  serial: { exec: true, files: false, exitCode: false, pty: true },
  // adb can carry files and returns an exit code; it uses no PTY (Fact A1)
  adb: { exec: true, files: true, exitCode: true, pty: false },
  ssh: { exec: true, files: true, exitCode: true, pty: true },
  local: { exec: true, files: true, exitCode: true, pty: true },
};

/**
 * The **default** capability bits of a transport (**ignoring the profile**).
 *
 * **This table is the single source of truth for the capability bits.**
 * Each HAL module (adb/local/serial/ssh) used to **keep its own copy of the
 * literals**, so the same thing could be changed in two places — change one
 * and not the other and the two disagree. Now the `xxxCapabilities()` of
 * those modules all delegate here.
 *
 * **It is not "the capability bits of this connection"** — that is
 * `capabilitiesFor(profile)`, which looks at the profile's `options.pty`.
 */
export function transportDefaults(
  transport: ConnectionProfile['transport'],
): ConnectionCapabilities {
  const d = TRANSPORT_DEFAULTS[transport];
  return { exec: d.exec, files: d.files, exitCode: d.exitCode, pty: d.pty };
}

/**
 * Compute the capability bits of a profile.
 *
 * **This is the only implementation of "the capability bits of a
 * connection"** — both the degradation checks of the UI and the mode
 * selection of the runtime call it; no second algorithm is allowed.
 */
export function capabilitiesFor(profile: ConnectionProfile): ConnectionCapabilities {
  const defaults = transportDefaults(profile.transport);
  const explicit = profile.options['pty'];
  return {
    ...defaults,
    pty: typeof explicit === 'boolean' ? explicit : defaults.pty,
  };
}
