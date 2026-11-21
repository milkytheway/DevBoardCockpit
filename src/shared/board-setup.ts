/**
 * **What the host can see of the board on this machine.**
 *
 * → The connection profiles of a published repository carry **placeholders**
 *   for the values that only one machine knows ✓ → the person has to be able
 *   to **see** what was found ✓ and to **say** which one is right ✓ when
 *   there is more than one candidate ✓.
 */
export interface BoardDetection {
  /** The devices adb sees ✓ (the serial ✓ · the state ✓) */
  adbDevices: { serial: string; state: string; stateText: string }[];
  /** The model the board reports ✓ (`/proc/device-tree/model` ✓) */
  model: string | null;
  /** The address the board reports about itself ✓ */
  address: string | null;
  /** The serial ports of this machine ✓ (**which one answers** ✓) */
  ports: { path: string; answered: boolean }[];
  /** The board pack the detected model belongs to ✓ (`null` = no pack claims it ✓) */
  boardPack: string | null;
  /**
   * **The private keys of this machine** ✓ (the ones in `~/.ssh` ✓).
   *
   * → The credential is a **machine-specific value** ✓ (like the address ✓) —
   *   it belongs to the person ✓ → the person says which key it is ✓ (the
   *   detection proposes the one that authenticates ✓ — but the person has the
   *   last word ✓).
   * → **Only the name is shown** ✓ (the path is the person's own ✓ · the
   *   content never leaves the file ✓).
   */
  sshKeys: { path: string; name: string }[];
}

/** The values the person confirms ✓ */
export interface BoardValues {
  /** The board pack these values are for ✓ */
  boardPack: string;
  /** The serial number of the board (adb) ✓ */
  adbSerial: string;
  /** The address of the board ✓ */
  address: string;
  /** The serial port of the console ✓ */
  serialPort: string;
  /** The private key that opens the board (ssh) ✓ (empty = not given ✓) */
  keyFilename: string;
}

/** What the apply did ✓ */
export interface BoardApplyResult {
  /** The profiles that were written ✓ */
  written: string[];
  /** The profiles that were left alone ✓ */
  kept: string[];
}

/**
 * Read the confirmed values out of the IPC payload ✓.
 *
 * → **The renderer is not trusted** ✓ → every field is a string ✓ → the
 *   trimmed value ✓ → **an empty string means "not given"** ✓.
 */
export function parseBoardValues(raw: unknown): BoardValues {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = (key: string): string => {
    const value = source[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    boardPack: text('boardPack'),
    adbSerial: text('adbSerial'),
    address: text('address'),
    serialPort: text('serialPort'),
    keyFilename: text('keyFilename'),
  };
}
