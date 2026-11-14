import type { CockpitApi } from '../../shared/ipc-contract';

declare global {
  interface Window {
    /** The preload bridge. Renderer code must reach the host only through this. */
    cockpit: CockpitApi;
  }
}

export {};
