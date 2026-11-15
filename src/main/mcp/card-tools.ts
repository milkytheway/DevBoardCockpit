import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConsentQueue, dirSnapshot } from '../cards/consent';
import { parseManifest } from '../cards/manifest';
import type { CardRegistry } from '../cards/registry';
import type { GrantStore } from '../cards/grants';
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
 * ── 授权要重新征求的两种情况（契约 §2.3 ✓）──
 *
 * | 情况 | 处置 |
 * |---|---|
 * | 这张卡**要写**的动作**人还没授过** ✓ | **不装** ✓ → `needs_consent` ✓ |
 * | 装的是**已装过**的卡、但 `permissions.write` **不同** ✓ | **同样要重新征求** ✓（**两条路在授权上没有区别** ✓ —— 否则「换个方式就绕过授权」了 ✓） |
 */
export interface CardToolDeps {
  /** 用户卡片根（**装到这里** ✓） */
  cardsRoot: string;
  /** 卡片注册表（**重载** ✓） */
  registry: CardRegistry;
  /** 授权账（**记批准 / 清授权** ✓） */
  grants?: GrantStore;
  /** 同意队列（**待人批的** ✓） */
  pending?: ConsentQueue;
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
  /** 要人授权 ✓ */
  needs_consent?: boolean;
  consent_id?: string;
  pending?: Array<{ action: string; danger: 'reversible' | 'destructive'; label?: string; guard?: unknown }>;
  /** 人拒绝了 ✓ */
  denied?: Array<{ action: string; danger: 'reversible' | 'destructive'; label?: string; guard?: unknown }>;
  reason?: 'invalid_params' | 'not_found' | 'invalid' | 'needs_consent' | 'denied' | 'failed';
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

  // ── 这个动作存不存在 ──
  const declaredWrite = manifest.permissions.write;

  // ── 要人授权的动作 = 「要写的」减「人已授过的」✓ ──
  const granted = new Set(deps.grants?.actionIds(cardId) ?? []);
  const needConsent = declaredWrite.filter((id) => !granted.has(id));

  // ── 同意队列有货吗 ──
  const snapshot = dirSnapshot(path);
  const queue = deps.pending;

  if (needConsent.length > 0) {
    // **已经批过、且快照对得上** ✓ → **直接装** ✓
    if (queue !== undefined) {
      for (const req of queue.forCard(cardId)) {
        if (queue.consume(req.id, snapshot)) {
          // **批过了 → 记进授权账** ✓（**这一步不能省** ✓ —— 否则装上了也没权限 ✗）
          for (const item of req.pending) {
            deps.grants?.grant(cardId, item.action, undefined);
          }
          return doInstall(deps, path, target, cardId);
        }
      }
    }
    // **没批过 → 先问人** ✓（**不装** ✓）
    const pendingItems = needConsent.map((id) => {
      const action = (deps.packActions?.() ?? []).find((a) => a.id === id);
      return {
        action: id,
        danger: action?.danger ?? ('destructive' as const),
        ...(action?.label === undefined ? {} : { label: action.label }),
        ...(action?.guard === undefined ? {} : { guard: action.guard }),
      };
    });
    const req = queue?.request(cardId, snapshot, pendingItems);
    return {
      ok: false,
      installed: false,
      card_id: cardId,
      reason: 'needs_consent',
      needs_consent: true,
      ...(req === undefined ? {} : { consent_id: req.id }),
      pending: pendingItems,
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
    // **授权账一并清** ✓（动作 + 流程两个维度 ✓ —— 整张清 ✓ 不漏 ✓）
    deps.grants?.revokeAll(cardId);
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
