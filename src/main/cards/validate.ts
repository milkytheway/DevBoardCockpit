import type { CardManifest } from './manifest';
import { permissionCovers } from './permissions';
import { isCoreTag } from '../tags/vocabulary';

/**
 * The validation of a card manifest (the **13 rules** of contract `spec/03` §9).
 *
 * ── The report has to carry the rule number ──
 *
 * "This card is invalid" is useless; "**rule 5**: this action is not in the
 * current board pack" is useful — a person can fix it, an agent can fix it.
 *
 * ── "Not verified" is not "invalid" ──
 *
 * Rule 5 cannot be checked **while the board is unreachable** — at that moment
 * it is **not** this card that has a problem, it is **that we have not checked
 * yet**. So while offline it goes into `warnings` (amber), not into `errors`
 * (red).
 *
 * ── Why rules 10 / 11 / 13 are not visible here ──
 *
 * Those three are **structural** (an unknown field, a card may not declare
 * `danger`, the parameter types are closed) and are already blocked by the
 * **parser** (the closed schema of `manifest.ts`) — anything that does not
 * parse **never reaches this file**.
 * This file still **re-checks** 11 and 13 (a hand-written manifest object is
 * blocked as well); only the parser can check rule 10 (after the parsing the
 * field is already gone).
 */

export interface CardIssue {
  severity: 'error' | 'warning';
  /** The rule numbers of contract §9 */
  rule: number;
  path: string;
  message: string;
}

export interface ValidateCardContext {
  /** The tags the current board pack provides. `null` = **offline** (the board is unreachable) */
  availableTags: string[] | null;
  /** The action ids the current board pack declares. `null` = **offline** */
  availableActions: string[] | null;
  /** The workflow ids declared in the host (rule 14 ✓). `null` = **offline** (it cannot be looked up ✓) */
  availableWorkflows: string[] | null;
  /** The ids of the cards that are already installed (rule 2) */
  installedCardIds: string[];
  /** Does this relative path exist in the card directory (rule 9) */
  fileExists: (relPath: string) => boolean;
}

export interface ValidateCardResult {
  ok: boolean;
  errors: CardIssue[];
  warnings: CardIssue[];
  resolved: {
    tags: string[];
    actions: string[];
    layout: { w: number; h: number; min_w: number; min_h: number } | null;
  };
}

/** The known contract versions */
const KNOWN_API_VERSIONS = ['devboard/v1'] as const;

/** The grid a card may declare (12 columns). */
const GRID_COLUMNS = 12;

const PARAM_TYPES = ['integer', 'number', 'string', 'boolean', 'enum'] as const;

