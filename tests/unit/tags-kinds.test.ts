import { describe, it, expect } from 'vitest';
import { READER_KINDS, getKind, kindIds } from '../../src/main/tags/kinds';

/**
 * The registry of the reader kinds.
 *
 * Contract: `docs/spec/02-board-pack.md` §2.4 (the list of the built-in reader
 * kinds, v1).
 *
 * **This table is part of the contract** — its machine readable form is
 * provided by the implementation layer: every kind declares "which arguments
 * it takes", "which samples it produces" and "how to collect them from the
 * board". Without it, rule 6 (does the sample exist), 8 (is the argument name
 * misspelled) and 9 (is a mandatory argument missing) **cannot even be
 * discussed**.
 */

describe('the registry', () => {
  it('exactly 8 kinds, the ids match the list of contract §2.4', () => {
    expect(kindIds()).toEqual([
      'proc_stat',
      'meminfo',
      'devfreq_load',
      'rknpu_load',
      'thermal_zone',
      'file_read',
      'exec_regex',
      'script',
    ]);
  });

  it('every kind can be fetched by its id', () => {
    for (const id of kindIds()) {
      expect(getKind(id)).toBeDefined();
    }
  });

  it('a kind that cannot be fetched returns undefined (it throws no exception)', () => {
    expect(getKind('nosuchkind')).toBeUndefined();
  });
});

describe('the samples every kind produces (the table of contract §2.4)', () => {
  const expected: Record<string, string[]> = {
    proc_stat: ['usage', 'core.*.usage', 'core.*.cluster'],
    meminfo: ['total_bytes', 'available_bytes', 'used_bytes', 'usage'],
    devfreq_load: ['duty', 'freq_hz'],
    rknpu_load: ['usage', 'core.*.usage'],
    thermal_zone: ['zone.*'],
    file_read: ['value'],
    exec_regex: ['value'],
    script: ['value'],
  };

  for (const [id, samples] of Object.entries(expected)) {
    it(`${id} produces ${samples.join(' / ')}`, () => {
      expect(getKind(id)!.samples).toEqual(samples);
    });
  }

  it('the number of samples of script is not limited (the last paragraph of contract §3.3)', () => {
    // The samples of script come from the keys of the JSON, so they **cannot** be a fixed list.
    // The words of the contract: "`script` is the only kind whose number of sample names is not limited".
    expect(getKind('script')!.samples).toEqual(['value']);
    expect(getKind('script')!.unboundedSamples).toBe(true);
    for (const id of kindIds().filter((k) => k !== 'script')) {
      // The field is optional (not written means "no") — `?? false` treats "not written" and "written false"
      // as the same thing: **only script has an unlimited number of samples**.
      expect(getKind(id)!.unboundedSamples ?? false).toBe(false);
    }
  });
});

describe('the parameters of every kind (the table of contract §2.4)', () => {
  it('proc_stat takes stat_path and cpuinfo_path', () => {
    const kind = getKind('proc_stat')!;
    expect(Object.keys(kind.params).sort()).toEqual(['cpuinfo_path', 'stat_path']);
    expect(kind.params['stat_path'].required).toBe(true);
    expect(kind.params['cpuinfo_path'].required).toBe(true);
  });

  it('meminfo takes path', () => {
    const kind = getKind('meminfo')!;
    expect(Object.keys(kind.params)).toEqual(['path']);
    expect(kind.params['path'].required).toBe(true);
  });

  it('the measure of devfreq_load has a range of values and is **not mandatory in the schema**', () => {
    // The last paragraph of contract §2.4: "**`measure` is not optional**: a binding to `*.usage` without a declared
    // `measure` is reported by the validator. A silent default would deceive — "it did not say that it is a utilisation"
    // may not be taken for "it is a utilisation"."
    //
    // **But this enforcement is "context dependent"**: a reader that offers only `freq_hz` does not need it.
    // Therefore it is optional in the schema and enforced by **rule 4** when the binding is to `*.usage` —
    // if it were mandatory in the schema, "no measure declared" would be reported as rule 9 and
    // **rule 4 would never be reached** (two rules for one thing).
    const kind = getKind('devfreq_load')!;
    expect(kind.params['measure'].required ?? false).toBe(false);
    expect(kind.params['measure'].values).toEqual(['utilization', 'duty_cycle']);
  });

  it('rknpu_load takes path', () => {
    expect(Object.keys(getKind('rknpu_load')!.params)).toEqual(['path']);
  });

  it('thermal_zone takes glob and type_map', () => {
    const kind = getKind('thermal_zone')!;
    expect(Object.keys(kind.params).sort()).toEqual(['glob', 'type_map']);
    expect(kind.params['glob'].required).toBe(true);
    expect(kind.params['type_map'].required).toBe(true);
  });

  it('the path and the glob of file_read are **mutually exclusive**', () => {
    // Contract §2.4: `path`/`glob` — not one mandatory and one optional,
    // but "at least one of the two has to be given".
    const kind = getKind('file_read')!;
    expect(kind.params['path'].required).toBe(false);
    expect(kind.params['glob'].required).toBe(false);
    expect(kind.params['path'].oneOf).toEqual(['path', 'glob']);
  });

  it('exec_regex takes command and pattern', () => {
    const kind = getKind('exec_regex')!;
    expect(Object.keys(kind.params).sort()).toEqual(['command', 'format', 'pattern']);
    expect(kind.params['command'].required).toBe(true);
    expect(kind.params['pattern'].required).toBe(true);
  });

  it('script takes path and interpreter', () => {
    const kind = getKind('script')!;
    expect(Object.keys(kind.params).sort()).toEqual(['format', 'interpreter', 'path']);
    expect(kind.params['path'].required).toBe(true);
    expect(kind.params['interpreter'].required).toBe(true);
  });
});

