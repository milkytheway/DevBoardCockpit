import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { makeError } from '../../shared/errors';
import { parseWorkflow, type WorkflowPack } from './format';

/**
 * The registry of the workflow packs — the account of "which workflows
 * can run".
 *
 * ── Why it exists (the same Critical of two independent reviews) ──
 *
 * The words of review 32: "an agent can write a workflow pack of its own
 * and run it".
 * → The reason is plain: a workflow pack is "a set of commands that have
 *   to run on the user's machine", and
 *   `npm run workflow:run -- --package <any path>` only looks at the
 *   path, not at who.
 *
 * → So the question "who approved this pack" had nowhere to be
 *   recorded ✗ ——
 * that gate is the unified permission area in the settings today ✓
 * (ADR-D47 ✓ —— not in this module ✓).
 *
 * ── How this account is kept ──
 *
 * | Account | What it records | Who can change it |
 * |---|---|---|
 * | The registry | which packs are in the directory (id → pack + content digest) | dropping a file into the directory |
 * | ~~The approval account~~ | ⛔ gone ✓ (2026-11-16 ✓ · ADR-D48 ✓) | — |
 *
 * → Dropping a file into the directory does not mean it can run ✓
 *   (otherwise "being able to write a file" would be "being able to execute
 *   a command" ✗)
 * → The gate is the unified permission area in the settings ✓
 *   (ADR-D47 ✓) — that row also lists every step of the command ✓
 * → The content digest is still recorded ✓: the content changes → the
 *   digest changes → the chain of responsibility stays traceable ✓.
 *
 * ── The same shape as the cards ──
 *
 * On the card side it is "the card is in the directory + its manifest
 * says what it may do" ✓; on this side it is "the workflow pack is in
 * the directory + the row in the permission area says whether it may
 * run" ✓ → one model ✓.
 */
export interface RegisteredWorkflow {
  /** The id inside the pack */
  id: string;
  /** The name of the pack */
  name: string;
  /** The version */
  version: string;
  /** Where the file is */
  path: string;
  /** The content digest (the first link of the chain of responsibility — the content changes and the digest changes) */
  digest: string;
  /** The parsed pack */
  pack: WorkflowPack;
}

/**
 * A summary of what a workflow pack will do (for a human to read).
 */
export interface WorkflowPlan {
  id: string;
  name: string;
  /** Role → which machine it connects to (the profile id) */
  roles: { role: string; purpose: string; profile: string }[];
  /** Every writing step: where it runs, what it runs, whether it is dangerous, where the criterion is read */
  steps: {
    id: string;
    kind: string;
    /** The executing role (for a criterion step it is "on which role it is read") */
    role?: string;
    /** The command template (the inputs are not substituted yet — that is what the row in the permission area shows) */
    command?: string;
    /** Is this step dangerous (destructive → only information — the gate is in the permission area · ADR-D48) */
    dangerous: boolean;
    /** On which role the criterion is read (reading across targets = "does the file really exist on the board") */
    readbackRole?: string;
  }[];
}

/** Summarise a workflow pack */
export function planOf(pack: WorkflowPack): WorkflowPlan {
  return {
    id: pack.id,
    name: pack.name,
    roles: Object.entries(pack.roles).map(([role, r]) => ({
      role,
      purpose: r.purpose,
      profile: r.profile,
    })),
    steps: pack.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      ...(step.role === undefined ? {} : { role: step.role }),
      ...(step.cmd === undefined ? {} : { command: step.cmd }),
      dangerous: step.danger === 'destructive',
      ...(step.readback?.role === undefined ? {} : { readbackRole: step.readback.role }),
    })),
  };
}

/** The constructor arguments of the registry */
export interface WorkflowRegistryOptions {
  /** The pack directories (the built-in ones plus the user's, the user's wins on the same id) */
  dirs: string[];
  /** Where the warnings go */
  warn?: (message: string) => void;
  /** Now (milliseconds) */
  now?: () => number;
}

/** The content digest (sha256, the first 16 digits are enough — its purpose is "did it change", not tamper protection) */
export function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export class WorkflowRegistry {
  private readonly warn: (message: string) => void;
  private packs = new Map<string, RegisteredWorkflow>();

  constructor(private readonly opts: WorkflowRegistryOptions) {
    this.warn = opts.warn ?? ((m: string) => console.warn(m));
  }

  /** Scan the directories and register again (a broken pack does not take the rest down — the same rule as the profile loader) */
  scan(): void {
    this.packs = new Map();

    // The one scanned later overrides the one scanned earlier → the user directory goes last (the user's wins on the same id)
    for (const dir of this.opts.dirs) {
      if (!existsSync(dir)) continue;
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/\.(ya?ml)$/i.test(file)) continue;
        const path = join(dir, file);
        let raw: string;
        try {
          raw = readFileSync(path, 'utf8');
        } catch (err) {
          this.warn(`skipping the workflow pack that cannot be read ${path}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        let pack: WorkflowPack;
        try {
          pack = parseWorkflow(yaml.load(raw), path);
        } catch (err) {
          this.warn(`skipping the broken workflow pack ${path}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const digest = digestOf(raw);
        this.packs.set(pack.id, {
          id: pack.id,
          name: pack.name,
          version: pack.version,
          path,
          digest,
          pack,
        });
      }
    }
  }

  /**
   * What this pack will do (it is for the row in the permission area).
   *
   * → Before that switch is turned on, the human has to know which
   *   commands run on which machines ✓
   *   (the second recommendation of 32-C1 of review 35 ✓).
   * → Without this, the switch is only "turn on a file name" → it is the
   *   same as not looking at all ✗.
   */
  planOf(id: string): WorkflowPlan | undefined {
    const found = this.packs.get(id);
    if (found === undefined) return undefined;
    return planOf(found.pack);
  }

  /** List everything (everything in the registry — there is no "approved" column any more) */
  list(): RegisteredWorkflow[] {
    return [...this.packs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Get one pack by id (it checks nothing else — the caller decides whether to look) */
  get(id: string): RegisteredWorkflow | undefined {
    return this.packs.get(id);
  }

  /**
   * Get one pack by id.
   *
   * → There is no "approved" layer any more ✓ (2026-11-16 ✓ · ADR-D48
   *   ✓) — the existence of a workflow pack is the explanation itself
   *   ✓ (the row of switches in the permission area is the gate ✓ — ADR-D47
   *   ✓).
   *
   * @throws when there is no such pack → `IPC_INVALID_PAYLOAD` ✓
   */
  require(id: string): RegisteredWorkflow {
    const found = this.packs.get(id);
    if (found === undefined) {
      // With a machine-readable reason ✓ (the MCP layer hands it back
      // to the agent ✓ — contract section 4; otherwise it can only be
      // guessed from the message — that is the bad smell of "parsing the
      // error message" ✗)

      throw makeError('IPC_INVALID_PAYLOAD', `no such workflow pack: ${id}`, {
        detail: { id, reason: 'not_found' },
      });
    }
    return found;
  }

 }
