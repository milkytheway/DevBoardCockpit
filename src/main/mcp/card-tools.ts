import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from '../cards/manifest';
import type { CardRegistry } from '../cards/registry';
/** 动作的**最小视图**（**只要装卡要用的那几项** ✓ —— 不给整份定义 ✓） */
export interface PackActionView {
  id: string;
  danger: 'reversible' | 'destructive';
  label?: string;
  guard?: Record<string, { min?: number; max?: number }>;
}

/**
 * **装卡与卸卡**（契约 `spec/04` §2.3 ✓ · ADR-D40 ✓）。
 *
 * ── 装卡 = 复制目录 + 触发热重载 ✓ ──
 *
 * → **复制到用户卡片根** ✓（**不是内置目录** ✓ —— 内置在应用目录里 ✓ 是只读的 ✓）。
 * → **同 id 重复安装 = 替换** ✓（契约 §2.3 ✓ —— **不是新增** ✓）。
 *
 * ── **装卡不再要「同意」** ✓（契约 §2.3 · ADR-D46 ✓）──
 *
 * → **板型包说了算** ✓：**板上能做什么由板型包声明** ✓；
 *   **这张卡能做什么由它的 manifest 声明** ✓ —— **会话层守着** ✓
 *   （**声明之外的一律 denied** ✓ —— **卡片说一套做一套是不行的** ✓）。
 * → **用户点一下就是同意** ✓ → **不再有第二道「你授过这张卡吗」** ✓。
 * → **危险的那一步仍然要问** ✓（**destructive 动作由人点** ✓ —— 那是 agent 与人的分界 ✓）。
 */
export interface CardToolDeps {
  /** 用户卡片根（**装到这里** ✓） */
  cardsRoot: string;
  /** 卡片注册表（**重载** ✓） */
  registry: CardRegistry;
  /** 当前板型包声明的动作（**判断「这个动作存不存在」** ✓） */
  packActions?: () => PackActionView[];
  /** 内置卡 id（**内置卡不许删** ✓） */
  builtinIds?: string[];
}

/** 装卡的结果（契约 §2.3 的三个形状 ✓） */
export interface InstallCardResult {
  ok: boolean;
  installed: boolean;
  card_id?: string;
  degraded?: boolean;
  missing?: string[];
  reason?: 'invalid_params' | 'not_found' | 'invalid' | 'failed';
  detail?: string;
}

/** 卸卡的结果 */
export interface UninstallCardResult {
  ok: boolean;
  reason?: 'not_found' | 'denied' | 'failed';
  detail?: string;
}

/**
 * **装一张卡**（契约 §2.3 ✓）。
 *
 * @param path 卡片目录（**绝对路径** ✓）
 */
export function installCard(deps: CardToolDeps, path: string): InstallCardResult {
  const manifestPath = join(path, 'manifest.json');
  // **没有 manifest → 不装** ✓（**不是「装个空卡」** ✓）
  if (!existsSync(manifestPath)) {
    return { ok: false, installed: false, reason: 'invalid', detail: '这个目录里没有 manifest.json' };
  }

  // ── 解析 manifest ──
  let manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, path);
  } catch (err) {
    return {
      ok: false,
      installed: false,
      reason: 'invalid',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const cardId = manifest.id;
  const target = join(deps.cardsRoot, cardId);

  // ── **这张卡要写的动作是不是真的存在** ✓（**板型包说了算** ✓）──
  // → **不存在 → 装不了** ✓（**不装一张一半是空的卡** ✓ —— 契约 §2.3 ✓）
  const known = new Set((deps.packActions?.() ?? []).map((a) => a.id));
  const missing = manifest.permissions.write.filter((id) => !known.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      installed: false,
      card_id: cardId,
      reason: 'invalid',
      detail: `板型包里没有这些动作：${missing.join('、')}`,
    };
  }

  return doInstall(deps, path, target, cardId);
}

/** **真的装** ✓ —— 复制目录 + 重载 ✓ */
function doInstall(
  deps: CardToolDeps,
  path: string,
  target: string,
  cardId: string,
): InstallCardResult {
  try {
    mkdirSync(deps.cardsRoot, { recursive: true });
    // **同 id 重复安装 = 替换** ✓（契约 §2.3 ✓）→ **先删旧的** ✓
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync(path, target, { recursive: true });
    // **热重载** ✓（目录变了 ✓ → watcher 会发现 ✓ → 这里再刷一次 ✓ 免得等那一拍 ✓）
    deps.registry.refresh();
    return { ok: true, installed: true, card_id: cardId, degraded: false, missing: [] };
  } catch (err) {
    return {
      ok: false,
      installed: false,
      card_id: cardId,
      reason: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * **卸一张卡**（契约 §2.3 ✓）。
 *
 * → **只删用户卡片根下的** ✓（**内置卡删不掉** ✓ —— 它在应用目录里 ✓）。
 * → **授权账一并清** ✓（否则装回来就带着旧的授权 ✗ —— 那不是「重新装」✓）。
 */
export function uninstallCard(deps: CardToolDeps, cardId: string): UninstallCardResult {
  // **内置卡 → 不许删** ✓
  if ((deps.builtinIds ?? []).includes(cardId)) {
    return { ok: false, reason: 'denied', detail: '内置卡不能删' };
  }
  const dir = deps.registry.dirOf(cardId);
  if (dir === null) {
    return { ok: false, reason: 'not_found', detail: `没有这张卡：${cardId}` };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    deps.registry.refresh();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
