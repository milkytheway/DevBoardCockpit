import type { CardInstanceInfo } from '../../shared/ipc-contract';

/**
 * The shell's navigation model.
 *
 * ── one rail entry = one page ──
 *
 * The rail lists the places you can be; every one of them is a full page in
 * the main area. There is no second level of navigation hidden behind a
 * bottom panel any more — clicking "Terminal" takes you to the terminal.
 */
export type PageId = 'workbench' | 'terminal' | 'files' | 'logs' | 'library' | 'settings';

/** The pages, in rail order. */
export const PAGE_IDS: readonly PageId[] = [
  'workbench',
  'terminal',
  'files',
  'logs',
  'library',
  'settings',
];

/** Severity of an activity line. */
export type ActivityLevel = 'info' | 'warn' | 'error';

/** One line in the activity stream (what the host did, in order). */
export interface ActivityEntry {
  id: number;
  at: number;
  level: ActivityLevel;
  message: string;
}

/** A live terminal session. One session = one connection to one profile. */
export interface TerminalTab {
  sessionId: string;
  profileId: string;
  label: string;
}

/**
 * What the right-hand detail panel is showing.
 *
 * `null` means the panel is closed — we do not keep an empty shell around.
 */
export type DetailTarget =
  | { kind: 'card'; card: CardInstanceInfo }
  | { kind: 'session'; session: TerminalTab }
  | null;
