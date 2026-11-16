import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardsDeclaringWorkflow } from '../../../src/main/cards/flow-grants';

/**
 * **哪些内置卡声明了这个流程**（流程的卡级授权那一维 ✓）。
 *
 * ── 为什么要有这一层 ──
 *
 * → 契约 `spec/03` §2.4：有效流程权限 = **声明 ∩ 已授权** ✓ → **三层** ✓
 *   （manifest 声明 ✓ → **用户授过这张卡** ✓ → 用户批过这个包 ✓）。
 * → **内置卡没有「装卡」那一步** ✓ → **卡级授权从哪来** ✗
 *   → **流程包批准的那一次** ✓（人点的 ✓ —— **CLI 问过「会做哪些事」** ✓）。
 * → 所以批准流程包时，**要把这个流程授给声明了它的内置卡** ✓。
 *
 * → **只给声明了它的卡** ✓ —— **不多授一张** ✗（授权面变大 ✗）。
 */
function cardWith(dir: string, cardId: string, workflows: string[]): void {
  const cardDir = join(dir, cardId);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(
    join(cardDir, 'manifest.json'),
    JSON.stringify(
      {
        apiVersion: 'devboard/v1',
        kind: 'Card',
        id: cardId,
        name: cardId,
        version: '1.0.0',
        entry: 'index.html',
        requires: { workflows },
        permissions: { read: [], write: [], workflows },
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('声明了某个流程的卡', () => {
  it('**找出声明了它的卡** ✓', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cards-'));
    cardWith(dir, 'build-deploy', ['hello-kernel.build-run']);
    cardWith(dir, 'other', ['meminfo-user.build-run']);
    expect(cardsDeclaringWorkflow([{ dir, kind: 'builtin' }], 'hello-kernel.build-run')).toEqual([
      'build-deploy',
    ]);
  });

  it('**没声明它的卡不给** ✓（**授权面不许变大** ✗）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cards-'));
    cardWith(dir, 'other', ['meminfo-user.build-run']);
    expect(cardsDeclaringWorkflow([{ dir, kind: 'builtin' }], 'hello-kernel.build-run')).toEqual([]);
  });

  it('**manifest 坏了的卡不算** ✓（**不拖垮其余** ✓ —— 同「坏文件只跳过一个」✓）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cards-'));
    cardWith(dir, 'good', ['hello-kernel.build-run']);
    const bad = join(dir, 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'manifest.json'), '{ 这不是 json', 'utf8');
    expect(cardsDeclaringWorkflow([{ dir, kind: 'builtin' }], 'hello-kernel.build-run')).toEqual([
      'good',
    ]);
  });

  it('**目录不存在 → 空清单** ✓（**不猜** ✓）', () => {
    expect(
      cardsDeclaringWorkflow([{ dir: join(tmpdir(), 'no-such-cards-dir'), kind: 'builtin' }], 'x'),
    ).toEqual([]);
  });
});
