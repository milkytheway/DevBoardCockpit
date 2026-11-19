import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadBoardPack } from '../../src/main/tags/pack';
import { validatePack, errorsOf } from '../../src/main/tags/validator';
import { instantiatePack, type ProbeOutcome } from '../../src/main/wizard/instantiate';
import { installInstantiatedPack, packToYamlShape } from '../../src/main/wizard/install';

/**
 * **落盘** —— 实例化出来的包要**真的能被读回来** ✓ —— 2026-11-19 加 ✓。
 *
 * ── 为什么这条要测 ──
 *
 * → **「落盘」是 I/O ✓ → **最容易出「写出来的东西读不回来」的错** ✓
 *   （**YAML 的形状对不对** ✓ · **字段名对不对** ✓ · **封闭 schema 有没有多写** ✓）。
 * → 而**读不回来的包 = 落地即废** ⚠️ → **向导白做** ⚠️。
 */
const REPO_ROOT = resolve(process.cwd());
const GENERIC_DIR = join(REPO_ROOT, 'profiles', 'boards', 'generic-linux');

function outcome(readerId: string, ok: boolean): ProbeOutcome {
  return { readerId, ok, detail: ok ? '' : '读不到', tags: [] };
}

const ALL_GREEN: ProbeOutcome[] = [
  'cpu', 'mem', 'loadavg1', 'loadavg5', 'loadavg15', 'model', 'osrelease',
  'kernel', 'uptime', 'thermal', 'backlight', 'led', 'net',
].map((id) => outcome(id, true));

function instance(targetId = 'atk-01') {
  return instantiatePack({
    source: loadBoardPack(GENERIC_DIR),
    targetId,
    targetName: '我的板子',
    outcomes: ALL_GREEN,
  });
}

describe('落盘 · **写出来的东西要读得回来** ✓', () => {
  it('**落盘的包能被加载器读回来** ✓（**落地即废 = 向导白做** ⚠️）', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-'));
    try {
      const { pack, provenance } = instance();
      installInstantiatedPack({ pack, provenance, boardsRoot: root });
      const back = loadBoardPack(join(root, 'atk-01'));
      expect(back.id).toBe('atk-01');
      expect(back.readers.length).toBe(pack.readers.length);
      expect(
        errorsOf(validatePack(back)).map((e) => `规则 ${e.rule} · ${e.path}：${e.message}`),
        '**读回来的包必须仍然过校验** ✓ —— 否则运行时读它就报「包坏了」⚠️',
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**`provenance.json` 也落下来了** ✓（**「猜的」必须留痕** ✓）', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-'));
    try {
      const { pack, provenance } = instance();
      installInstantiatedPack({ pack, provenance, boardsRoot: root });
      const raw = readFileSync(join(root, 'atk-01', 'provenance.json'), 'utf8');
      const parsed = JSON.parse(raw) as typeof provenance;
      expect(parsed.source).toBe('generic-linux');
      expect(parsed.targetId).toBe('atk-01');
      expect(parsed.guessed.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('**yaml 里不多写字段** ✓（**封闭 schema 拒收未知字段** ✓ —— 规则 10 ✓）', () => {
    const shape = packToYamlShape(instance().pack);
    expect(Object.keys(shape).sort()).toEqual([
      'actions',
      'apiVersion',
      'custom',
      'danger_floor_version',
      'description',
      'id',
      'kind',
      'name',
      'poll_groups',
      'readers',
      'requires',
      'version',
    ]);
  });

  it('**yaml 里没有 `match`** ✓（**不参与自动识别** ✓ —— 型号要人来定 ✓）', () => {
    const shape = packToYamlShape(instance().pack);
    expect(shape['match'], '写了 match 就会跟别的包抢这块板 ⚠️').toBeUndefined();
  });

  it('**已存在 → 不悄悄覆盖** ✓（**用户的东西不能被吞掉** ✓）', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiz-'));
    try {
      const first = instance();
      installInstantiatedPack({ pack: first.pack, provenance: first.provenance, boardsRoot: root });
      const second = instance();
      let threw = false;
      try {
        installInstantiatedPack({ pack: second.pack, provenance: second.provenance, boardsRoot: root });
      } catch {
        threw = true;
      }
      expect(threw, '第二次落盘必须被拒 ✓').toBe(true);
      // **显式说覆盖 → 覆盖** ✓
      installInstantiatedPack({
        pack: second.pack,
        provenance: second.provenance,
        boardsRoot: root,
        overwrite: true,
      });
      expect(existsSync(join(root, 'atk-01', 'board.yaml'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
