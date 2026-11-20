/**
 * ⚠️ **The fake device** — a **virtual file system**.
 *
 * ── Why the fake device needs a disk ──
 *
 * What the write side (M6) has to prove is "**the action executes → the
 * readback → the interface renders the value of the readback**", and three of
 * the five forms of the readback land on **files and commands**:
 * `file_equals` (read the file and compare the value), `command_ok` (look at
 * the exit code), `verify` (run a second command).
 *
 * → The fake device **cannot only emit `/proc` text**: it has to be able to
 * **write files, read them back and be grepped**.
 * Otherwise the criterion "the action loop closes" cannot be run on the fake
 * device at all (it would depend on a real board → not automatable).
 *
 * ── Three demands of "honesty" ──
 *
 * 1. **A real transfer**: a file that is pushed really lands on the virtual
 *    disk, and a file that is pulled really lands on the disk of the host —
 *    the lying kind of "reporting success without transferring the file" no
 *    longer happens;
 * 2. **No pretending**: pulling a file that does not exist **is an error**,
 *    not a **reported success**;
 * 3. **The bytes are preserved**: what is stored is a **Buffer** and not a
 *    string — a `.ko` is binary, and storing it as a string destroys it (the
 *    transcoding is the damage).
 *
 * ── A board has only one disk ──
 *
 * So this fs is **split per profile id**: the two connections of the same fake
 * profile (the connection of the runtime, the connection of the terminal tab)
 * see **the same disk** — a file the runtime wrote is visible in the file
 * browser.
 */

/** One directory entry (the same shape as the `FileEntry` of the HAL, but with a size here) */
export interface VirtualEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
}

export class VirtualFs {
  /** absolute path → content */
  private readonly files = new Map<string, Buffer>();

  /** Writes a file (whether the parent directory is created does not matter — this is a flat file system) */
  write(path: string, content: string | Buffer): void {
    this.files.set(normalizePath(path), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }

  /** Reads a file; `null` when there is none (**not an empty string** — an empty file and a missing file are two different things) */
  read(path: string): Buffer | null {
    return this.files.get(normalizePath(path)) ?? null;
  }

  /** Reads a file (as text) */
  readText(path: string): string | null {
    const buffer = this.read(path);
    return buffer === null ? null : buffer.toString('utf8');
  }

  /** Is there anything on this path */
  exists(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  /** Deletes a file (`false` when there is none) */
  remove(path: string): boolean {
    return this.files.delete(normalizePath(path));
  }

  /** Lists the **direct children** of a directory (the files and the subdirectories) */
  list(dir: string): VirtualEntry[] {
    const base = normalizePath(dir);
    const prefix = base === '' || base === '/' ? '/' : `${base}/`;
    const files = new Map<string, VirtualEntry>();
    const dirs = new Set<string>();
    for (const [path, content] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.set(rest, {
          name: rest,
          path,
          isDirectory: false,
          sizeBytes: content.length,
        });
        continue;
      }
      //  deeper → it is a subdirectory
      dirs.add(rest.slice(0, slash));
    }
    const out: VirtualEntry[] = [];
    for (const name of [...dirs].sort()) {
      out.push({ name, path: `${prefix}${name}`, isDirectory: true, sizeBytes: null });
    }
    for (const entry of [...files.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(entry);
    }
    return out;
  }

  /** All the paths (for the diagnostics) */
  paths(): string[] {
    return [...this.files.keys()];
  }
}

/** The normalisation of a path: the duplicate `/` are removed, the trailing `/` is removed (except for the root) */
function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '') return '';
  const collapsed = trimmed.replace(/\/+/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

/**
 * One fs per fake board (**split per profile id**).
 *
 * → The two connections of the same fake profile see the same disk ✓
 * → Another profile id means **another board** (they do not talk to each
 *   other) ✓
 */
const FILESYSTEMS = new Map<string, VirtualFs>();

export function fakeFilesystem(profileId: string): VirtualFs {
  const existing = FILESYSTEMS.get(profileId);
  if (existing !== undefined) return existing;
  const created = new VirtualFs();
  // **Put the two conventional files on this disk** — the file browser has something to show as soon as it is opened
  // (they used to be two hard-coded entries in `list()`; now they **really are on the disk**).
  created.write('/README.txt', 'This is a fake board. Everything here is synthetic data.\n');
  created.write('/etc/hostname', 'fake-board\n');
  FILESYSTEMS.set(profileId, created);
  return created;
}
