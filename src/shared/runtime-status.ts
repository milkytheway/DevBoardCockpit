import type { ErrorCode } from './errors';

/**
 * The state of the tag runtime.
 *
 * ── Why it lives in shared ──
 *
 * The types of the IPC channels live in `src/shared/` (the dependency
 * direction is main → shared ← renderer). This state has to reach the
 * screen (the panel has to say why there is no number), so the renderer
 * must be able to get it. If it lived in `src/main/tags/runtime.ts`, shared
 * would have to depend on main — the direction would be reversed.
 *
 * So it was moved here, and `src/main/tags/runtime.ts` imports it from
 * here and re-exports it (so the existing imports keep working).
 */

/** The state machine of the runtime */
export type RuntimeState = 'idle' | 'running' | 'no-pack' | 'error';

export interface RuntimeStatus {
  state: RuntimeState;
  /** Plain language: why it is not running */
  detail?: string;
  /** The connection profile that is being sampled */
  profileId?: string;
  /**
   * The error code of the failure (`ErrorCode`).
   *
   * Why the state carries a code: deciding "is the serial port taken by
   * another program" must not rely on matching a human-readable message,
   * because changing one character breaks it. The error codes are closed,
   * and `PORT_BUSY` is already used in `hal/serial.ts`.
   */
  detailCode?: ErrorCode;
}
