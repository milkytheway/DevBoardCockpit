import type { ConnectionCapabilities } from '../../shared/ipc-contract';
import type { ConnectionProfile } from '../profiles/schema';

/**
 * 能力位由 **profile 决定**，不是由传输名决定。
 *
 * 旧工程吃过这个亏：终端模式（pty/pipe）曾由传输名推断，
 * 新注册的传输就被当成了真终端（`docs/legacy/旧工程架构说明-PySide6.md`）。
 *
 * 每种传输的**默认**：
 * - `serial`：串口控制台是真终端（自己回显、自己出提示符）——默认 true
 * - `adb`：`adb shell` 无 PTY；`adb shell -t -t` 在 Windows 上会晚一条（事实 A1）——默认 false
 * - `ssh`：远端提供真终端——默认 true
 * - `local`：本机 pty——默认 true
 *
 * profile 里可以显式写 `pty` 覆盖默认值（schema 允许所有传输写这个字段）。
 * 但 `adb` 写 `pty: true` 会被 schema 拒绝——事实 A1 不接受例外。
 */

/** 各传输的能力默认值。`files` 与 `exitCode` 是传输决定的，`pty` 可被 profile 覆盖。 */
const TRANSPORT_DEFAULTS: Record<
  ConnectionProfile['transport'],
  { exec: boolean; files: boolean; exitCode: boolean; pty: boolean }
> = {
  // 串口传不了文件（事实 S7）；串口拿不到 exit status（事实 S5）
  serial: { exec: true, files: false, exitCode: false, pty: true },
  // adb 能传文件、能拿退出码；不用 PTY（事实 A1）
  adb: { exec: true, files: true, exitCode: true, pty: false },
  ssh: { exec: true, files: true, exitCode: true, pty: true },
  local: { exec: true, files: true, exitCode: true, pty: true },
};

/**
 * 某个传输的**默认**能力位（**不看 profile**）。
 *
 * **这张表是能力位的唯一事实源。**
 * 以前每个 HAL 模块（adb/local/serial/ssh）**各抄了一份字面量**，
 * 于是同一件事有两个地方能改——改一处不改另一处，两处就对不上。
 * 现在这些模块的 `xxxCapabilities()` 全部转调这里。
 *
 * **它不是「这条连接的能力位」**——那是 `capabilitiesFor(profile)`，
 * 它会看 profile 的 `options.pty`。
 */
export function transportDefaults(
  transport: ConnectionProfile['transport'],
): ConnectionCapabilities {
  const d = TRANSPORT_DEFAULTS[transport];
  return { exec: d.exec, files: d.files, exitCode: d.exitCode, pty: d.pty };
}

/**
 * 算一个 profile 的能力位。
 *
 * **这是「一条连接的能力位」的唯一实现**——UI 的降级判断与运行时的
 * 模式选择都调它，不允许有第二个算法。
 */
export function capabilitiesFor(profile: ConnectionProfile): ConnectionCapabilities {
  const defaults = transportDefaults(profile.transport);
  const explicit = profile.options['pty'];
  return {
    ...defaults,
    pty: typeof explicit === 'boolean' ? explicit : defaults.pty,
  };
}
