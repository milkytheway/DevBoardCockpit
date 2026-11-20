/**
 * The placement semantics — a closed vocabulary.
 *
 * ── Why it exists ──
 *
 * The "canonical position" in "put the artefact at the canonical position
 * on the board" is different for every board: a kernel module goes to
 * `/usr/lib/modules/<version>/extra/`, a user-space program goes to
 * `/usr/local/bin/`.
 * → Hard-coded in the workflow pack = a different board means a changed
 *   workflow ✗;
 * → Hard-coded as a path = the workflow pack does not know the rules of
 *   the board ✗.
 *
 * → So the workflow pack only says "land where a kernel module belongs"
 *   (`placement: kernel-module`), and the host resolves the path by the
 *   rules of the board ✓.
 *
 * ── Closed means a typo is an error ──
 *
 * A typo of `kernel-module` as `kernel_modle` → an error, it must not
 * quietly fall back to "put it somewhere" (that would leave the `.ko` in
 * `/tmp`, then `modprobe` would not find it, while the workflow reports
 * success ✗).
 */

/** The placement vocabulary (closed) */
export const PLACEMENTS = {
  'kernel-module': {
    /** The template of the directory; `{kernel_release}` is filled in by the host with the real kernel version of the target machine */
    dir: '/usr/lib/modules/{kernel_release}/extra/',
    /** A sentence in plain language (written into the error messages and the timeline) */
    doc: 'kernel module → /usr/lib/modules/<version>/extra/ (placement spec §4, hard rule 1)',
  },
  'user-program': {
    dir: '/usr/local/bin/',
    doc: 'user-space executable → /usr/local/bin/',
  },
} as const;

export type PlacementId = keyof typeof PLACEMENTS;

export const PLACEMENT_IDS = Object.keys(PLACEMENTS) as PlacementId[];

/** Is this word in the closed vocabulary */
export function isPlacement(id: string): id is PlacementId {
  return Object.hasOwn(PLACEMENTS, id);
}

/** Resolve the placement directory (`kernel-module` has to know the kernel version of the target machine) */
export function placementDir(id: PlacementId, facts: { kernel_release: string }): string {
  const template = PLACEMENTS[id].dir;
  return template.replace('{kernel_release}', facts.kernel_release);
}
