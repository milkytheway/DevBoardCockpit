import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCardDirs, type CardRoot } from './roots';

/**
 * **哪些卡声明了这个流程**（流程的**卡级授权**那一维 ✓）。
 *
 * ── 为什么要有这一层 ──
 *
 * → 契约 `spec/03` §2.4：有效流程权限 = **声明 ∩ 已授权** ✓ → **三层** ✓：
 *   **manifest 声明** ✓ → **用户授过这张卡** ✓ → **用户批过这个包** ✓。
 * → **内置卡没有「装卡」那一步** ✓ → **卡级授权从哪来** ✗
 *   → **流程包批准的那一次** ✓（人点的 ✓ —— CLI 先把「它会做哪些事」打出来 ✓）。
 * → 所以：**批准流程包时，把这个流程授给声明了它的卡** ✓。
 *
 * ── 只给声明了它的 ──
 *
 * → **不多授一张** ✗（授权面变大 ✗ —— **没声明的卡突然能跑流程** ✗）。
 * → **坏 manifest 的卡跳过** ✓（**不拖垮其余** ✓ —— 同「坏文件只跳过一个」✓）。
 */
export function cardsDeclaringWorkflow(roots: CardRoot[], workflowId: string): string[] {
  const found: string[] = [];
  for (const card of listCardDirs(roots)) {
    try {
      const raw = JSON.parse(readFileSync(join(card.dir, 'manifest.json'), 'utf8')) as {
        permissions?: { workflows?: unknown };
      };
      const ids = raw.permissions?.workflows;
      if (Array.isArray(ids) && ids.includes(workflowId)) found.push(card.cardId);
    } catch {
      // **manifest 读不出来 → 跳过这张卡** ✓（**不是「它没声明」** ✓ —— 是不确定 ✓）
    }
  }
  return found;
}
