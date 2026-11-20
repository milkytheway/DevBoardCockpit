import { describe, it, expect } from 'vitest';
import { validateCard, type ValidateCardContext } from '../../../src/main/cards/validate';
import { parseManifest, type CardManifest } from '../../../src/main/cards/manifest';

/**
 * The **13 validation rules** of a card manifest (contract `spec/03` §9).
 *
 * Why the rule number is kept:
 *
 * "This card is invalid" is useless; "**rule 5**: this action is not in the
 * current board pack" is useful — a person can act on it and so can an agent.
 *
 * "Not verified" is not "not valid":
 *
 * Rule 5 cannot be checked while the board is unreachable — the card is not
 * at fault then, **we have not checked yet**. Offline it therefore lands in
 * `warnings` (amber), not in `errors` (red).
 */

function manifest(over: Record<string, unknown> = {}): CardManifest {
  return parseManifest(
    {
      apiVersion: 'devboard/v1',
      kind: 'Card',
      id: 'cpu-usage',
      name: 'CPU usage',
      version: '1.0.0',
      entry: 'index.html',
      requires: { tags: ['cpu.usage'] },
      layout: { w: 3, h: 2, min_w: 2, min_h: 1 },
      permissions: { read: ['cpu.usage'], write: [] },
      actions: [],
      ...over,
    },
    'cpu-usage',
  );
}

/** The context of a board that is connected */
function ctx(over: Partial<ValidateCardContext> = {}): ValidateCardContext {
  return {
    availableTags: ['cpu.usage', 'mem.usage'],
    availableActions: ['backlight.set'],
    availableWorkflows: ['demo.run'],
    installedCardIds: ['other-card'],
    fileExists: (rel) => rel === 'index.html',
    ...over,
  };
}

/** Finds the issue of a given rule number */
function byRule(
  result: {
    errors: { rule: number; path?: string; severity?: string }[];
    warnings: { rule: number; path?: string; severity?: string }[];
  },
  rule: number,
) {
  return [...result.errors, ...result.warnings].filter((i) => i.rule === rule);
}

