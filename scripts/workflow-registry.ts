/**
 * The **ledger** of the workflow packs — what is there.
 *
 * ── Why this is the only command ──
 *
 * "**Dropping a file into a directory ≠ it can run**" (`workflows/registry.ts`)
 * — that gate **is not on the command line**, **it is in the unified permission
 * area of the settings** (implementation decision record ADR-D47 ·
 * implementation decision record ADR-D48):
 *
 * | Command | What it does |
 * |---|---|
 * | `npm run workflow:list` | List the packs in the registry (**id / name / version**) |
 *
 * → **The "approved" column is gone** (2026-11-16 · implementation decision
 *   record ADR-D48).
 */
import { WorkflowRegistry } from '../src/main/workflows/registry';
import { builtinWorkflowsDir, userWorkflowsDir } from '../src/main/util/paths';

function workflowDirs(): string[] {
  return [builtinWorkflowsDir(process.cwd()), userWorkflowsDir()];
}

function registry(): WorkflowRegistry {
  const reg = new WorkflowRegistry({
    dirs: workflowDirs(),
  });
  reg.scan();
  return reg;
}



const command = process.argv[2] ?? 'list';

switch (command) {
  case 'list': {
    const list = registry().list();
    if (list.length === 0) {
      console.log('No workflow packs yet.');
      console.log(`  Put them in ${userWorkflowsDir()} (being there ≠ it can run — the gate is the permission area in the settings).`);
      break;
    }
    console.log('Workflow packs:');
    for (const w of list) {
      console.log(
        `  ${w.id} (${w.name} v${w.version})`,
      );
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command} (list)`);
    process.exit(2);
}
