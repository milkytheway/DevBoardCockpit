/**
 * **The machine-specific values of this machine** ✓.
 *
 * ── Why this is a store and not a profile copy ──
 *
 * → A connection profile has two kinds of fields ✓: **what this connection
 *   is** ✓ (the transport ✓ · the board it belongs to ✓ · its label ✓) and
 *   **which machine it reaches** ✓ (the serial number ✓ · the address ✓ ·
 *   the port ✓ · the private key ✓).
 * → The second kind belongs to **the machine**, not to the profile ✓ → it
 *   must not live in the repository ✓ (the addresses of other people's
 *   boards are none of our business ✓) **and not in a copy of the profile
 *   either** ✓ — a copy **overrides the whole profile** ✓ → the next fix to
 *   the shipped profile **never reaches that machine** ✓ → the profile
 *   freezes ✓.
 * → So: **the shipped profile stays the truth about the connection** ✓ and
 *   **this store holds what is true on this machine** ✓ → the two are
 *   merged when the profiles are loaded ✓.
 *
 * ── The rules ──
 *
 * | # | Rule | Why |
 * |---|---|---|
 * | 1 | The store lives in the **user data directory** ✓ | the built-in directory is inside the read-only archive ✓ |
 * | 2 | It holds **only the machine-specific fields** ✓ | everything else is the profile's business ✓ |
 * | 3 | A value that is **detected** is marked as such ✓ | the interface has to say where a value came from ✓ |
 * | 4 | A value that **the person confirmed** wins over a detected one ✓ | the person is the authority ✓ |
 * | 5 | Writing it is **atomic** ✓ | a half-written file is read back as "no values" ✓ |
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConnectionProfile } from '../profiles/schema';

/**
 * **The fields that belong to the machine** ✓.
 *
 * → They are the ones that differ from machine to machine ✓ — the serial
 *   number of the board ✓ · its address ✓ · the port ✓ · the private key ✓ ·
 *   the user name ✓ · the password ✓.
 */
export const MACHINE_FIELDS: readonly string[] = [
  'serial',
  'host',
  'port',
  'username',
  'password',
  'key_filename',
  'baudrate',
];

/** Where a value came from ✓ */
export type ValueSource = 'builtin' | 'user' | 'detected' | 'confirmed';

export interface MachineValue {
  value: unknown;
  /** Where it came from ✓ — the interface says it out loud ✓ */
  source: ValueSource;
}

export interface MachineValuesFile {
  /** profile id → field name → the value ✓ */
  profiles: Record<string, Record<string, MachineValue>>;
}

/**
 * The store ✓ — one file in the user data directory ✓.
 */
export class MachineValueStore {
  private data: MachineValuesFile;

  constructor(private readonly filePath: string) {
    this.data = this.read();
  }

  private read(): MachineValuesFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return { profiles: {} };
      const profiles = (parsed as { profiles?: unknown }).profiles;
      if (typeof profiles !== 'object' || profiles === null) return { profiles: {} };
      return { profiles: profiles as Record<string, Record<string, MachineValue>> };
    } catch {
      // **A missing or broken file is not a reason to stop** ✓ (the same
      // rule the permission store follows ✓)
      return { profiles: {} };
    }
  }

  /** The values of one profile ✓ */
  get(profileId: string): Record<string, MachineValue> {
    return { ...(this.data.profiles[profileId] ?? {}) };
  }

  /** Every profile's values ✓ */
  all(): Record<string, Record<string, MachineValue>> {
    return { ...this.data.profiles };
  }

  /**
   * Writes the values of one profile ✓.
   *
   * → **Only the machine-specific fields** ✓ are taken ✓ (a profile is not
   *   rewritten here ✓).
   * → The source is recorded ✓ (the interface has to say where a value came
   *   from ✓).
   */
  set(profileId: string, values: Record<string, unknown>, source: ValueSource): void {
    const current = { ...(this.data.profiles[profileId] ?? {}) };
    for (const [field, value] of Object.entries(values)) {
      if (!MACHINE_FIELDS.includes(field)) continue;
      current[field] = { value, source };
    }
    this.data = { profiles: { ...this.data.profiles, [profileId]: current } };
    this.save();
  }

  /** Forgets the values of one profile ✓ (the shipped profile is used again ✓) */
  clear(profileId: string): void {
    const { [profileId]: _gone, ...rest } = this.data.profiles;
    this.data = { profiles: rest };
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** Is there a file at all? ✓ */
  get exists(): boolean {
    return existsSync(this.filePath);
  }
}

/** The path of the store ✓ (in the user data directory ✓) */
export function machineValuesPath(userDataDir: string): string {
  return join(userDataDir, 'machine-values.json');
}

/**
 * **Merge the machine's values into the profiles** ✓.
 *
 * → The profile is the truth about **what the connection is** ✓.
 * → The store is the truth about **which machine it reaches** ✓.
 * → **The store wins for the machine-specific fields** ✓ (the detection
 *   knows more than a shipped file ✓) and **the profile wins for
 *   everything else** ✓.
 */
export function applyMachineValues(
  profiles: ConnectionProfile[],
  store: MachineValueStore,
): ConnectionProfile[] {
  return profiles.map((profile) => {
    const values = store.get(profile.id);
    const fields = Object.keys(values);
    if (fields.length === 0) return profile;
    const options: Record<string, unknown> = { ...profile.options };
    for (const field of fields) {
      const entry = values[field];
      if (entry === undefined) continue;
      options[field] = entry.value;
    }
    return { ...profile, options };
  });
}

/** Where the value of one field came from ✓ (`builtin` when the store has none ✓) */
export function sourceOf(
  store: MachineValueStore,
  profileId: string,
  field: string,
): ValueSource {
  return store.get(profileId)[field]?.source ?? 'builtin';
}
