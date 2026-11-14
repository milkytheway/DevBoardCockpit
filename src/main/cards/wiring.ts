import { CardRegistry } from './registry';
import type { CardRoot } from './roots';
import { CardSessionManager, type RuntimeReader } from './session';
import type { CardServices } from './api-registry';
import { CardStorage } from './storage';
import { CardRuntimeLog } from './runtime-log';
import { createCardProtocol } from './protocol';
import { bridgeScriptFor } from './bridge-script';
import { cspScriptFor } from './csp-script';
import { LayoutStore } from './layout';
import { cardApis } from './api-registry';
import { parseManifest } from './manifest';
import { validateCard } from './validate';
import { aliasVars, themeCss } from '../../shared/theme/map';
import { baseStyleBlock } from '../../shared/theme/base-css';
import type { CardPermissions } from './permissions';
import type { CardInstanceInfo, CardRequest, CardResponse } from '../../shared/ipc-contract';
import { normalizeLayout } from '../../shared/layout';
import type { LayoutState } from '../../shared/layout';
import type { ThemeName } from '../../shared/theme/seed';
import { IPC } from '../../shared/ipc-contract';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { mimeFor } from './paths';

/**
 * 卡片宿主的**接线**：把注册表、会话、协议、存储、日志接成一坨。
 *
 * ── 为什么单独一个模块 ──
 *
 * `main/index.ts` 是 Electron 的入口（窗口、IPC、标题栏），
 * **它不该长成一张卡片接线图**。这里把「卡片怎么活起来」收在一处，
 * 入口只调三行：
 *
 * ```ts
 * const cards = createCardWiring({ … });
 * protocol.handle('cockpit', cards.protocol);
 * handle(IPC.cardsList, () => cards.list());
 * ```
 */
export interface CardWiringDeps {
  /** 卡片目录的两个根 */
  roots: CardRoot[];
  /** 读数的来源 */
  runtime: RuntimeReader;
  /** 推送通道（main → 页面 → 卡片） */
  broadcast: (channel: string, ...args: unknown[]) => void;
  /** 当前连接（v1 只有一条） */
  currentConnectionId: () => string | null;
  /** 当前连接的身份（给 `capabilities()` 用） */
  connectionInfo?: (connectionId: string | null) => { label: string; transport: string } | null;
  /** 这张卡的权限集（manifest + 已授权） */
  permsFor: (cardId: string) => CardPermissions;
  /**
   * 每张卡的写侧（动作执行器，M6）。
   *
   * 做成**工厂**：执行器要拿着**这张卡的授权**，而授权是每卡一份的。
   */
  actionsFor?: (cardId: string) => CardServices['actions'];
  /** 存储的根目录 */
  storageDir: string;
  /** 布局文件（**宿主记的账**：哪张卡在哪个格子里） */
  layoutFile: string;
  /** 外壳的构建产物目录（`cockpit://app/` 从这里伺服） */
  shellDir?: string;
  /** 外壳的 CSP（生产用；**开发时走 Vite，不用它**） */
  shellCsp?: string;
  /** 当前皮肤 */
  theme?: () => ThemeName;
  now?: () => number;
}

export interface CardWiring {
  registry: CardRegistry;
  sessions: CardSessionManager;
  storage: CardStorage;
  log: CardRuntimeLog;
  /** `cockpit://` 的处理器 */
  protocol: (request: Request) => Response;
  /** 装着的卡片（页面据此渲染卡片区） */
  list: () => CardInstanceInfo[];
  /** 卡片的一个请求 */
  handleRequest: (req: CardRequest) => Promise<CardResponse>;
  /** 读布局 */
  layoutGet: () => LayoutState;
  /** 存布局 */
  layoutSet: (state: LayoutState) => void;
  /** 重新发现卡片（热插拔） */
  refresh: () => void;
  /** 把一条 CSP 违规归到卡片的运行时日志 */
  captureCspViolation: (details: { message: string; sourceUrl: string }) => string | null;
  /** 停止监听 */
  stop: () => void;
}

