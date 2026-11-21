import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The prebuilt binaries are there** ✓ → **no compiler is needed** ✓.
 *
 * → `node-pty` and `@serialport/bindings-cpp` are **NAPI** modules ✓ (their
 *   export table holds `napi_register_module_v1` ✓ — NAPI is not bound to
 *   the ABI version of Node or of Electron ✓) → the prebuilt binaries that
 *   ship with them work across the versions ✓.
 * → So the postinstall **only compiles** when a prebuilt binary does not fit
 *   the machine ✓ — and the compiler (Python + the Visual Studio build
 *   tools ✓ — 1.6 GB ✓) is an **escape hatch** ✓, not a prerequisite ✓.
 * → That is what the README says ✓ → **and this is the criterion for it** ✓
 *   (a dependency that drops the prebuild ✓ would make the README wrong ✓
 *   without anything turning red ✗).
 */
const PLATFORM = `${process.platform}-${process.arch}`;

describe('the native modules · the prebuilt binaries', () => {
  it('**node-pty ships one for this platform** ✓', () => {
    const path = join(
      process.cwd(),
      'node_modules',
      'node-pty',
      'prebuilds',
      PLATFORM,
      'pty.node',
    );
    expect(
      existsSync(path),
      `node-pty has no prebuilt binary for ${PLATFORM} — without one the install has to compile it (and the compiler becomes a prerequisite)`,
    ).toBe(true);
  });

  it('**serialport ships one for this platform** ✓', () => {
    const dir = join(
      process.cwd(),
      'node_modules',
      '@serialport',
      'bindings-cpp',
      'prebuilds',
      PLATFORM,
    );
    expect(existsSync(dir), `serialport has no prebuilds for ${PLATFORM}`).toBe(true);
    const any = readdirSync(dir).find((file) => file.endsWith('.node'));
    expect(any, `serialport has no prebuilt binary for ${PLATFORM}`).toBeDefined();
  });
});
