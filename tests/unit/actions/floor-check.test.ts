import { describe, it, expect } from 'vitest';
import { checkFloor, checkFloorArgv } from '../../../src/main/actions/floor-check';
import { buildCommand } from '../../../src/main/actions/encoder';
import { dangerFloorEntries } from '../../../src/main/tags/floor';
import type { PackParam } from '../../../src/main/tags/schema';

/**
 * Runtime re-check of the danger floor — contract `docs/spec/02-board-pack.md`
 * §5.2.1.
 *
 * Why the runtime checks again:
 *
 * The validator checks the command template; the runtime checks the final,
 * encoded command. The difference is the argument value: the template
 * `rm -rf {dir}` is harmless, but when `dir` is `/` the final command is
 * `rm -rf /`.
 *
 * Checking dangerous commands in the template alone is not enough (§5.3 makes
 * the same point).
 */
const DIR_SCHEMA: Record<string, PackParam> = { dir: { type: 'string', maxLength: 16 } };

describe('floor re-check · an argument value turns the command into a dangerous one', () => {
  it('the template does not match but the argument value does → it matches at runtime (this is exactly why the runtime re-check exists)', () => {
    const { command } = buildCommand('rm -rf {dir}', DIR_SCHEMA, { dir: '/' });
    const verdict = checkFloor(command);
    expect(verdict.matched).toBe(true);
    expect(verdict.verdict).toBe('destructive');
    expect(verdict.why).toBeTruthy();
  });

  it('the same template with a harmless argument → no match', () => {
    const { command } = buildCommand('rm -rf {dir}', DIR_SCHEMA, { dir: '/tmp/x' });
    expect(checkFloor(command).matched).toBe(false);
  });
});

describe('floor re-check · every entry of the floor table has a positive case', () => {
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
    // Harmless everyday commands — they must **not** be caught by it
    { command: 'lsmod', expectHit: false },
    { command: 'depmod -a', expectHit: false },
    { command: 'modprobe hello', expectHit: false },
    { command: 'cat /proc/meminfo', expectHit: false },
    { command: 'rm -rf /tmp/build', expectHit: false },
    { command: 'echo hello', expectHit: false },
  ];

  for (const c of cases) {
    it(`${c.command} → ${c.expectHit ? 'matches' : 'no match'}`, () => {
      expect(checkFloor(c.command).matched).toBe(c.expectHit);
    });
  }

  it('every entry of the floor table has at least one positive case (the table may not have holes)', () => {
    for (const entry of dangerFloorEntries()) {
      const sample = entry.pattern.endsWith('*')
        ? `${entry.pattern.slice(0, -1)}sample`
        : entry.pattern;
      expect(checkFloor(sample).matched, `the floor entry "${entry.pattern}" has no positive case`).toBe(true);
    }
  });
});

describe('floor re-check · a few special shapes', () => {
  it('the basename counts too (/usr/bin/reboot is as guilty as reboot)', () => {
    expect(checkFloor('/usr/bin/reboot').matched).toBe(true);
    expect(checkFloor('/sbin/poweroff').matched).toBe(true);
  });

  it('both rm -rf / and rm -rf /* match (/* expands to everything under the root)', () => {
    expect(checkFloor('rm -rf /').matched).toBe(true);
    expect(checkFloor('rm -rf /*').matched).toBe(true);
    expect(checkFloor('rm -rf /var/log').matched).toBe(false);
  });

  it('dd writing to a block device matches', () => {
    expect(checkFloor('dd if=x.img of=/dev/mmcblk0').matched).toBe(true);
    expect(checkFloor('dd if=x.img of=/tmp/x.img').matched).toBe(false);
  });

  it('clearing the firewall matches', () => {
    expect(checkFloor('iptables -F').matched).toBe(true);
    expect(checkFloor('nft flush ruleset').matched).toBe(true);
  });
});

describe('floor re-check · disposition and warning', () => {
  it('a match is handled as destructive (it has to take the confirmation path)', () => {
    expect(checkFloor('reboot').verdict).toBe('destructive');
  });

  it('no match → ok, but **a warning is recorded** (not matching is not the same as being safe)', () => {
    const verdict = checkFloor('lsmod');
    expect(verdict.verdict).toBe('ok');
    expect(verdict.warning).toBeTruthy();
  });

  it('the argv is matched as it stands (the words are not re-split — these are the words the shell will see)', () => {
    expect(checkFloorArgv(['rm', '-rf', '/']).matched).toBe(true);
    expect(checkFloorArgv(['lsmod']).matched).toBe(false);
  });
});
