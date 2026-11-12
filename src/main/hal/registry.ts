import { AdbConnection, adbCapabilities } from './adb';
import { LocalConnection, localCapabilities } from './local';
import { SerialConnection, serialCapabilities } from './serial';
import { SshConnection, sshCapabilities } from './ssh';
import type { Capabilities, Connection } from './connection';
import type { ConnectionProfile } from '../profiles/schema';
import type { SessionLog } from '../logging/session-log';

/**
 * 传输注册表。
 *
 * 「加一块新板不用改 UI」在代码层面的落点：
 * UI 只认 `Connection` 与 `Capabilities`，不认传输名。
 * 新注册一种传输，UI 不用动一行。
 */

/** 按传输给出能力位 */
export function capabilitiesFor(profile: ConnectionProfile): Capabilities {
  switch (profile.transport) {
    case 'serial':
      return serialCapabilities();
    case 'adb':
      return adbCapabilities();
    case 'ssh':
      return sshCapabilities();
    case 'local':
      return localCapabilities();
  }
}

/** 按 profile 造一个连接 */
export function createConnection(profile: ConnectionProfile, log: SessionLog): Connection {
  switch (profile.transport) {
    case 'serial':
      return new SerialConnection(profile, log);
    case 'adb':
      return new AdbConnection(profile, log);
    case 'ssh':
      return new SshConnection(profile, log);
    case 'local':
      return new LocalConnection(profile, log);
  }
}
