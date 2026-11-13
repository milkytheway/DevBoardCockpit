import { AdbConnection, adbCapabilities } from './adb';
import { LocalConnection, localCapabilities } from './local';
import { SerialConnection, serialCapabilities } from './serial';
import { SshConnection, sshCapabilities } from './ssh';
import { capabilitiesFor } from './capabilities';
import type { ConnectionCapabilities, Connection } from './connection';
import type { ConnectionProfile } from '../profiles/schema';
import type { SessionLog } from '../logging/session-log';

/**
 * 传输注册表。
 *
 * 「加一块新板不用改 UI」在代码层面的落点：
 * UI 只认 `Connection` 与 `ConnectionCapabilities`，不认传输名。
 * 新注册一种传输，UI 不用动一行。
 *
 * **能力位只有一份实现**（`./capabilities`）。
 * 原来这里另有一份，而那份**不看 profile 的 `pty` 字段**——
 * 于是两处算法不同：用户在 profile 里把 ssh 的 pty 改成 false 毫无效果。
 * 「能力位只有一个算法」跟「核心词表只有一个源头」是同一条道理。
 *
 * **2026-11-13**：这句从「约定」变成「事实」——各 HAL 模块里
 * `xxxCapabilities()` 原来各抄了一份字面量（同一张表抄了五遍），
 * 现在全部转调 `transportDefaults()`；而 `Connection.capabilities()`
 * 也改成调 `capabilitiesFor(this.profile)`，
 * **不再报「传输常量」**——它与 UI 的 `connections:list` 现在同源。
 */

/** 按 profile 算能力位（唯一实现，见 `./capabilities`） */
export { capabilitiesFor };

/** 按 profile 造一个连接 */
export function createConnection(
  profile: ConnectionProfile,
  log: SessionLog,
  opts: { adbPath?: string } = {},
): Connection {
  switch (profile.transport) {
    case 'serial':
      return new SerialConnection(profile, log);
    case 'adb':
      return new AdbConnection(profile, log, { adbPath: opts.adbPath });
    case 'ssh':
      return new SshConnection(profile, log);
    case 'local':
      return new LocalConnection(profile, log);
  }
}

/** 各传输的能力默认值。重新导出，方便调用方不必知道实现细节 */
export { serialCapabilities, adbCapabilities, sshCapabilities, localCapabilities };
export type { ConnectionCapabilities };