describe('the data snippet', () => {
  it('the snippet of file_read holds the path', () => {
    const frag = getKind('file_read')!.fetch({ path: '/sys/class/backlight/backlight/brightness' });
    expect(frag).toContain('/sys/class/backlight/backlight/brightness');
  });

  it('the snippet of exec_regex holds the command', () => {
    const frag = getKind('exec_regex')!.fetch({ command: 'cat /proc/uptime', pattern: '^([0-9.]+)' });
    expect(frag).toContain('cat /proc/uptime');
  });

  it('the snippet of script holds the interpreter and the **remote** path', () => {
    // The pack states a path on the **host**; the script has to be pushed to the board first (contract §3.3).
    // Therefore the collection uses the remote path that the runtime gives.
    const frag = getKind('script')!.fetch({
      path: 'scripts/pipeline_status.sh',
      interpreter: '/bin/sh',
      remote_path: '/tmp/devboard-123/pipeline_status.sh',
    });
    expect(frag).toContain('/bin/sh');
    expect(frag).toContain('/tmp/devboard-123/pipeline_status.sh');
  });

  it('when script gives no remote path it falls back to the path of the host (better than doing nothing)', () => {
    const frag = getKind('script')!.fetch({
      path: 'scripts/pipeline_status.sh',
      interpreter: '/bin/sh',
    });
    expect(frag).toContain('scripts/pipeline_status.sh');
  });

  it('the snippets of meminfo / devfreq_load / rknpu_load hold their own paths', () => {
    expect(getKind('meminfo')!.fetch({ path: '/proc/meminfo' })).toContain('/proc/meminfo');
    expect(getKind('devfreq_load')!.fetch({ path: '/x/load', measure: 'utilization' })).toContain('/x/load');
    expect(getKind('rknpu_load')!.fetch({ path: '/y/load' })).toContain('/y/load');
  });

  it('the snippet of proc_stat holds **two** paths', () => {
    const frag = getKind('proc_stat')!.fetch({
      stat_path: '/proc/stat',
      cpuinfo_path: '/proc/cpuinfo',
    });
    expect(frag).toContain('/proc/stat');
    expect(frag).toContain('/proc/cpuinfo');
  });

  it('the snippet of thermal_zone holds the glob', () => {
    const frag = getKind('thermal_zone')!.fetch({
      glob: '/sys/class/thermal/thermal_zone*',
      type_map: { 'soc-thermal': 'soc' },
    });
    expect(frag).toContain('/sys/class/thermal/thermal_zone*');
  });

  it('the data snippet is **one line** (one round trip over a serial port can only carry one command, fact S6)', () => {
    const frags = [
      getKind('file_read')!.fetch({ path: '/x' }),
      getKind('meminfo')!.fetch({ path: '/proc/meminfo' }),
      getKind('devfreq_load')!.fetch({ path: '/x/load', measure: 'utilization' }),
      getKind('rknpu_load')!.fetch({ path: '/y/load' }),
      getKind('proc_stat')!.fetch({ stat_path: '/proc/stat', cpuinfo_path: '/proc/cpuinfo' }),
      getKind('thermal_zone')!.fetch({ glob: '/z*', type_map: {} }),
    ];
    for (const frag of frags) {
      expect(frag.includes('\n')).toBe(false);
    }
  });
});

describe('the kinds that need two samples', () => {
  it('only proc_stat needs two samples', () => {
    // Contract §2.4: `proc_stat` **needs two samples**, the first one is pending.
    expect(getKind('proc_stat')!.needsTwoSamples).toBe(true);
    for (const id of kindIds().filter((k) => k !== 'proc_stat')) {
      expect(getKind(id)!.needsTwoSamples ?? false).toBe(false);
    }
  });
});

describe('the registry itself', () => {
  it('the id of every kind matches the key of the registry', () => {
    for (const kind of READER_KINDS) {
      expect(kind.id).toBeTruthy();
    }
    expect(new Set(READER_KINDS.map((k) => k.id)).size).toBe(READER_KINDS.length);
  });
});
