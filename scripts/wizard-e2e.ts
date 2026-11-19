/**
 * **端到端**：真板 → 探针 → 实例化 → 落盘 → 读回来 ✓
 * （2026-11-19 · 一次性验证脚本 ✓ —— 不是判据 ✓ · 判据在 tests/ ✓）
 */
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadBoardPack } from '../src/main/tags/pack';
import { validatePack, errorsOf, warningsOf } from '../src/main/tags/validator';
import { probePack } from '../src/main/tags/probe';
import { outcomesOf } from '../src/main/wizard/probe-adapter';
import { instantiatePack } from '../src/main/wizard/instantiate';
import { installInstantiatedPack } from '../src/main/wizard/install';
import { loadProfiles } from '../src/main/profiles/loader';
import { createConnection } from '../src/main/hal/registry';
import { loadSettings, resolveAdbPath } from '../src/main/util/settings';
import { SessionLog } from '../src/main/logging/session-log';

const REPO = resolve(process.cwd());

async function main(): Promise<void> {
  const generic = loadBoardPack(join(REPO, 'profiles/boards/generic-linux'));
  const profiles = loadProfiles({ builtinDir: join(REPO, 'profiles/targets') });
  const profile = profiles.find((p) => p.id === 'board-adb');
  if (profile === undefined) throw new Error('没有 board-adb');

  const settings = loadSettings(join(REPO, 'profiles/settings.json'));
  const adbPath = resolveAdbPath(settings);
  const log = new SessionLog({ label: 'wizard-e2e', transport: profile.transport, dataDir: join(tmpdir(), 'wiz-e2e') });
  const connection = createConnection(profile, log, { adbPath });
  await connection.open();

  console.log('=== 1. 真板探针跑通用包 ===');
  const report = await probePack(generic, connection);
  for (const r of report.readers) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.readerId.padEnd(12)} ${r.problems.join('；')}`);
  }

  console.log('\n=== 2. 实例化 ===');
  const result = instantiatePack({
    source: generic,
    targetId: 'atk-01',
    targetName: 'ATK-DLRK3588（真板）',
    outcomes: outcomesOf(report.readers),
    connection: { transport: profile.transport },
  });
  const errs = errorsOf(validatePack(result.pack));
  console.log(`  reader 数：${result.pack.readers.length}`);
  console.log(`  校验错误：${errs.length}`);
  for (const e of errs) console.log(`    ✗ 规则 ${e.rule} · ${e.path}：${e.message}`);
  console.log(`  警告：${warningsOf(validatePack(result.pack)).length}`);
  console.log(`  猜的：${result.provenance.guessed.map((g) => g.what).join('、')}`);
  console.log(`  这板没有：${result.provenance.missing.map((m) => m.readerId).join('、') || '（无）'}`);

  console.log('\n=== 3. 落盘 + 读回来 ===');
  const root = mkdtempSync(join(tmpdir(), 'wiz-e2e-'));
  const { yamlPath } = installInstantiatedPack({
    pack: result.pack,
    provenance: result.provenance,
    boardsRoot: root,
  });
  console.log(`  落在：${yamlPath}`);
  const back = loadBoardPack(join(root, 'atk-01'));
  const backErrs = errorsOf(validatePack(back));
  console.log(`  读回来的 id：${back.id}`);
  console.log(`  读回来的 reader 数：${back.readers.length}`);
  console.log(`  读回来的校验错误：${backErrs.length}`);
  for (const e of backErrs) console.log(`    ✗ 规则 ${e.rule} · ${e.path}：${e.message}`);
  console.log('\n  --- 读回来的 yaml 前 25 行 ---');
  console.log(readFileSync(yamlPath, 'utf8').split('\n').slice(0, 25).map((l) => '  ' + l).join('\n'));

  await connection.close();
  rmSync(root, { recursive: true, force: true });
  const green = report.ok && errs.length === 0 && backErrs.length === 0 && back.readers.length > 0;
  console.log(`\n${green ? '✅ 端到端全绿' : '✗ 有错'}`);
  if (!green) process.exitCode = 1;
}

void main();
