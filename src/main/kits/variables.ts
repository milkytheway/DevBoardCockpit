/**
 * The answers to the kit variables ✓ — **per machine** ✓.
 *
 * → They live in the **user data directory** ✓ (contract rule 13 ✓):
 *   `profiles/settings.json` is inside the application archive ✓ and is
 *   **read-only** once the application is installed ✓ — the variables have to
 *   be somewhere the person can write to ✓.
 * → The same place as the other per-machine state ✓ (`permissions.json` ✓ ·
 *   `layout.json` ✓ · the user profile directory ✓).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface VariablesFile {
  /** kit id → variable name → value ✓ */
  kits: Record<string, Record<string, unknown>>;
}

export class KitVariableStore {
  private data: VariablesFile;

  constructor(private readonly filePath: string) {
    this.data = this.read();
  }

  private read(): VariablesFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return { kits: {} };
      const kits = (parsed as { kits?: unknown }).kits;
      if (typeof kits !== 'object' || kits === null) return { kits: {} };
      return { kits: kits as Record<string, Record<string, unknown>> };
    } catch {
      // **A missing or broken file is not a reason to stop** ✓ — the same
      // rule the settings follow ✓
      return { kits: {} };
    }
  }

  /** The answers of one kit ✓ */
  all(kitId: string): Record<string, unknown> {
    return { ...(this.data.kits[kitId] ?? {}) };
  }

  /** One answer ✓ */
  get(kitId: string, name: string): unknown {
    return this.data.kits[kitId]?.[name];
  }

  /** Sets one answer ✓ (**idempotent** ✓) */
  set(kitId: string, name: string, value: unknown): void {
    const forKit = { ...(this.data.kits[kitId] ?? {}) };
    forKit[name] = value;
    this.data.kits = { ...this.data.kits, [kitId]: forKit };
    this.save();
  }

  /** Sets several answers at once ✓ (one write ✓) */
  setMany(kitId: string, values: Record<string, unknown>): void {
    this.data.kits = { ...this.data.kits, [kitId]: { ...(this.data.kits[kitId] ?? {}), ...values } };
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // **Written through a temporary file** ✓ — a half-written file would be
    // read back as "no answers" ✓ (the same rule the permission store follows ✓)
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** Is there a file at all? ✓ (the settings page says so ✓) */
  get exists(): boolean {
    return existsSync(this.filePath);
  }
}
