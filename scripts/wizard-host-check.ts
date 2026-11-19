/**
 * **验向导在宿主侧真的跑得通** ✓ —— 2026-11-19。
 *
 * → **不绕 renderer** ✓ —— 直接调 `runWizardForHost` ✓（**那是 handler 的本体** ✓）。
 * → **用真板** ✓（串口 COM1 ✓ · 1500000 ✓）。
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runWizardForHost } from '../src/main/wizard/wiring';

const REPO = resolve(process.cwd());

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'wiz-host-'));
  try {
    console.log('=== 调宿主侧的向导（真板 · ADB）===');
    const r = await runWizardForHost(
      { port: 'COM1', baudrate: 1500000, boardName: '串口测试板', transport: 'adb' },
      {
        appRoot: REPO,
        userProfilesDir: join(root, 'profiles'),
        userBoardsDir: join(root, 'boards'),
        userDataDir: join(root, 'data'),
      },
    );
    console.log(JSON.stringify(r, null, 2));
    console.log('');
    console.log('=== 落了哪些东西 ===');
    const boards = join(root, 'boards');
    for (const d of readdirSync(boards)) {
      console.log('  boards/' + d + '/');
      for (const f of readdirSync(join(boards, d))) {
        console.log('    ' + f);
      }
    }
    const prov = JSON.parse(
      readFileSync(join(boards, r.boardId ?? '', 'provenance.json'), 'utf8'),
    ) as Record<string, unknown>;
    console.log('');
    console.log('=== provenance.json ===');
    console.log(JSON.stringify(prov, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