export function validateCard(manifest: CardManifest, ctx: ValidateCardContext): ValidateCardResult {
  const errors: CardIssue[] = [];
  const warnings: CardIssue[] = [];

  const error = (rule: number, path: string, message: string): void => {
    errors.push({ severity: 'error', rule, path, message });
  };
  const warn = (rule: number, path: string, message: string): void => {
    warnings.push({ severity: 'warning', rule, path, message });
  };

  /* ── Rule 1: apiVersion ── */
  if (!(KNOWN_API_VERSIONS as readonly string[]).includes(manifest.apiVersion)) {
    error(1, 'apiVersion', `unknown contract version "${manifest.apiVersion}"`);
  }

  /* ── Rule 2: the id is globally unique ── */
  if (ctx.installedCardIds.includes(manifest.id)) {
    error(2, 'id', `a card with the id "${manifest.id}" is already installed`);
  }

  /* ── Rule 3: requires ⊆ permissions (judged by pattern coverage, contract §2.2) ──
       **Reported per entry**: saying only "one of them is not covered" leaves the
       reader to find out which one. */
  const requires = manifest.requires ?? {};
  const perms = manifest.permissions;
  for (const tag of requires.tags ?? []) {
    if (!permissionCovers(perms, tag)) {
      error(3, 'requires.tags', `"${tag}" is not covered by permissions.read`);
    }
  }
  for (const actionId of requires.actions ?? []) {
    if (!perms.write.includes(actionId)) {
      error(3, 'requires.actions', `action "${actionId}" does not appear in permissions.write`);
    }
  }
  // **The same for workflow ids** (review 35, V2-C2 ✓):
  // `requires.workflows` is declared but not covered in `permissions.workflows` → **an error** ✓
  // (otherwise rule 3 has an exception = "a wish may exceed the authorisation" ✗)
  for (const workflowId of requires.workflows ?? []) {
    if (!(perms.workflows ?? []).includes(workflowId)) {
      error(3, 'requires.workflows', `workflow "${workflowId}" does not appear in permissions.workflows`);
    }
  }

  /* ── Rule 4: a tag in the read permissions has to be under the core vocabulary or under `custom.*` ── */
  for (const tag of perms.read) {
    if (!isCoreTag(tag) && !tag.startsWith('custom.')) {
      error(4, 'permissions.read', `"${tag}" is neither in the core vocabulary nor under custom.*`);
    }
  }

  /* ── Rule 6: no wildcards in the write permissions (contract §2.3) ──
       This one is checked first: once the wildcard action id has been reported,
       rule 5 should not report "the board pack does not have it" a second
       time ── */
  const writeIds: string[] = [];
  for (const id of perms.write) {
    if (id.includes('*')) {
      error(6, 'permissions.write', `write permissions only accept exact action ids, "${id}" is a wildcard`);
    } else {
      writeIds.push(id);
    }
  }

  /* ── Rule 5: an action in the write permissions has to be in the current board pack ── */
  for (const id of writeIds) {
    if (ctx.availableActions === null) {
      warn(5, 'permissions.write', `action "${id}" is **unverified** (the board cannot be reached, so the board pack cannot be confirmed to have it)`);
    } else if (!ctx.availableActions.includes(id)) {
      error(5, 'permissions.write', `the current board pack has no action "${id}"`);
    }
  }

  /* ── Rule 14: a workflow permission only allows an exact id, and it **has to be a workflow declared in the host** ──
       (the last rule of contract §9 ✓ — added in plan 7 ✓)
       → "no wildcards" for the same reason as the write permissions ✓ (§2.3 ✓):
       a wildcard on the write side widens the scope of the authorisation ✓
       → "not in the host" is handled like rule 5 ✓: **a warning while offline** ✓
       (not "invalid" ✓) */
  const workflowIds: string[] = [];
  for (const id of perms.workflows ?? []) {
    if (id.includes('*')) {
      error(14, 'permissions.workflows', `workflow permissions only accept exact ids, "${id}" is a wildcard`);
    } else {
      workflowIds.push(id);
    }
  }
  for (const id of workflowIds) {
    if (ctx.availableWorkflows === null) {
      warn(14, 'permissions.workflows', `workflow "${id}" is **unverified** (offline, so the host cannot be confirmed to have it)`);
    } else if (!ctx.availableWorkflows.includes(id)) {
      error(14, 'permissions.workflows', `the host has no workflow "${id}"`);
    }
  }

  /* ── Rules 7 / 12: the actions and the write permissions match ── */
  for (const [index, action] of (manifest.actions ?? []).entries()) {
    if (action.target === undefined) {
      // An in-view action: it **does not touch the board**, so it must not appear in the write permissions
      if (perms.write.includes(action.id)) {
        error(12, `actions[${index}].id`, `the view-local action "${action.id}" must not appear in permissions.write`);
      }
    } else if (!perms.write.includes(action.target)) {
      error(7, `actions[${index}].target`, `the board action "${action.target}" is not in permissions.write`);
    }
  }

  /* ── Rule 8: the size of the layout ── */
  const layout = manifest.layout;
  if (layout !== undefined) {
    const w = layout.w ?? 3;
    const h = layout.h ?? 2;
    const minW = layout.min_w ?? 1;
    const minH = layout.min_h ?? 1;
    if (w < 1 || w > GRID_COLUMNS || h < 1) {
      error(8, 'layout', `w/h must be between 1 and ${GRID_COLUMNS} (got w=${w} h=${h})`);
    }
    if (minW > w || minH > h) {
      error(8, 'layout', `min_w/min_h must not be greater than w/h (got ${minW}×${minH} vs ${w}×${h})`);
    }
  }

  /* ── Rule 9: the entry file exists ── */
  if (!ctx.fileExists(manifest.entry)) {
    error(9, 'entry', `the entry file "${manifest.entry}" does not exist`);
  }

  /* ── The re-check of rules 11 / 13 (the two structural ones, the parser has already blocked them once) ── */
  for (const [index, action] of (manifest.actions ?? []).entries()) {
    const raw = action as unknown as Record<string, unknown>;
    for (const forbidden of ['danger', 'readback']) {
      if (forbidden in raw) {
        error(11, `actions[${index}].${forbidden}`, `a card must not declare ${forbidden} (that belongs to the board pack)`);
      }
    }
    for (const [key, param] of Object.entries(action.params ?? {})) {
      const p = param as unknown as Record<string, unknown>;
      const type = p['type'];
      if (typeof type !== 'string' || !(PARAM_TYPES as readonly string[]).includes(type)) {
        error(13, `actions[].params.${key}.type`, `unknown parameter type: ${String(type)}`);
      }
      if (type === 'string' && p['maxLength'] === undefined) {
        error(13, `actions[].params.${key}`, 'a string parameter must declare maxLength');
      }
    }
  }

  /* ── resolved: the list that came out of the parsing ── */
  const resolvedLayout =
    layout === undefined
      ? null
      : {
          w: layout.w ?? 3,
          h: layout.h ?? 2,
          min_w: layout.min_w ?? 1,
          min_h: layout.min_h ?? 1,
        };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    resolved: {
      tags: [...perms.read],
      actions: [...perms.write],
      layout: resolvedLayout,
    },
  };
}
