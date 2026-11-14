import type { CardInstanceInfo } from '../../shared/ipc-contract';
import type { LayoutUnit } from '../../shared/layout';

/** A saved workspace view (content composition lives in the shell, not in main). */
export type ViewId = 'overview' | 'monitor' | 'debug' | 'demo';

export interface ViewDef {
  id: ViewId;
  name: string;
  hint: string;
}

export const VIEWS: readonly ViewDef[] = [
  { id: 'overview', name: '总览', hint: '板子的全貌：目标、读数、卡片' },
  { id: 'monitor', name: '监控', hint: '关键指标的连续曲线' },
  { id: 'debug', name: '调试', hint: '运行时、连接与卡片诊断' },
  { id: 'demo', name: '演示', hint: '只留目标与卡片，适合展示' },
];

/** Pages owned by the left rail. Terminal/files/logs open the bottom dock instead. */
export type PageId = 'workbench' | 'library' | 'settings';

export type DockTab = 'terminal' | 'files' | 'logs';

export interface TerminalTab {
  sessionId: string;
  profileId: string;
  label: string;
}

export type ActivityLevel = 'info' | 'warn' | 'error';

export interface ActivityEntry {
  id: number;
  at: number;
  level: ActivityLevel;
  message: string;
}

/** A card paired with its grid unit. */
export interface CardSlot {
  card: CardInstanceInfo;
  unit: LayoutUnit;
}

export interface SelectedTag {
  tag: string;
}