describe('rule 14 · workflow permissions (the last one of contract §9)', () => {
  it('**a wildcard → it is reported** (a workflow permission allows an exact id only — as in §2.3)', () => {
    // **the host "has" this id** → so that **only the wildcard rule can be
// reported**
    // (otherwise the "the host does not have it" rule would be reported too → the
// criterion could no longer tell which rule it was)
    const result = validateCard(
      manifest({ permissions: { read: ['cpu.usage'], write: [], workflows: ['demo.*'] } }),
      ctx({ availableWorkflows: ['demo.*'] }),
    );
    const issues = byRule(result, 14);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.severity).toBe('error');
  });

  it('**the host does not have this workflow → it is reported**', () => {
    const result = validateCard(
      manifest({ permissions: { read: ['cpu.usage'], write: [], workflows: ['nope.run'] } }),
      ctx(),
    );
    const issues = byRule(result, 14);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('**offline → it is a warning, not an error** ("not verified" is not "not valid")', () => {
    const result = validateCard(
      manifest({ permissions: { read: ['cpu.usage'], write: [], workflows: ['demo.run'] } }),
      ctx({ availableWorkflows: null }),
    );
    const issues = byRule(result, 14);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('**the host has the workflow → it passes**', () => {
    const result = validateCard(
      manifest({ permissions: { read: ['cpu.usage'], write: [], workflows: ['demo.run'] } }),
      ctx(),
    );
    expect(byRule(result, 14)).toHaveLength(0);
  });
});

describe('the workflow half of rule 3', () => {
  it('`requires.workflows` is covered by `permissions.workflows` → it passes', () => {
    const result = validateCard(
      manifest({
        requires: { workflows: ['demo.run'] },
        permissions: { read: [], write: [], workflows: ['demo.run'] },
      }),
      ctx(),
    );
    expect(result.ok).toBe(true);
  });

  it('**it is declared but not granted → it is reported** (rule 3 may not have an exception)', () => {
    const result = validateCard(
      manifest({
        requires: { workflows: ['demo.run'] },
        permissions: { read: [], write: [] },
      }),
      ctx(),
    );
    expect(result.ok).toBe(false);
    const issues = byRule(result, 3);
    expect(issues.some((i) => i.path === 'requires.workflows')).toBe(true);
  });
});

describe('the 13 rules of contract §9', () => {
  it('rule 1: the apiVersion is not a known version', () => {
    const result = validateCard(manifest({ apiVersion: 'devboard/v9' }), ctx());
    expect(byRule(result, 1)).toHaveLength(1);
  });

  it('rule 2: the id clashes with an installed card', () => {
    const result = validateCard(manifest({ id: 'other-card' }), ctx());
    expect(byRule(result, 2)).toHaveLength(1);
  });

  it('rule 3: requires holds an item that permissions.read does not cover', () => {
    const result = validateCard(
      manifest({ requires: { tags: ['mem.usage'] }, permissions: { read: ['cpu.usage'], write: [] } }),
      ctx(),
    );
    expect(byRule(result, 3)).toHaveLength(1);
  });

  it('rule 4: a tag in permissions.read is neither in the core vocabulary nor custom.*', () => {
    const result = validateCard(
      manifest({ permissions: { read: ['foo.bar'], write: [] } }),
      ctx(),
    );
    expect(byRule(result, 4)).toHaveLength(1);
  });

  it('rule 4: a custom.* quantity is allowed', () => {
    const result = validateCard(
      manifest({ permissions: { read: ['custom.rk3588-atk.x'], write: [] } }),
      ctx(),
    );
    expect(byRule(result, 4)).toHaveLength(0);
  });

  it('rule 5: the current board pack does not offer an action of the write permissions', () => {
    const result = validateCard(
      manifest({ permissions: { read: [], write: ['nope.set'] } }),
      ctx(),
    );
    expect(byRule(result, 5)).toHaveLength(1);
    expect(result.errors.some((e) => e.rule === 5)).toBe(true);
  });

  it('rule 5: **offline it is not invalid, it is unverified**', () => {
    const result = validateCard(
      manifest({ permissions: { read: [], write: ['nope.set'] } }),
      ctx({ availableActions: null }),
    );
    expect(result.errors.some((e) => e.rule === 5)).toBe(false);
    const warning = result.warnings.find((w) => w.rule === 5);
    expect(warning).toBeTruthy();
    expect(warning?.message).toMatch(/unverified/);
  });

  it('rule 6: a wildcard is not allowed in the write permissions', () => {
    const result = validateCard(
      manifest({ permissions: { read: [], write: ['backlight.*'] } }),
      ctx(),
    );
    expect(byRule(result, 6)).toHaveLength(1);
  });

  it('rule 7: the target of a board action must be in permissions.write', () => {
    const result = validateCard(
      manifest({
        permissions: { read: [], write: [] },
        actions: [{ id: 'a', label: 'A', target: 'backlight.set' }],
      }),
      ctx(),
    );
    expect(byRule(result, 7)).toHaveLength(1);
  });

  it('rule 8: min_w/min_h may not be greater than w/h', () => {
    const result = validateCard(manifest({ layout: { w: 3, h: 2, min_w: 4, min_h: 1 } }), ctx());
    expect(byRule(result, 8)).toHaveLength(1);
  });

  it('rule 9: the entry file does not exist', () => {
    const result = validateCard(manifest(), ctx({ fileExists: () => false }));
    expect(byRule(result, 9)).toHaveLength(1);
  });

  it('rule 10: an unknown field → **it is reported while parsing** (it is not silently ignored)', () => {
    expect(() => parseManifest({ ...(manifest() as object), network: true }, 'cpu-usage')).toThrow(
      /network/,
    );
  });

  it('rule 11: a card may not declare danger / readback → it is reported while parsing', () => {
    expect(() =>
      parseManifest(
        {
          ...(manifest() as object),
          actions: [{ id: 'a', label: 'A', target: 'backlight.set', danger: 'destructive' }],
        },
        'cpu-usage',
      ),
    ).toThrow(/danger/);
  });

  it('rule 12: a view action (without a target) may not appear in permissions.write', () => {
    const result = validateCard(
      manifest({
        permissions: { read: [], write: ['view-only'] },
        actions: [{ id: 'view-only', label: 'view action' }],
      }),
      ctx(),
    );
    expect(byRule(result, 12)).toHaveLength(1);
  });

  it('rule 11: a **hand-written** manifest carries danger → the validator stops it as well (not only the parser)', () => {
    const raw = {
      ...(manifest() as object),
      actions: [{ id: 'a', label: 'A', target: 'backlight.set', danger: 'destructive' }],
    } as unknown as CardManifest;
    expect(byRule(validateCard(raw, ctx()), 11)).toHaveLength(1);
  });

  it('rule 13: a string parameter in a **hand-written** manifest has no maxLength → the validator stops it as well', () => {
    const raw = {
      ...(manifest() as object),
      actions: [
        { id: 'a', label: 'A', target: 'backlight.set', params: { value: { type: 'string' } } },
      ],
    } as unknown as CardManifest;
    expect(byRule(validateCard(raw, ctx()), 13)).toHaveLength(1);
  });

  it('rule 13: a string parameter has no maxLength → it is reported while parsing', () => {
    expect(() =>
      parseManifest(
        {
          ...(manifest() as object),
          actions: [
            {
              id: 'a',
              label: 'A',
              target: 'backlight.set',
              params: { value: { type: 'string' } },
            },
          ],
        },
        'cpu-usage',
      ),
    ).toThrow(/maxLength/);
  });

  it('rule 13: the type of a parameter is not in the closed set → it is reported while parsing', () => {
    expect(() =>
      parseManifest(
        {
          ...(manifest() as object),
          actions: [
            {
              id: 'a',
              label: 'A',
              target: 'backlight.set',
              params: { value: { type: 'blob' } },
            },
          ],
        },
        'cpu-usage',
      ),
    ).toThrow(/type/);
  });
});

describe('the overall shape of the validation result', () => {
  it('a valid card → ok, and no error', () => {
    const result = validateCard(manifest(), ctx());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('resolved gives the resolved manifest', () => {
    const result = validateCard(manifest(), ctx());
    expect(result.resolved.tags).toEqual(['cpu.usage']);
    expect(result.resolved.actions).toEqual([]);
    expect(result.resolved.layout).toEqual({ w: 3, h: 2, min_w: 2, min_h: 1 });
  });

  it('the manifest has no layout → resolved.layout is null', () => {
    const raw = manifest();
    delete (raw as { layout?: unknown }).layout;
    const result = validateCard(raw, ctx());
    expect(result.resolved.layout).toBeNull();
  });
});
