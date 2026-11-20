/**
 * Runs one workflow on the host side — **the only entry point of the first
 * version of the workflow packs**.
 *
 * > **Why only the command line** (ADR-D31 R1): the first version of the
 * > workflow packs is a **host level format**, the card API and the MCP tools
 * > **do not touch the contract in the first version** → the way it is
 * > triggered is **a human running it on the host**
 * > ("the card lets the user pick the host machine or the guest" is a
 * > **later increment of the contract** — the decision D7 that is still open).
 *
 * ── Two ways, **and they take the pack differently** ──
 *
 * | Form | Where the pack comes from | Who uses it |
 * |---|---|---|
 * | `--id <id>` | **the registry** (only the ids of the registry) | humans and the cards/agents of the future |
 * | `--package <path>` | **one file** (the path is the permission of that one run) | **development / one-off** |
 *
 * → **The cards and the agents can only take the `--id` way** (`WorkflowService`
 *   only knows ids).
 * → **Neither of them asks for an "approval" any more** (**cut on
 *   2026-11-16** · ADR-D48) — **whether it can run is decided by the unified
 *   permission area in the settings** (ADR-D47).
 *
 * Usage:
 * ```powershell
 * npm run workflow:list                                   # what is there
 * npm run workflow:run -- --id hello-kernel.build-run --input project=01-hello
 * npm run workflow:run -- --package profiles/workflows/hello-kernel.build-run.yaml --input project=01-hello
 * ```
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { parseWorkflow, type WorkflowPack } from '../src/main/workflows/format';
import { TargetRegistry } from '../src/main/workflows/targets';
import { runWorkflow, type WorkflowRunDeps } from '../src/main/workflows/runner';
import { WorkflowRegistry } from '../src/main/workflows/registry';
import { loadProfiles } from '../src/main/profiles/loader';
import { createConnection } from '../src/main/hal/registry';
import { loadBoardPack } from '../src/main/tags/pack';
import type { ActionDef } from '../src/main/tags/schema';
import { ActionAudit } from '../src/main/actions/audit';
import { SessionLog } from '../src/main/logging/session-log';
import { builtinWorkflowsDir, userDataDir, userWorkflowsDir } from '../src/main/util/paths';

interface Args {
  package?: string;
  id?: string;
  input: Record<string, string>;
  dryRun: boolean;
  /** The confirmation credential (it is carried into the rerun of that step **after a person said yes**) */
  /** Continue from the nth step (a resume — the earlier steps do not run again) */
  from?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { input: {}, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--package' || arg === '-p') {
      out.package = argv[++i];
      continue;
    }
    if (arg === '--id') {
      out.id = argv[++i];
      continue;
    }
    if (arg === '--input' || arg === '-i') {
      const pair = argv[++i] ?? '';
      const at = pair.indexOf('=');
      if (at > 0) out.input[pair.slice(0, at)] = pair.slice(at + 1);
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--from') {
      out.from = Number(argv[++i]);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: npm run workflow:run -- (--id <workflow id> | --package <workflow pack.yaml>) [--input name=value]...',
          '',
          '  --id        through the **registry** (only the ids of the registry) — humans and the cards/agents of the future take this one',
          '  --package   runs one file directly (**development / one-off**: a path that the human typed is the permission of that one run)',
          '',
          'Examples:',
          '  npm run workflow:run -- --id hello-kernel.build-run --input project=01-hello',
          '  npm run workflow:run -- --package profiles/workflows/hello-kernel.build-run.yaml --input project=01-hello',
          '',
          'Companion:',
          '  npm run workflow:list                              what is there',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.package === undefined && args.id === undefined) {
    console.error('--id or --package is missing (which workflow pack has to run)');
    process.exit(2);
  }

  // ── The connection profiles of the host ──
  const dataDir = userDataDir();
  const profiles = loadProfiles({
    builtinDir: join(process.cwd(), 'profiles', 'targets'),
    userDir: join(dataDir, 'profiles', 'targets'),
  });
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  // ── The workflow pack: two ways, different permissions ──
  const pack = resolvePack(args);

  // ── The profile a role is bound to has to exist (**it may not quietly
  //    connect to another one**) ──
  for (const [name, role] of Object.entries(pack.roles)) {
    if (!profileById.has(role.profile)) {
      console.error(`the profile "${role.profile}" that the role "${name}" is bound to does not exist`);
      process.exit(2);
    }
  }

  console.log(`workflow: ${pack.name} (${pack.id})`);
  console.log(
    `roles: ${Object.entries(pack.roles)
      .map(([n, r]) => `${n}→${r.profile}`)
      .join(', ')}`,
  );

  if (args.dryRun) {
    console.log('\n--dry-run: nothing is executed, the steps are only listed:');
    for (const step of pack.steps) {
      console.log(`  ${step.id} (${step.kind}) ${step.cmd ?? step.action ?? step.pattern ?? ''}`);
    }
    return;
  }

  // ── The actions of the board packs (the `action` step needs them) ──
  //
  // The CLI used to **not hand over** the `actionDef` ✗ → an `action` step
  // reported "the board pack does not have this action" right away in the
  // CLI ✗ → **the CLI could not run the packs that the application runs** ✗
  // (two sources of truth).
  //
  // → Now the `board_pack` of the profile that a role is bound to is
  //   **loaded statically** (**the application takes the runtime way** — that
  //   one resolves per connection).
  //
  // ⚠️ **The readback form 1 (reading a tag) cannot be looked up in the CLI**
  // — the workflow layer has no runtime of a board pack → `readTag` returns
  // undefined → that kind of action **does not pass the readback** in the CLI
  // (honest).
  const actionDefs = new Map<string, ActionDef>();
  for (const [roleName, role] of Object.entries(pack.roles)) {
    const profile = profileById.get(role.profile);
    const packId = profile?.board_pack;
    if (packId === undefined || packId === null || packId === '') continue;
    const dir = join(process.cwd(), 'profiles', 'boards', packId);
    if (!existsSync(dir)) continue;
    try {
      const loaded = loadBoardPack(dir);
      for (const def of loaded.actions) {
        // **Two definitions of the same name are not allowed** ✗ → the first one wins (across boards it is another story)
        if (!actionDefs.has(def.id)) actionDefs.set(def.id, def);
      }
    } catch (err) {
      console.error(`⚠ the board pack ${packId} of the role "${roleName}" cannot be read: ${String(err)}`);
    }
  }

  const audit = new ActionAudit(join(dataDir, 'logs', 'actions.log'));
  // **The registry of the confirmation credentials** (the workflow layer and M6 share one — the semantics live in one place)
  const registry = new TargetRegistry({
    profileFor: (id) => profileById.get(id),
    createConnection: (profile) => {
      const log = new SessionLog({
        label: `workflow-${profile.id}`,
        transport: profile.transport,
        dataDir,
      });
      return createConnection(profile, log);
    },
  });

  try {
    const deps: WorkflowRunDeps = {
      targets: registry,
      profileFor: (id: string) => profileById.get(id),
      audit: (row) => audit.append(row),
      // **The action definition that an `action` step needs** (see the comment above)
      actionDef: (actionId: string) => actionDefs.get(actionId),
    };
    // **A human runs it = the nod of this one run** (the trust model of ADR-D31 R2 — **there is no step that asks for a confirmation any more** · ADR-D48)
    const result = await runWorkflow(pack, args.input, deps, {
      ...(args.from === undefined ? {} : { startAt: args.from }),
    });

    console.log(`\nrun ${result.runId}: ${result.ok ? 'it succeeded' : 'it did not succeed'}`);
    for (const stage of result.stages) {
      const mark = stage.ok ? (stage.verified ? '✓' : '○') : '✗';
      console.log(
        `  ${mark} ${stage.stepId} (${stage.kind}) ${stage.role ? `@${stage.role}` : ''}` +
          `${stage.reason ? ` — ${stage.reason}` : ''}${stage.detail ? `: ${stage.detail}` : ''}` +
          `${stage.audit_id ? ` [${stage.audit_id}]` : ''}`,
      );
    }
    if (Object.keys(result.outputs).length > 0) {
      console.log(`\noutputs: ${JSON.stringify(result.outputs)}`);
    }
    process.exit(result.ok ? 0 : 1);
  } finally {
    await registry.closeAll();
  }
}

/**
 * The workflow pack: two ways, **with different permissions**.
 *
 * - `--id` → **the registry** → it **has to be approved** (this is the way
 *   the cards/agents take);
 * - `--package` → it reads that file directly (**a path that the human
 *   typed = the permission of that one run** — for development / one-off).
 */
function resolvePack(args: Args): WorkflowPack {
  if (args.id !== undefined) {
    const registry = new WorkflowRegistry({
      dirs: workflowDirs(),
    });
    registry.scan();
    const found = registry.get(args.id);
    if (found === undefined) {
      console.error(`there is no such workflow pack: ${args.id}`);
      process.exit(2);
    }
    // **The approval is not looked up any more** (ADR-D48 — **its existence is the explanation**)
    return found.pack;
  }
  const path = resolve(process.cwd(), args.package as string);
  return parseWorkflow(yaml.load(readFileSync(path, 'utf8')), path);
}

/** The directories of the workflow packs: the built-in ones + the user ones (**the user wins on the same id**) */
function workflowDirs(): string[] {
  const dirs = [builtinWorkflowsDir(process.cwd()), userWorkflowsDir()];
  return dirs.filter((d) => existsSync(d));
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
