/**
 * Installs a board kit ✓ (contract `docs/spec/06-board-kit.md` ✓).
 *
 * ```
 * npm run kit:install -- --kit ATK-DLRK3588 \
 *   --var serial_port=COM3 --var adb_serial=<the board's serial> --var board_host=192.168.5.100
 * ```
 *
 * → The answers are **remembered** ✓ (in the user data directory ✓) →
 *   the next install of the same kit is one command without the variables ✓.
 * → **A profile that is already there is not overwritten** ✓ (contract rule 14 ✓).
 */
import { join } from 'node:path';
import { loadKits, kitsForModel, installKit, type BoardKit } from '../src/main/kits/kit';
import { KitVariableStore } from '../src/main/kits/variables';
import { userDataDir, userProfilesDir } from '../src/main/util/paths';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function vars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of process.argv) {
    const m = /^--var=([^=]+)=(.*)$/.exec(a);
    if (m !== null) out[m[1] ?? ''] = m[2] ?? '';
  }
  return out;
}

function main(): void {
  const kits = loadKits(join(process.cwd(), 'profiles', 'kits'));
  if (kits.length === 0) {
    console.error('no kits in profiles/kits ✓');
    process.exit(1);
  }

  const wanted = arg('kit');
  const model = arg('model');
  let kit: BoardKit | undefined;
  if (wanted !== undefined) {
    kit = kits.find((k) => k.id === wanted);
    if (kit === undefined) {
      console.error(
        `there is no kit "${wanted}" ✓ — the ones that are there: ${kits.map((k) => k.id).join(' / ')}`,
      );
      process.exit(1);
    }
  } else if (model !== undefined) {
    const hits = kitsForModel(kits, model);
    if (hits.length !== 1) {
      // **Never a guess** ✓ (contract rule 9 ✓)
      console.error(
        hits.length === 0
          ? `no kit matches the model "${model}" ✓`
          : `several kits match "${model}" ✓ — pick one: ${hits.map((k) => k.id).join(' / ')}`,
      );
      process.exit(1);
    }
    kit = hits[0];
  } else {
    console.error(
      `say which kit: --kit <id> or --model <model> ✓ — the ones that are there: ${kits
        .map((k) => `${k.id} (${k.model})`)
        .join(' / ')}`,
    );
    process.exit(1);
  }

  const store = new KitVariableStore(join(userDataDir(), 'kit-variables.json'));
  const given = vars();
  if (Object.keys(given).length > 0) {
    store.setMany(kit.id, given);
  }

  const answers = { ...store.all(kit.id), ...given };
  const result = installKit(kit, answers, userProfilesDir());

  if (result.missing.length > 0) {
    console.error(`these variables have no value yet: ${result.missing.join(' / ')} ✓`);
    console.error(
      `  fill them: npm run kit:install -- --kit ${kit.id} --var <name>=<value> ✓`,
    );
    process.exit(1);
  }
  console.log(
    `✓ the kit "${kit.id}" is installed ✓ — written: ${
      result.written.join(' / ') || '(nothing)'
    } · already there: ${result.kept.join(' / ') || '(nothing)'}`,
  );
  console.log(`  the profiles live in ${userProfilesDir()} ✓`);
}

main();
