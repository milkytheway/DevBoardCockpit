import type { PermissionStore } from '../permissions/policy';
import { cardState, type CardState } from '../cards/state';
import { validateCardAt } from '../cards/validate-at';
import type { McpCardEntry, McpHostDeps, McpValidateResult } from '../mcp/host';
import type { CardRegistry } from '../cards/registry';
import type { CardRuntimeLog } from '../cards/runtime-log';
import type { TagRuntime } from '../tags/runtime';
import type { ConnectionProfile } from '../profiles/schema';
import type { ConnectionCapabilities } from '../../shared/ipc-contract';
import type { TerminalManager } from '../terminal/manager';
import type { LayoutState } from '../../shared/layout';
import { capabilitiesFor } from '../hal/capabilities';
import type { AgentActionDeps } from './action-tools';

/**
 * **Shapes the host into what the MCP layer expects** ✓.
 *
 * ── 为什么有这一层 ──
 *
 * → **MCP 层不该知道宿主内部怎么组织的** ✓（它只认 `McpHostDeps` 那一组窄接口 ✓）。
 * → **判断全在宿主这一侧** ✓ —— MCP 层**只做转发与投影** ✓（契约 §六 ✓）。
 *
 * ── `connected` 的判据（**两条都要满足** ✓）──
 *
 * ① 它是**当前 tag 运行时那条连接**，**且**运行时状态是 `running` ✓
 *    —— **光看「运行时记着这个 profile」不够** ✓：连不上（`error` ✓）
 *    与已停下（`idle` ✓）时**那个 id 仍然留着** ✓ → 会误报 `true` ✗。
 * ② **或**它**开着终端会话** ✓。
 */
export interface McpHostWiring {
  /** 连接 profile 清单 */
  listProfiles: () => ConnectionProfile[];
  /** tag 运行时 */
  runtime: TagRuntime;
  /** 终端管理（**活会话** ✓） */
  terminal: TerminalManager;
  /** 卡片注册表 */
  cards: CardRegistry;
  /** 卡片运行时日志 */
  cardLog: CardRuntimeLog;
  /** 读布局（**宿主记的账** ✓ —— 与卡片侧同一份 ✓） */
  layoutGet: () => LayoutState;
  /** 存布局（**同一份账** ✓ —— 不另开一套 ✓） */
  layoutSet: (state: LayoutState) => void;
  /** agent 的动作执行依赖（**与卡片侧共用执行器** ✓） */
  agentActions: AgentActionDeps;
  /** 用户卡片根（**装卡到这里** ✓） */
  cardsRoot?: string;
  /** 授权账 */
  /** 同意队列（**待人批的** ✓） */
  /** 内置卡 id（**内置卡不许删** ✓） */
  builtinCardIds?: string[];
  /** **统一权限区**（设置页那张表 ✓ · ADR-D47 ✓） */
  permissions?: PermissionStore;
}

/** 拼出 MCP 层的宿主依赖 ✓ */
export function buildMcpHost(wiring: McpHostWiring): McpHostDeps {
  const { runtime, terminal, cards, cardLog } = wiring;

  return {
    pack: () => runtime.packView,
    readings: () => runtime.readings(),
    history: (tag, n) => runtime.sampleHistory(tag, n),
    refreshTag: async (tag) => {
      // **先定向采一次** ✓（契约 §2.1 ✓）—— 采不到也不炸 ✓（**没这个 tag 就是没这个 tag** ✓）
      await runtime.sampleTag(tag);
    },
    profiles: wiring.listProfiles,
    capabilities: (profile: ConnectionProfile): ConnectionCapabilities =>
      capabilitiesFor(profile),
    connected: (profileId: string): boolean => {
      // ① **当前运行时那条连接** ✓ —— **且状态是 `running`** ✓
      const status = runtime.status;
      if (status.state === 'running' && status.profileId === profileId) return true;
      // ② **或开着终端会话** ✓
      return terminal.liveProfileIds().includes(profileId);
    },
    // **当前运行时那条连接是哪个** ✓（**没有就是 `null`** ✓ —— 不猜 ✓）
    currentProfileId: (): string | null => runtime.status.profileId ?? null,
    cards: (): McpCardEntry[] =>
      cards.cards().map((card) => {
        const state: CardState = cardState({
          cardId: card.cardId,
          dir: card.dir,
          manifest: card.manifest,
          issues: card.issues,
          pack: runtime.packView,
          readings: runtime.readings(),
        });
        return {
          cardId: card.cardId,
          dir: card.dir,
          manifest: card.manifest,
          issues: card.issues,
          state: {
            installed_at: state.installed_at,
            status: state.status,
            degraded: state.degraded,
            missing_tags: state.missing_tags,
            unreadable_tags: state.unreadable_tags,
          },
        };
      }),
    cardDir: (cardId: string) => cards.dirOf(cardId),
    validateCard: (path: string): McpValidateResult =>
      validateCardAt({
        dir: path,
        pack: runtime.packView,
        readings: runtime.readings(),
        actionIds: runtime.packView?.actions ?? [],
        // **规则 2 比的是 manifest 的 id** ✓，**且要排除自己** ✓
        installedCardIds: cards
          .cards()
          .filter((c) => c.dir !== path)
          .map((c) => c.manifest.id),
      }),
    cardLog: (cardId: string) => cardLog.read(cardId),
    layout: (): LayoutState => wiring.layoutGet(),
    saveLayout: (state: LayoutState) => wiring.layoutSet(state),
    // **agent 的动作执行** ✓ —— **复用同一个执行器** ✓（卡片侧同一个 ✓）
    actions: wiring.agentActions,
    // **装卡与卸卡** ✓（契约 §2.3 ✓）
    ...(wiring.cardsRoot === undefined
      ? {}
      : {
          cardTools: {
            cardsRoot: wiring.cardsRoot,
            registry: cards,
            packActions: () => runtime.actionDefs,
            ...(wiring.builtinCardIds === undefined ? {} : { builtinIds: wiring.builtinCardIds }),
          },
        }),
  };
}
