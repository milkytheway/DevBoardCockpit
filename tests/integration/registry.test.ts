import { describe, it, expect } from 'vitest';
import { capabilitiesFor } from '../../src/main/hal/registry';

const p = (transport: 'serial' | 'adb' | 'ssh' | 'local') => ({
  id: 'x', label: 'x', transport, options: transport === 'serial' ? { port: 'COM3' } : {},
});

describe('capabilitiesFor', () => {
  it('gives each transport its own capability bits', () => {
    expect(capabilitiesFor(p('serial')).files).toBe(false);
    expect(capabilitiesFor(p('serial')).exitCode).toBe(false);
    expect(capabilitiesFor(p('adb')).pty).toBe(false);
    expect(capabilitiesFor(p('ssh')).pty).toBe(true);
  });

  it('a pty written in the profile overrides the default of the transport — the profile decides the capability bits', () => {
    // There is only one implementation of the capability bits
    // (`hal/capabilities`).
    // There used to be two, and the one in the registry **did not look at the
    // pty of the profile** — so setting the pty of an ssh profile to false had
    // no effect at all, and the two algorithms were not even the same (whoever
    // imported the wrong one had a bug).
    const sshNoPty = { ...p('ssh'), options: { pty: false } };
    expect(capabilitiesFor(sshNoPty).pty).toBe(false);

    const serialNoPty = { ...p('serial'), options: { port: 'COM3', pty: false } };
    expect(capabilitiesFor(serialNoPty).pty).toBe(false);
  });
});

describe('capabilitiesFor agrees with the real profiles', () => {
  it('the capability bits of the five profiles of the repository match their transport', async () => {
    const { loadProfiles } = await import('../../src/main/profiles/loader');
    const list = loadProfiles({ builtinDir: 'profiles/targets' });
    expect(list.length).toBe(5);
    for (const profile of list) {
      const caps = capabilitiesFor(profile);
      if (profile.transport === 'serial') {
        expect(caps.files).toBe(false);   // A serial line carries no files (fact S7)
        expect(caps.exitCode).toBe(false); // A serial line has no exit code (fact S5)
      }
      if (profile.transport === 'adb') {
        expect(caps.pty).toBe(false);      // adb does not use a PTY (fact A1)
      }
    }
  });
});
