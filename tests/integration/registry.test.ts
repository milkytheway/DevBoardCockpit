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

  it('profile 显式写的 pty 覆盖传输默认值 —— 能力位由 profile 决定', () => {
    // 能力位只有一份实现（`hal/capabilities`）。
    // 原来有两份，而 registry 那份**不看 profile 的 pty**——
    // 于是用户在 profile 里把 ssh 的 pty 改成 false 毫无效果，
    // 而两处算法还不一样（谁 import 错那份就出 bug）。
    const sshNoPty = { ...p('ssh'), options: { pty: false } };
    expect(capabilitiesFor(sshNoPty).pty).toBe(false);

    const serialNoPty = { ...p('serial'), options: { port: 'COM3', pty: false } };
    expect(capabilitiesFor(serialNoPty).pty).toBe(false);
  });
});

describe('capabilitiesFor 与真实 profile 一致', () => {
  it('仓库里的五个 profile 的能力位与传输相符', async () => {
    const { loadProfiles } = await import('../../src/main/profiles/loader');
    const list = loadProfiles({ builtinDir: 'profiles/targets' });
    expect(list.length).toBe(5);
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