export function createCardWiring(deps: CardWiringDeps): CardWiring {
  const theme = deps.theme ?? ((): ThemeName => 'dark');
  const now = deps.now ?? (() => Date.now());

  const registry = new CardRegistry({
    roots: deps.roots,
    loadManifest: (dir) => loadManifestOf(dir),
    validate: (manifest, dir) => {
      const result = validateManifest(manifest, dir, registry);
      return [...result.errors, ...result.warnings];
    },
  });

  const storage = new CardStorage({ dir: deps.storageDir });
  const log = new CardRuntimeLog({ now });
  const layout = new LayoutStore({ file: deps.layoutFile, now });
  /** 卡片 id → 当前实例 id（用来发现「实例换了」） */
  const instanceByCard = new Map<string, string>();

  const sessions = new CardSessionManager({
    runtime: deps.runtime,
    permsFor: deps.permsFor,
    now,
    push: (instanceId, payload) => {
      deps.broadcast(IPC.cardsEvent, instanceId, payload);
    },
    storageFor: (cardId) => ({
      get: (key) => storage.get(cardId, key),
      set: (key, value) => storage.set(cardId, key, value),
      remove: (key) => storage.remove(cardId, key),
      keys: () => storage.keys(cardId),
      clear: () => storage.clear(cardId),
    }),
    logFor: (cardId) => (level, message) => {
      log.append(cardId, { source: 'card', level, message });
    },
    ...(deps.actionsFor === undefined ? {} : { actionsFor: deps.actionsFor }),
    connectionInfo: deps.connectionInfo,
  });

  const cardProtocol = createCardProtocol({
    dirOfInstance: (instanceId) => registry.dirOfInstance(instanceId),
    entryOfInstance: (instanceId) => registry.entryOfInstance(instanceId) ?? 'index.html',
    bridgeScript: (instanceId) => bridgeScriptFor(cardApis(), instanceId),
    cspScript: (instanceId) => cspScriptFor(instanceId),
    themeStyle: () => `${themeCss(theme(), ':root')}\n${baseStyleBlock()}`,
  });

  /**
   * `cockpit://` 的处理器：`app` 是外壳，`card` 是卡片。
   *
   * **为什么外壳也走协议**：`file://` 上的 `'self'` **匹配不到任何东西**
   * （本地 scheme 的 origin 是 opaque 的）——外壳想用 CSP 就得有个真源。
   * → 生产的外壳从 `cockpit://app/` 伺服 ✓
   */
  const protocol = (request: Request): Response => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (url.hostname === 'app') return serveShell(url, deps.shellDir, deps.shellCsp);
    return cardProtocol(request);
  };

  return {
    registry,
    sessions,
    storage,
    log,
    protocol,
    list: () => {
      const cards = registry.cards();
      const connectionId = deps.currentConnectionId();
      const out: CardInstanceInfo[] = [];
      for (const card of cards) {
        const { instanceId, url } = registry.instanceFor(card.cardId, connectionId);
        const previous = instanceByCard.get(card.cardId);
        // **实例换了（连接变了）→ 旧会话要关掉**：
        // 它的订阅还挂在运行时上，不关就永远解不掉（RF-4）
        if (previous !== undefined && previous !== instanceId) {
          sessions.close(previous);
        }
        instanceByCard.set(card.cardId, instanceId);
        log.bind(instanceId, card.cardId);
        out.push({
          instanceId,
          cardId: card.cardId,
          url,
          connectionId,
          degraded: card.issues.some((i) => i.severity === 'error'),
          // **卡片自报的默认尺寸**（manifest 的 layout.w/h）——
          // 页面把卡摆进主区时用它（作者的心愿，宿主读得到 manifest）
          ...(card.manifest.layout === undefined
            ? {}
            : {
                layout: {
                  w: card.manifest.layout.w ?? 3,
                  h: card.manifest.layout.h ?? 2,
                  ...(card.manifest.layout.min_w === undefined
                    ? {}
                    : { min_w: card.manifest.layout.min_w }),
                  ...(card.manifest.layout.min_h === undefined
                    ? {}
                    : { min_h: card.manifest.layout.min_h }),
                },
              }),
        });
      }
      // 卡片没了（被删了）→ 它的会话也要关
      const alive = new Set(cards.map((c) => c.cardId));
      for (const [cardId, instanceId] of [...instanceByCard]) {
        if (!alive.has(cardId)) {
          sessions.close(instanceId);
          instanceByCard.delete(cardId);
        }
      }
      return out;
    },
    handleRequest: (req) => sessions.handle(req),
    // ── 布局 = **主区摆了哪些卡** ──
    //
    // v3：一个布局，没有视图。**主区默认是空的**——用户从左二级的卡片目录
    // 里点哪张才摆进来（`units` 里只有摆过的卡）。
    //
    // → 宿主的活只剩两件：
    //   ① 读出来（v1/v2 旧文件也读得出来 ✓ 在 `normalizeLayout` 里）
    //   ② 存的时候**别把没装的卡的格子丢了**（卡片卸载了再装回来，位置还在）
    layoutGet: () => layout.get(),
    layoutSet: (input) => {
      const connectionId = deps.currentConnectionId();
      const installed = new Set(
        registry.cards().map((c) => layoutKey(c.cardId, connectionId)),
      );
      const previous = layout.get();
      const state = normalizeLayout(input, now());
      const incoming = new Set(state.units.map((u) => layoutKey(u.cardId, u.connectionId)));
      // **没装着的卡**（已卸载但用户摆过）→ 保留它的格子，装回来位置还在
      const kept = previous.units.filter(
        (u) => !installed.has(layoutKey(u.cardId, u.connectionId)) && !incoming.has(layoutKey(u.cardId, u.connectionId)),
      );
      layout.set({ ...state, units: [...kept, ...state.units], updatedAt: now() });
    },
    refresh: () => {
      registry.refresh();
    },
    captureCspViolation: (details) => log.attributeCspViolation(details),
    stop: () => undefined,
  };
}

