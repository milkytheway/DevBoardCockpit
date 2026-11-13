/**
 * 板型包真机探针（`npm run probe:board`）。
 *
 * **M4 的验收判据**：「`probe:board` 对 `rk3588-atk` 全绿」。
 *
 * ── 它做什么 ──
 *
 * 1. **先校验，再探**——一个过不了自己校验器的包，探它没有意义；
 * 2. 连上板子，按 `poll_groups` 逐组取数、解析、绑 tag；
 * 3. 逐 reader 判定：**声明的 tag 全部拿到、多出来的没有、状态都是 ok**；
 * 4. 全绿 → 退出码 0；否则 1。
 *
 * ── 为什么每个组采**两次** ──
 *
 * `proc_stat` 的占用率是**两次采样做差**（契约 §2.4）——
 * 首读是 `pending`，不是 0。探针要的是**真值**，
 * 所以每组都采两轮。
 *
 * 用法：
 *   npm run probe:board                                  # 用默认包与自动挑的连接
 *   npm run probe:board -- --profile board-adb           # 指定连接 profile
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
import { probePack, resolvePackDir, describeRequires, type ProbeReaderReport } from '../src/main/tags/probe';

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

/** 会话日志放哪儿 */
function logDir(): string {
  const local = process.env['LOCALAPPDATA'];
  if (local) return join(local, 'DevBoardCockpit');
  return join(tmpdir(), 'devboard-cockpit-probe');
}

/** 打印一个 reader 的报告 */
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

  // ── 1. 先校验 ──
  // `--pack` **包 id 也认**（文档里写的就是 id）
  const packDir = resolvePackDir(args.pack, join(REPO, 'profiles/boards'));
  const pack = loadBoardPack(packDir);
  const issues = validatePack(pack);
  for (const w of warningsOf(issues)) {
    console.log(`  警告 · 规则 ${w.rule} · ${w.path}：${w.message}`);
  }
  const errs = errorsOf(issues);
  if (errs.length > 0) {
    console.error('✗ 包没通过校验，不探：');
    for (const e of errs) {
      console.error(`  规则 ${e.rule} · ${e.path}：${e.message}`);
    }
    return 1;
  }

  // ── 2. 找连接 profile ──
  const profiles = loadProfiles({ builtinDir: join(REPO, 'profiles/targets') });
  const profile = args.profile
    ? profiles.find((p) => p.id === args.profile)
    : profiles.find((p) => p.board_pack === pack.id);
  if (profile === undefined) {
    console.error(
      args.profile
        ? `✗ 没有 id 为「${args.profile}」的连接 profile`
        : `✗ 没有指向板型包「${pack.id}」的连接 profile（用 --profile 指定）`,
    );
    return 1;
  }

  console.log(`=== ${pack.id} （连接：${profile.id} · ${profile.transport}）===`);
  // `requires.capabilities` 在 v1 唯一的消费者（docs/06 C9 承诺的「包描述查询」）
  console.log(describeRequires(pack));

  // ── 3. 连上 ──
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
    console.error(`✗ 连不上：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    // ── 4. 逐组采两轮（proc_stat 要两次采样才有值） ──
    const report = await probePack(pack, connection);
    for (const reader of report.readers) printReader(reader);
    const reports: ProbeReaderReport[] = report.readers;

    const green = reports.filter((r) => r.ok).length;
    if (green === reports.length) {
      console.log(`\n✅ ${pack.id}：${reports.length} 个 reader 全绿`);
      return 0;
    }
    console.error(`\n✗ ${pack.id}：${green}/${reports.length} 个 reader 绿`);
    return 1;
  } finally {
    await connection.close().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`✗ 探针崩了：${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
