/**
 * 会话启动时注入的环境脚本。
 *
 * 两处都是旧工程踩过的坑：
 *
 * - **事实 A2**：adb 把 `TERM` 设成 `dumb`，GNU coreutils 直接拒绝着色
 *   （`--color=always` 也没用）。所以会话启动时 `export TERM=xterm-256color`。
 * - **事实 A3**：非交互 shell **不展开 alias**，所以 `alias ls='ls --color=auto'`
 *   静默无效。必须用 **shell 函数** `ls() { command ls -C --color=always "$@"; }`，
 *   且要带 `-C`（多列排版）。
 *
 * 这段脚本由宿主在每次会话开始时执行一次，不是每次命令。
 */
export function terminalEnvScript(): string {
  return [
    'export TERM=xterm-256color',
    'ls() { command ls -C --color=always "$@"; }',
    '',
  ].join('\n');
}
