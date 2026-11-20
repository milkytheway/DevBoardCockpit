/**
 * **End to end**: the real board → the probe → the instantiation → the install
 * → reading it back
 * (2026-11-19 · a one-off verification script — **not a criterion** · the
 * criteria are in tests/)
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

/**
 * The board id carries Chinese on purpose: the directory of the installed pack
 * has to survive a name that is not ASCII. The literal itself is on the
 * allowlist of the language gate, because the criterion of that behaviour
 * lives in tests/unit/wizard-run.test.ts.
 */
const BOARD_ID = '我的板子';
const BOARD_NAME = 'ATK-DLRK3588 (real board · a Chinese name)';

async function main(): Promise<void> {
  const generic = loadBoardPack(join(REPO, 'profiles/boards/generic-linux'));
  const profiles = loadProfiles({ builtinDir: join(REPO, 'profiles/targets') });
  const profile = profiles.find((p) => p.id === 'board-adb');
  if (profile === undefined) throw new Error('there is no board-adb');

  const settings = loadSettings(join(REPO, 'profiles/settings.json'));
  const adbPath = resolveAdbPath(settings);
  const log = new SessionLog({ label: 'wizard-e2e', transport: profile.transport, dataDir: join(tmpdir(), 'wiz-e2e') });
  const connection = createConnection(profile, log, { adbPath });
  await connection.open();

  console.log('=== 1. the probe of the real board runs the generic pack ===');
  const report = await probePack(generic, connection);
  for (const r of report.readers) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.readerId.padEnd(12)} ${r.problems.join('；')}`);
  }

  console.log('\n=== 2. the instantiation ===');
  const result = instantiatePack({
    source: generic,
    targetId: BOARD_ID,
    targetName: BOARD_NAME,
    outcomes: outcomesOf(report.readers),
    connection: { transport: profile.transport },
  });
  const errs = errorsOf(validatePack(result.pack));
  console.log(`  readers: ${result.pack.readers.length}`);
  console.log(`  validation errors: ${errs.length}`);
  for (const e of errs) console.log(`    ✗ rule ${e.rule} · ${e.path}: ${e.message}`);
  console.log(`  warnings: ${warningsOf(validatePack(result.pack)).length}`);
  console.log(`  guessed: ${result.provenance.guessed.map((g) => g.what).join(', ')}`);
  console.log(`  not on this board: ${result.provenance.missing.map((m) => m.readerId).join(', ') || '(none)'}`);

  console.log('\n=== 3. the install + reading it back ===');
  const root = mkdtempSync(join(tmpdir(), 'wiz-e2e-'));
  const { yamlPath } = installInstantiatedPack({
    pack: result.pack,
    provenance: result.provenance,
    boardsRoot: root,
  });
  console.log(`  installed at: ${yamlPath}`);
  const back = loadBoardPack(join(root, BOARD_ID));
  const backErrs = errorsOf(validatePack(back));
  console.log(`  the id that was read back: ${back.id}`);
  console.log(`  the readers that were read back: ${back.readers.length}`);
  console.log(`  the validation errors that were read back: ${backErrs.length}`);
  for (const e of backErrs) console.log(`    ✗ rule ${e.rule} · ${e.path}: ${e.message}`);
  console.log('\n  --- the first 25 lines of the yaml that was read back ---');
  console.log(readFileSync(yamlPath, 'utf8').split('\n').slice(0, 25).map((l) => '  ' + l).join('\n'));

  await connection.close();
  rmSync(root, { recursive: true, force: true });
  const green = report.ok && errs.length === 0 && backErrs.length === 0 && back.readers.length > 0;
  console.log(`\n${green ? '✅ the end to end run is all green' : '✗ there are errors'}`);
  if (!green) process.exitCode = 1;
}

void main();
