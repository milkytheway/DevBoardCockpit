import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadKit,
  loadKits,
  kitsForModel,
  installKit,
  parseKitManifest,
  placeholdersOf,
  type BoardKit,
} from '../../../src/main/kits/kit';

/**
 * The board kit (contract `docs/spec/06-board-kit.md` ✓).
 *
 * What these criteria guard:
 *
 * | Criterion | Why |
 * |---|---|
 * | the manifest's field list is closed | a field that is silently ignored is a field that was misspelled |
 * | a placeholder is exactly `${name}` | nothing else is recognised — never guessed |
 * | every placeholder is declared | an undeclared placeholder is an error, not a profile that cannot connect |
 * | a variable has a type | otherwise a number can turn into a string and be rejected only at run time |
 * | the substituted result is validated again | the profile schema checks the presence of a field but hardly its type |
 * | installing never overwrites | installing is "fill in what is missing" |
 * | zero or several matching kits → none is picked | never a guess |
 */

const MANIFEST = {
  apiVersion: 'devboard/v1',
  kind: 'BoardKit',
  id: 'DEMO-1',
  model: 'DEMO-1',
  match: 'substring',
  board_pack: 'demo-pack',
  device_key: 'demo-01',
  workflows: ['demo.run'],
  cards: ['demo-card'],
  variables: {
    port: { type: 'string', label: 'The serial port', required: true, default: 'COM3' },
    count: { type: 'integer', label: 'How many', required: true },
  },
};

describe('the board kit · the manifest', () => {
  it('an unknown field is an error ✓', () => {
    expect(() => parseKitManifest({ ...MANIFEST, extra: 1 }, 'kit.yaml')).toThrow(/unknown field/);
  });

  it('**apiVersion and kind are required** ✓ (the other three artefacts have both ✓)', () => {
    expect(() => parseKitManifest({ ...MANIFEST, apiVersion: 'devboard/v2' }, 'kit.yaml')).toThrow(
      /apiVersion/,
    );
    expect(() => parseKitManifest({ ...MANIFEST, kind: 'Kit' }, 'kit.yaml')).toThrow(/kind/);
  });

  it('a variable needs a type ✓ (otherwise a number can turn into a string ✓)', () => {
    expect(() =>
      parseKitManifest(
        { ...MANIFEST, variables: { port: { label: 'The port' } } },
        'kit.yaml',
      ),
    ).toThrow(/type/);
  });
});

describe('the board kit · the placeholders', () => {
  it('**only `${name}` is a placeholder** ✓', () => {
    expect(placeholdersOf('${port}')).toEqual(['port']);
    expect(placeholdersOf('${a} and ${b}')).toEqual(['a', 'b']);
    expect(placeholdersOf('$port')).toEqual([]);
    expect(placeholdersOf('{port}')).toEqual([]);
    expect(placeholdersOf('${a.b}')).toEqual([]);
  });
});

describe('the board kit · installing', () => {
  it('**the templates become profiles ✓ · the variables are replaced ✓**', () => {
    const kit = {
      ...parseKitManifest(MANIFEST, 'kit.yaml'),
      connections: [
        {
          id: 'demo-serial',
          profile: {
            id: 'demo-serial',
            label: 'Demo',
            transport: 'serial',
            board_pack: 'demo-pack',
            device_key: 'demo-01',
            options: { port: '${port}', baudrate: 1500000 },
          },
          placeholders: ['port'],
        },
      ],
    };
    const target = mkdtempSync(join(tmpdir(), 'cockpit-profiles-'));
    const result = installKit(kit, { port: 'COM7' }, target);
    expect(result.written).toEqual(['demo-serial']);
    const written = JSON.parse(readFileSync(join(target, 'demo-serial.json'), 'utf8')) as {
      options: { port: string };
    };
    expect(written.options.port).toBe('COM7');
  });

  it('**a profile that is already there is not overwritten** ✓', () => {
    const target = mkdtempSync(join(tmpdir(), 'cockpit-profiles-'));
    const kit = {
      ...parseKitManifest(MANIFEST, 'kit.yaml'),
      connections: [
        {
          id: 'demo-serial',
          profile: {
            id: 'demo-serial',
            label: 'Demo',
            transport: 'serial',
            board_pack: 'demo-pack',
            device_key: 'demo-01',
            options: { port: '${port}', baudrate: 1500000 },
          },
          placeholders: ['port'],
        },
      ],
    };
    installKit(kit, { port: 'COM7' }, target);
    const second = installKit(kit, { port: 'COM9' }, target);
    expect(second.written).toEqual([]);
    expect(second.kept).toEqual(['demo-serial']);
    const written = JSON.parse(readFileSync(join(target, 'demo-serial.json'), 'utf8')) as {
      options: { port: string };
    };
    expect(written.options.port).toBe('COM7');
  });

  it('**a variable with no value is reported ✓ — not guessed** ✓', () => {
    const kit = {
      ...parseKitManifest(MANIFEST, 'kit.yaml'),
      connections: [
        {
          id: 'demo-serial',
          profile: {
            id: 'demo-serial',
            label: 'Demo',
            transport: 'serial',
            board_pack: 'demo-pack',
            device_key: 'demo-01',
            options: { port: '${port}', baudrate: 1500000 },
          },
          placeholders: ['port'],
        },
      ],
    };
    const target = mkdtempSync(join(tmpdir(), 'cockpit-profiles-'));
    const result = installKit(kit, {}, target);
    // **"count" is required and has no default** ✓ → it is reported ✓
    expect(result.missing).toContain('count');
  });
});

describe('the board kit · finding the kit', () => {
  it('**zero or several matches → none is picked** ✓ (never a guess ✓)', () => {
    const kit = (id: string, model: string, match: 'exact' | 'substring'): BoardKit => ({
      id,
      model,
      match,
      board_pack: null,
      device_key: null,
      workflows: [],
      cards: [],
      variables: {},
      connections: [],
    });
    expect(kitsForModel([kit('a', 'ATK', 'exact'), kit('b', 'ATK', 'exact')], 'ATK')).toHaveLength(2);
    expect(kitsForModel([], 'ATK')).toHaveLength(0);
    expect(kitsForModel([kit('a', 'ATK', 'substring')], 'ATK Board')).toHaveLength(1);
  });
});

describe('the board kit · the one that ships', () => {
  it('**the shipped kit parses ✓ and its variables are declared** ✓', () => {
    const kit = loadKit('profiles/kits/ATK-DLRK3588');
    expect(kit.id).toBe('ATK-DLRK3588');
    expect(kit.board_pack).toBe('rk3588-atk');
    expect(Object.keys(kit.variables).sort()).toEqual(['adb_serial', 'board_host', 'serial_port']);
    expect(kit.connections.map((c) => c.id).sort()).toEqual([
      'board-adb',
      'board-serial',
      'board-ssh',
    ]);
  });

  it('**every kit in the directory loads ✓**', () => {
    const kits = loadKits('profiles/kits');
    expect(kits.length).toBeGreaterThan(0);
    for (const kit of kits) expect(existsSync(`profiles/kits/${kit.id}/kit.yaml`)).toBe(true);
  });
});
