/**
 * **What this machine can see of the board** ✓.
 *
 * → The connection profiles of a published repository carry **placeholders**
 *   for the values that only one machine knows ✓ → the person has to see
 *   what was found ✓ (the adb devices ✓ · the addresses ✓ · the serial ports
 *   ✓ · the private keys ✓) → and to say which one is right ✓ when there is
 *   more than one candidate ✓.
 * → **Every connection of this machine can be corrected** ✓ — the board's ✓
 *   **and the guest machine's** ✓ (it has an address of its own ✓).
 */

/** One adb device ✓ */
export interface AdbDeviceInfo {
  serial: string;
  state: string;
  stateText: string;
}

/** One serial port of this machine ✓ */
export interface SerialPortInfo {
  path: string;
  /** Did the board answer there? ✓ (**a port that exists proves nothing** ✓) */
  answered: boolean;
}

/** One candidate address ✓ */
export interface AddressCandidate {
  address: string;
  /** Did the SSH port answer there? ✓ */
  reachable: boolean;
  /** Why not (when it did not ✓) */
  detail: string | null;
}

/** One connection of this machine and the values it needs ✓ */
export interface ConnectionValues {
  /** The profile id ✓ */
  id: string;
  /** Its label ✓ */
  label: string;
  /** Its transport ✓ */
  transport: string;
  /** The board it belongs to ✓ (`null` = it belongs to no board ✓) */
  boardPack: string | null;
  /** The values it currently uses ✓ */
  values: {
    serial?: string;
    host?: string;
    port?: string;
    username?: string;
    key_filename?: string;
  };
  /** Where each value came from ✓ (`builtin` = it came with the profile ✓) */
  sources: Record<string, string>;
}

export interface BoardDetection {
  /** The adb devices ✓ */
  adbDevices: AdbDeviceInfo[];
  /** The model the board reports ✓ */
  model: string | null;
  /** The address of the board ✓ (**the one that answered** ✓) */
  address: string | null;
  /** **Every** candidate address ✓ and whether it answered ✓ */
  addresses: AddressCandidate[];
  /** The serial ports of this machine ✓ */
  ports: SerialPortInfo[];
  /** The private keys this machine has ✓ */
  sshKeys: string[];
  /** The board pack the detected model belongs to ✓ */
  boardPack: string | null;
  /** **Every connection of this machine** ✓ with the values it uses ✓ */
  connections: ConnectionValues[];
}

/** The values the person confirms ✓ — **per connection** ✓ */
export interface BoardApplyValue {
  /** The profile id ✓ */
  id: string;
  /** The fields to set ✓ (**only the machine-specific ones** ✓) */
  fields: Record<string, string>;
}

export interface BoardApplyResult {
  /** The connections that were written ✓ */
  written: string[];
  /** The connections that were left alone ✓ */
  kept: string[];
}

/**
 * Read the confirmed values out of the IPC payload ✓.
 *
 * → **The renderer is not trusted** ✓ → every field is a string ✓ → the
 *   trimmed value ✓ → **an empty string means "not given"** ✓.
 */
export function parseBoardValues(raw: unknown): BoardApplyValue[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardApplyValue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const source = entry as { id?: unknown; fields?: unknown };
    if (typeof source.id !== 'string' || source.id.length === 0) continue;
    const fields: Record<string, string> = {};
    if (typeof source.fields === 'object' && source.fields !== null) {
      for (const [key, value] of Object.entries(source.fields as Record<string, unknown>)) {
        if (typeof value === 'string') fields[key] = value.trim();
      }
    }
    out.push({ id: source.id, fields });
  }
  return out;
}
