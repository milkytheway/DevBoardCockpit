/**
 * Environment script injected when a session starts.
 *
 * Both entries come from pitfalls the old project ran into:
 *
 * - **Fact A2**: adb sets `TERM` to `dumb`, and GNU coreutils refuses to
 *   colorize outright (`--color=always` does not help either). So the session
 *   starts with `export TERM=xterm-256color`.
 * - **Fact A3**: a non-interactive shell does **not** expand aliases, so
 *   `alias ls='ls --color=auto'` fails silently. It has to be a **shell
 *   function**: `ls() { command ls -C --color=always "$@"; }`, and it needs
 *   `-C` (multi-column layout).
 *
 * The host runs this script once at the start of every session, not once per
 * command.
 */
export function terminalEnvScript(): string {
  return [
    'export TERM=xterm-256color',
    'ls() { command ls -C --color=always "$@"; }',
    '',
  ].join('\n');
}
