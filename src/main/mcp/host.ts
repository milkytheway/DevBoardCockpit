import type { TagReading } from '../../shared/tag-reading';
import type { ConnectionProfile } from '../profiles/schema';
import type { ConnectionCapabilities } from '../../shared/ipc-contract';
import type { PackView } from '../tags/pack-view';
import type { CardManifest } from '../cards/manifest';
import type { CardIssue } from '../cards/validate';
import type { CardLogEntry } from '../cards/runtime-log';
import type { LayoutState } from '../../shared/layout';
import type { AgentActionDeps } from './action-tools';
import type { CardToolDeps } from './card-tools';

/**
 * **MCP 层的宿主依赖面**（`docs/04` §9.2.1 ✓ · ADR-D40 ✓）。
 *
 * ── 它是「薄封装」的形状 ──
 *
 * MCP 层**只做转发与投影** ✓ —— **不含任何业务判断** ✓
 * （判断都在宿主侧 ✓ —— 与卡片侧**共用同一套** ✓）。
 *
 * → **为什么用窄接口而不是直接给宿主对象** ✓：
 * 两边**形状会不一样** ✓（比如卡片侧不给 `audit_id` ✓ · agent 侧给 ✓）→
 * **直接搬同一份对象就等于把一侧的形状泄露给另一侧** ✗。
 *
 * → **每个依赖都是「一个函数」或「几个字段」** ✓ —— 不给内部对象 ✓。
 */
export interface McpHostDeps {
  /** 当前板型包的脱敏视图（**没有就是 `null`** ✓） */
  pack: () => PackView | null;
  /** 当前读数（**全部** ✓ —— 工具自己筛 ✓） */
  readings: () => TagReading[];
  /** 最近 n 个样本（**给 `sample_tag` 与 `describe_tag.history` ✓） */
  history: (tag: string, n: number) => TagSampleLike[];
  /** 定向采一次（**`sample_tag` 要先采 ✓**） */
  refreshTag: (tag: string) => Promise<void>;

  /** 连接 profile 清单 */
  profiles: () => ConnectionProfile[];
  /** 这条 profile 的连接级能力位 */
  capabilities: (profile: ConnectionProfile) => ConnectionCapabilities;
  /** **这条 profile 现在有活连接吗** ✓ */
  connected: (profileId: string) => boolean;

  /** 装着的卡片 */
  cards: () => McpCardEntry[];
  /** 卡片目录的绝对路径（**给 `validate_card` 用** ✓） */
  cardDir: (cardId: string) => string | null;
  /**
   * **校验一个卡片目录**（**不安装** ✓ —— 契约 §2.3 ✓）。
   *
   * → **判断在宿主侧** ✓（`cards/validate.ts` ✓ —— 规则是契约 §九 的 14 条 ✓）。
   */
  validateCard: (path: string) => McpValidateResult;
  /** 卡片的运行时日志 */
  cardLog: (cardId: string) => CardLogEntry[];
  /** 当前布局 */
  layout: () => LayoutState;
  /** 保存布局 */
  saveLayout: (state: LayoutState) => void;
  /**
   * **agent 的动作执行依赖**（**写侧** ✓ —— 契约 §2.4 ✓）。
   *
   * → **复用同一个执行器** ✓（卡片侧同一个 ✓ —— 七步链只有一处 ✓）。
   */
  actions: AgentActionDeps;
  /** 装卡与卸卡（**契约 §2.3** ✓）—— **没接就不提供这两个工具** ✓ */
  cardTools?: CardToolDeps;
}

/** 一个样本（**与 `TagStore` 的那个同形** ✓ —— 宿主侧换个类型也不改形状 ✓） */
export interface TagSampleLike {
  value: number | string | boolean | null;
  unit: string;
  status: TagReading['status'];
  at: number;
}

/** 宿主侧给 MCP 的卡片条目（**已经算好状态了** ✓ —— 判断在宿主侧 ✓） */
export interface McpCardEntry {
  /** 卡片 id = 目录名 ✓ */
  cardId: string;
  dir: string;
  manifest: CardManifest;
  issues: CardIssue[];
  /** 这张卡在当前板上的状态（**宿主侧算好** ✓） */
  state: {
    installed_at: number;
    status: 'ok' | 'degraded' | 'invalid';
    degraded: boolean;
    missing_tags: string[];
    unreadable_tags: string[];
  };
}

/**
 * **`validate_card` 的结果**（契约 `spec/04` §2.3 ✓ · ADR-D40 ✓）。
 *
 * → **`resolved.tags` / `resolved.actions` 是「声明 ∩ 当前可用」** ✓
 *   （**不是**声明值 ✓ —— agent 要知道的是「这张卡真能绑上什么」✓）。
 */
export interface McpValidateResult {
  ok: boolean;
  errors: { severity: string; rule: number; path: string; message: string }[];
  warnings: { severity: string; rule: number; path: string; message: string }[];
  resolved: {
    /** 要读、**且当前板上可读**的 tag（**具体名** ✓） */
    tags: string[];
    /** 要写、**且当前板型包里确实有**的动作 id ✓ */
    actions: string[];
    /** 解出来的格子尺寸（**没有 layout 就是 `null`** ✓） */
    layout: { w: number; h: number; min_w: number; min_h: number } | null;
    /** 要读但**当前不可读**的 tag ✓ */
    missing_tags: string[];
    /** 要写但**当前板型包里没有**的动作 id ✓ */
    missing_actions: string[];
  };
}
