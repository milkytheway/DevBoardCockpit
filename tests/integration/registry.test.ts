import { describe, it, expect } from 'vitest';
import { capabilitiesFor } from '../../src/main/hal/registry';

const p = (transport: 'serial' | 'adb' | 'ssh' | 'local') => ({
  id: 'x', label: 'x', transport, options: transport === 'serial' ? { port: 'COM3' } : {},
});

describe('capabilitiesFor', () => {
  it('按传输给出各自的能力位', () => {
    expect(capabilitiesFor(p('serial')).files).toBe(false);
    expect(capabilitiesFor(p('serial')).exitCode).toBe(false);
    expect(capabilitiesFor(p('adb')).pty).toBe(false);
    expect(capabilitiesFor(p('ssh')).pty).toBe(true);
  });
});

describe('capabilitiesFor 与真实 profile 一致', () => {
  it('仓库里的四个 profile 的能力位与传输相符', async () => {
    const { loadProfiles } = await import('../../src/main/profiles/loader');
    const list = loadProfiles({ builtinDir: 'profiles/targets' });
    expect(list.length).toBe(4);
    for (const profile of list) {
      const caps = capabilitiesFor(profile);
      if (profile.transport === 'serial') {
        expect(caps.files).toBe(false);   // 串口传不了文件（事实 S7）
        expect(caps.exitCode).toBe(false); // 串口没有退出码（事实 S5）
      }
      if (profile.transport === 'adb') {
        expect(caps.pty).toBe(false);      // adb 不用 PTY（事实 A1）
      }
    }
  });
});
