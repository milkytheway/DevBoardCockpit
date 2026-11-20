/**
 * The probe of a board pack on a real board (`npm run probe:board`).
 *
 * **The acceptance criterion of M4**: "`probe:board` is all green for
 * `rk3588-atk`".
 *
 * ── What it does ──
 *
 * 1. **Validate first, probe second** — probing a pack that does not pass its
 *    own validator means nothing;
 * 2. Connect to the board, take the data group by group over `poll_groups`,
 *    parse it and bind the tags;
 * 3. Judge reader by reader: **every declared tag was read, there is no extra
 *    one, every state is ok**;
 * 4. All green → exit code 0; otherwise 1.
 *
 * ── Why every group is sampled **twice** ──
 *
 * The usage of `proc_stat` is **the difference of two samples** (contract
 * §2.4) — the first reading is `pending`, not 0. The probe wants the **real
 * value**, so it samples every group twice.
 *
 * Usage:
 *   npm run probe:board                                  # the default pack and the connection it picks
 *   npm run probe:board -- --profile board-adb           # a given connection profile
 *   npm run probe:board -- --pack profiles/boards/rk3588-atk
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings, resolveAdbPath } from '../src/main/util/settings';
import { loadProfiles } from '../src/main/profiles/loader';
import { createConnection } from '../src/main/hal/registry';
import { SessionLog } from '../src/main/logging/session-log';
import { loadBoardPack } from '../src/main/tags/pack';
import { validatePack, errorsOf, warningsOf } from '../src/main/tags/validator';
import { probePack, resolvePackDir, describeRequires, probeHint, type ProbeReaderReport } from '../src/main/tags/probe';

const REPO = process.cwd();

interface Args {
  profile?: string;
  pack?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--profile' && argv[i + 1] !== undefined) {
      out.profile = argv[i + 1];
      i += 1;
    } else if (a === '--pack' && argv[i + 1] !== undefined) {
      out.pack = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/** Where the session log goes */
function logDir(): string {
  const local = process.env['LOCALAPPDATA'];
  if (local) return join(local, 'DevBoardCockpit');
  return join(tmpdir(), 'devboard-cockpit-probe');
}

/** Prints the report of one reader */
function printReader(report: ProbeReaderReport): void {
  const tags = report.tags
    .map((t) => `${t.tag}=${t.value === null ? '—' : String(t.value)}${t.unit === '-' ? '' : t.unit}`)
    .join('  ');
  const mark = report.ok ? '✓' : '✗';
  console.log(`  ${mark} ${report.readerId.padEnd(14)} ${report.kind.padEnd(16)} ${tags}`);
  for (const problem of report.problems) {
    console.log(`      ${problem}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // ── 1. Validate ──
  // `--pack` **takes a pack id as well** (that is what the documentation says)
  const packDir = resolvePackDir(args.pack, join(REPO, 'profiles/boards'));
  const pack = loadBoardPack(packDir);
  const issues = validatePack(pack);
  for (const w of warningsOf(issues)) {
    console.log(`  warning · rule ${w.rule} · ${w.path}: ${w.message}`);
  }
  const errs = errorsOf(issues);
  if (errs.length > 0) {
    console.error('✗ the pack does not pass the validation, it is not probed:');
    for (const e of errs) {
      console.error(`  rule ${e.rule} · ${e.path}: ${e.message}`);
    }
    return 1;
  }

  // ── 2. Find the connection profile ──
  const profiles = loadProfiles({ builtinDir: join(REPO, 'profiles/targets') });
  const profile = args.profile
    ? profiles.find((p) => p.id === args.profile)
    : profiles.find((p) => p.board_pack === pack.id);
  if (profile === undefined) {
    console.error(
      args.profile
        ? `✗ there is no connection profile with the id "${args.profile}"`
        : `✗ there is no connection profile that points at the board pack "${pack.id}" (name one with --profile)`,
    );
    return 1;
  }

  console.log(`=== ${pack.id} (connection: ${profile.id} · ${profile.transport}) ===`);
  // The only consumer of `requires.capabilities` in v1 (the "pack description
  // query" that C9 promised)
  console.log(describeRequires(pack));

  // ── 3. Connect ──
  const settings = loadSettings(join(REPO, 'profiles/settings.json'));
  const adbPath = resolveAdbPath(settings);
  const log = new SessionLog({
    label: `probe-${profile.id}`,
    transport: profile.transport,
    dataDir: logDir(),
  });
  const connection = createConnection(profile, log, { adbPath });

  try {
    await connection.open();
  } catch (err) {
    console.error(`✗ cannot connect: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    // ── 4. Two rounds per group (proc_stat only has a value after two samples) ──
    const report = await probePack(pack, connection);
    for (const reader of report.readers) printReader(reader);
    const reports: ProbeReaderReport[] = report.readers;

    const hint = probeHint(report, profile.transport);
    if (hint !== null) {
      console.error('');
      console.error(hint);
    }

    const green = reports.filter((r) => r.ok).length;
    if (green === reports.length) {
      console.log(`\n✅ ${pack.id}: all ${reports.length} readers are green`);
      return 0;
    }
    console.error(`\n✗ ${pack.id}: ${green}/${reports.length} readers are green`);
    return 1;
  } finally {
    await connection.close().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`✗ the probe crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