/* ── 两个小工具 ── */

/** 布局单元的键（`(cardId, connectionId)`） */
function layoutKey(cardId: string, connectionId: string | null): string {
  return `${cardId}::${connectionId ?? ''}`;
}

/** 外壳的静态文件（`cockpit://app/…`） */
function serveShell(url: URL, shellDir: string | undefined, shellCsp: string | undefined): Response {
  if (shellDir === undefined) return new Response('not found', { status: 404 });
  const rel = url.pathname === '/' || url.pathname === '' ? 'index.html' : url.pathname.slice(1);
  // **外壳自己的目录也要防穿越**（它伺服的是构建产物，不是卡片）
  const resolved = resolve(shellDir, rel);
  if (resolved !== shellDir && !resolved.startsWith(shellDir + sep)) {
    return new Response('forbidden', { status: 403 });
  }
  if (!existsSync(resolved)) return new Response('not found', { status: 404 });
  const body = readFileSync(resolved);
  const headers: Record<string, string> = { 'Content-Type': mimeFor(resolved) };
  if (shellCsp !== undefined) headers['Content-Security-Policy'] = shellCsp;
  return new Response(body, { status: 200, headers });
}

function loadManifestOf(dir: string): ReturnType<typeof parseManifest> {
  const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as unknown;
  return parseManifest(raw, dir);
}

function validateManifest(
  manifest: Parameters<typeof validateCard>[0],
  dir: string,
  registry: CardRegistry,
): ReturnType<typeof validateCard> {
  return validateCard(manifest, {
    // **离线**：连不上板 → 动作与 tag 的存在性「未验证」，不是「不合法」
    availableTags: null,
    availableActions: null,
    // 规则 2 比的是 **manifest 的 id**，而且**要排除自己**：
    // 比目录名的话，卡片**改一次文件**（热更新必然触发一次 refresh）
    // 就会在第二次 refresh 里把自己判成「重名」→ 卡片无缘无故变成 degraded。
    installedCardIds: registry
      .cards()
      .filter((c) => c.dir !== dir)
      .map((c) => c.manifest.id),
    fileExists: (rel) => existsSync(join(dir, rel)),
  });
}

/** 主题切换时，把新的别名值推给所有卡片（不重载 iframe） */
export function themePush(theme: ThemeName): Record<string, string> {
  return aliasVars(theme);
}
