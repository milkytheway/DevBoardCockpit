import { describe, it, expect } from 'vitest';
import { validateCard, type ValidateCardContext } from '../../../src/main/cards/validate';
import { parseManifest, type CardManifest } from '../../../src/main/cards/manifest';

/**
 * 卡片 manifest 的 **13 条校验规则**（契约 `spec/03` §九）。
 *
 * ── 为什么规则号要留着 ──
 *
 * 报告里写「这张卡不合法」没用；写「**规则 5**：这个动作当前板型包里没有」才有用——
 * 人能照着改，agent 能照着改。
 *
 * ── 「未验证」≠「不合法」 ──
 *
 * 规则 5 在**连不上板**的时候没法查——那时候**不是**这张卡有问题，
 * 是**我们还没查**。所以离线时它进 `warnings`（琥珀），不进 `errors`（红）。
 */

function manifest(over: Record<string, unknown> = {}): CardManifest {
  return parseManifest(
    {
      apiVersion: 'devboard/v1',
      kind: 'Card',
      id: 'cpu-usage',
      name: 'CPU 占用率',
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

/** 连上了板子的上下文 */
function ctx(over: Partial<ValidateCardContext> = {}): ValidateCardContext {
  return {
    availableTags: ['cpu.usage', 'mem.usage'],
    availableActions: ['backlight.set'],
    installedCardIds: ['other-card'],
    fileExists: (rel) => rel === 'index.html',
    ...over,
  };
}

/** 找某个规则号的 issue */
function byRule(
  result: { errors: { rule: number; path?: string }[]; warnings: { rule: number; path?: string }[] },
  rule: number,
) {
  return [...result.errors, ...result.warnings].filter((i) => i.rule === rule);
}

describe('规则 3 的流程那一半（评审 35 的 V2-C2）', () => {
  it('`requires.workflows` 被 `permissions.workflows` 覆盖 → 通过', () => {
    const result = validateCard(
      manifest({
        requires: { workflows: ['demo.run'] },
        permissions: { read: [], write: [], workflows: ['demo.run'] },
      }),
      ctx(),
    );
    expect(result.ok).toBe(true);
  });

  it('**声明了却没授权 → 报错**（规则 3 不能有例外口子 ✓）', () => {
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

describe('契约 §九 的 13 条规则', () => {
  it('规则 1：apiVersion 不是已知版本', () => {
    const result = validateCard(manifest({ apiVersion: 'devboard/v9' }), ctx());
    expect(byRule(result, 1)).toHaveLength(1);
  });

  it('规则 2：id 与已装卡片冲突', () => {
    const result = validateCard(manifest({ id: 'other-card' }), ctx());
    expect(byRule(result, 2)).toHaveLength(1);
  });

  it('规则 3：requires 里有没被 permissions.read 覆盖的项', () => {
    const result = validateCard(
      manifest({ requires: { tags: ['mem.usage'] }, permissions: { read: ['cpu.usage'], write: [] } }),
      ctx(),
    );
    expect(byRule(result, 3)).toHaveLength(1);
  });

  it('规则 4：permissions.read 里的 tag 不在核心词表、也不是 custom.*', () => {
    const result = validateCard(
      manifest({ permissions: { read: ['foo.bar'], write: [] } }),
      ctx(),
    );
    expect(byRule(result, 4)).toHaveLength(1);
  });

  it('规则 4：custom.* 的量是允许的', () => {
    const result = validateCard(
      manifest({ permissions: { read: ['custom.rk3588-atk.x'], write: [] } }),
      ctx(),
    );
    expect(byRule(result, 4)).toHaveLength(0);
  });

  it('规则 5：写权限里的动作当前板型包没有', () => {
    const result = validateCard(
      manifest({ permissions: { read: [], write: ['nope.set'] } }),
      ctx(),
    );
    expect(byRule(result, 5)).toHaveLength(1);
    expect(result.errors.some((e) => e.rule === 5)).toBe(true);
  });

  it('规则 5：**离线时不是不合法，是没验证**', () => {
    const result = validateCard(
      manifest({ permissions: { read: [], write: ['nope.set'] } }),
      ctx({ availableActions: null }),
    );
    expect(result.errors.some((e) => e.rule === 5)).toBe(false);
    const warning = result.warnings.find((w) => w.rule === 5);
    expect(warning).toBeTruthy();
    expect(warning?.message).toMatch(/未验证/);
  });

  it('规则 6：写权限里不许通配符', () => {
    const result = validateCard(
      manifest({ permissions: { read: [], write: ['backlight.*'] } }),
      ctx(),
    );
    expect(byRule(result, 6)).toHaveLength(1);
  });

  it('规则 7：板型动作的 target 必须在 permissions.write 里', () => {
    const result = validateCard(
      manifest({
        permissions: { read: [], write: [] },
        actions: [{ id: 'a', label: 'A', target: 'backlight.set' }],
      }),
      ctx(),
    );
    expect(byRule(result, 7)).toHaveLength(1);
  });

  it('规则 8：min_w/min_h 不能大于 w/h', () => {
    const result = validateCard(manifest({ layout: { w: 3, h: 2, min_w: 4, min_h: 1 } }), ctx());
    expect(byRule(result, 8)).toHaveLength(1);
  });

  it('规则 9：entry 文件不存在', () => {
    const result = validateCard(manifest(), ctx({ fileExists: () => false }));
    expect(byRule(result, 9)).toHaveLength(1);
  });

  it('规则 10：未知字段 → **解析阶段就报错**（不静默忽略）', () => {
    expect(() => parseManifest({ ...(manifest() as object), network: true }, 'cpu-usage')).toThrow(
      /network/,
    );
  });

  it('规则 11：卡片不许声明 danger / readback → 解析阶段报错', () => {
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

  it('规则 12：视图内动作（没有 target）不许出现在 permissions.write 里', () => {
    const result = validateCard(
      manifest({
        permissions: { read: [], write: ['view-only'] },
        actions: [{ id: 'view-only', label: '视图内动作' }],
      }),
      ctx(),
    );
    expect(byRule(result, 12)).toHaveLength(1);
  });

  it('规则 11：**手写的** manifest 带 danger → 校验器也拦（不只靠解析器）', () => {
    const raw = {
      ...(manifest() as object),
      actions: [{ id: 'a', label: 'A', target: 'backlight.set', danger: 'destructive' }],
    } as unknown as CardManifest;
    expect(byRule(validateCard(raw, ctx()), 11)).toHaveLength(1);
  });

  it('规则 13：**手写的** manifest 里 string 参数没有 maxLength → 校验器也拦', () => {
    const raw = {
      ...(manifest() as object),
      actions: [
        { id: 'a', label: 'A', target: 'backlight.set', params: { value: { type: 'string' } } },
      ],
    } as unknown as CardManifest;
    expect(byRule(validateCard(raw, ctx()), 13)).toHaveLength(1);
  });

  it('规则 13：string 参数没有 maxLength → 解析阶段报错', () => {
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

  it('规则 13：参数 type 不在封闭取值里 → 解析阶段报错', () => {
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

describe('校验结果的整体形状', () => {
  it('合法的卡 → ok，且没有 error', () => {
    const result = validateCard(manifest(), ctx());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('resolved 给出解析出来的清单', () => {
    const result = validateCard(manifest(), ctx());
    expect(result.resolved.tags).toEqual(['cpu.usage']);
    expect(result.resolved.actions).toEqual([]);
    expect(result.resolved.layout).toEqual({ w: 3, h: 2, min_w: 2, min_h: 1 });
  });

  it('manifest 没有 layout → resolved.layout 是 null', () => {
    const raw = manifest();
    delete (raw as { layout?: unknown }).layout;
    const result = validateCard(raw, ctx());
    expect(result.resolved.layout).toBeNull();
  });
});
