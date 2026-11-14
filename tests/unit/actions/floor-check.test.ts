import { describe, it, expect } from 'vitest';
import { checkFloor, checkFloorArgv } from '../../../src/main/actions/floor-check';
import { buildCommand } from '../../../src/main/actions/encoder';
import { dangerFloorEntries } from '../../../src/main/tags/floor';
import type { PackParam } from '../../../src/main/tags/schema';

/**
 * 危险地板的**运行时复查** —— 契约 `docs/spec/02-board-pack.md` §5.2.1。
 *
 * ── 为什么要在运行时再查一遍 ──
 *
 * 校验器查的是**命令模板**；运行时查的是**编码后的最终命令**。
 * 差别就是**参数值**：模板 `rm -rf {dir}` 干干净净，
 * 而 `dir` 的值是 `/` 时，最终命令就是 `rm -rf /`。
 *
 * → 危险动作**只在模板里查是不够的**（§5.3 说过这件事）。
 */
const DIR_SCHEMA: Record<string, PackParam> = { dir: { type: 'string', maxLength: 16 } };

describe('地板复查 · 参数值把命令变成危险命令', () => {
  it('模板不命中、参数值命中 → 运行时命中（这正是运行时复查存在的理由）', () => {
    const { command } = buildCommand('rm -rf {dir}', DIR_SCHEMA, { dir: '/' });
    const verdict = checkFloor(command);
    expect(verdict.matched).toBe(true);
    expect(verdict.verdict).toBe('destructive');
    expect(verdict.why).toBeTruthy();
  });

  it('同一个模板，参数无害 → 不命中', () => {
    const { command } = buildCommand('rm -rf {dir}', DIR_SCHEMA, { dir: '/tmp/x' });
    expect(checkFloor(command).matched).toBe(false);
  });
});

describe('地板复查 · 地板表每一条都有正例', () => {
  const cases: { command: string; expectHit: boolean }[] = [
    { command: 'reboot', expectHit: true },
    { command: 'shutdown -h now', expectHit: true },
    { command: 'poweroff', expectHit: true },
    { command: 'halt', expectHit: true },
    { command: 'flash_uboot', expectHit: true },
    { command: 'erase', expectHit: true },
    { command: 'burn', expectHit: true },
    { command: 'upgrade', expectHit: true },
    { command: 'mkfs.ext4 /dev/mmcblk0p1', expectHit: true },
    // 无害的日常命令——**不许**被误伤
    { command: 'lsmod', expectHit: false },
    { command: 'depmod -a', expectHit: false },
    { command: 'modprobe hello', expectHit: false },
    { command: 'cat /proc/meminfo', expectHit: false },
    { command: 'rm -rf /tmp/build', expectHit: false },
    { command: 'echo hello', expectHit: false },
  ];

  for (const c of cases) {
    it(`${c.command} → ${c.expectHit ? '命中' : '不命中'}`, () => {
      expect(checkFloor(c.command).matched).toBe(c.expectHit);
    });
  }

  it('地板表的每一条都至少有一个正例（表不许有洞）', () => {
    for (const entry of dangerFloorEntries()) {
      const sample = entry.pattern.endsWith('*')
        ? `${entry.pattern.slice(0, -1)}sample`
        : entry.pattern;
      expect(checkFloor(sample).matched, `地板条目「${entry.pattern}」没有正例`).toBe(true);
    }
  });
});

describe('地板复查 · 几条特别形态', () => {
  it('basename 也算（/usr/bin/reboot 与 reboot 同罪）', () => {
    expect(checkFloor('/usr/bin/reboot').matched).toBe(true);
    expect(checkFloor('/sbin/poweroff').matched).toBe(true);
  });

  it('rm -rf / 与 rm -rf /* 都命中（/* 展开后就是根下的全部）', () => {
    expect(checkFloor('rm -rf /').matched).toBe(true);
    expect(checkFloor('rm -rf /*').matched).toBe(true);
    expect(checkFloor('rm -rf /var/log').matched).toBe(false);
  });

  it('dd 写块设备命中', () => {
    expect(checkFloor('dd if=x.img of=/dev/mmcblk0').matched).toBe(true);
    expect(checkFloor('dd if=x.img of=/tmp/x.img').matched).toBe(false);
  });

  it('清防火墙命中', () => {
    expect(checkFloor('iptables -F').matched).toBe(true);
    expect(checkFloor('nft flush ruleset').matched).toBe(true);
  });
});

describe('地板复查 · 处置与告警', () => {
  it('命中 → 按 destructive 处理（必须走确认通道）', () => {
    expect(checkFloor('reboot').verdict).toBe('destructive');
  });

  it('不命中 → ok，但**要记一条 warning**（匹配不上不等于安全）', () => {
    const verdict = checkFloor('lsmod');
    expect(verdict.verdict).toBe('ok');
    expect(verdict.warning).toBeTruthy();
  });

  it('拿 argv 直接撞（不重新切词 —— 传进来的就是 shell 会看到的那些词）', () => {
    expect(checkFloorArgv(['rm', '-rf', '/']).matched).toBe(true);
    expect(checkFloorArgv(['lsmod']).matched).toBe(false);
  });
});
