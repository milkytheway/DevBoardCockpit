/**
 * The layout contract of the build artefacts.
 *
 * The preload path hard-coded in main, the preload file name produced by
 * electron-vite and the build self-check script all have to say the same
 * thing. So none of them hard-codes a string of its own — they all take it
 * from here.
 *
 * Why CJS (`.cjs`) and not ESM (`.mjs`):
 * Electron's sandboxed preload only runs CommonJS (the process and security
 * baseline of the implementation-layer architecture design).
 * An ESM preload needs `sandbox: false`, which amounts to turning the
 * renderer sandbox off — and this project loads untrusted cards into the
 * renderer (the CSP network cut-off of contract section 6.1).
 * The sandbox is the last line of defence and must not be switched off to
 * save effort.
 * (Sources: the Electron official documentation sections "Sandboxed preload
 * scripts can't use ESM imports" and "ESM preload scripts must have the .mjs
 * extension".)
 */

/** The build format of the preload. A sandboxed preload can only be CommonJS. */
export const PRELOAD_FORMAT = 'cjs' as const;

/** rollup's entryFileNames: the build artefact is called `[name].cjs` */
export const PRELOAD_ENTRY = '[name].cjs';

/** The actual file name inside the build artefact directory */
export const PRELOAD_FILE = 'index.cjs';

/** The two conventions must line up: `[name]` with the entry name substituted is the file name */
export function preloadEntryName(entryName: string): string {
  return PRELOAD_ENTRY.replace('[name]', entryName);
}
