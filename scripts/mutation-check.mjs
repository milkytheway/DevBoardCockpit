#!/usr/bin/env node
/**
 * Mutation testing: it proves that these regression tests **really guard**
 * the things that were fixed.
 *
 * Why it is needed: after a whole round of review had fixed 6 Criticals, 3 of
 * them (C1 the serial port does not open, C4 the terminal output renders
 * twice, C6 the renderer does not present the error) **had no test guarding
 * them** — putting the fix back the way it was left the whole suite green.
 * "The test passes" and "the test catches this bug" are two different things,
 * and only a mutation tells them apart.
 *
 * How it works: put the fix back into its broken shape → run the matching
 * test → **it has to turn red** → restore it → it has to turn green again.
 *
 * **Written in Node rather than in a shell**: the target platform of this
 * project is Windows, and `npm.ps1` under PowerShell swallows whatever comes
 * after `--` — that is, **on the target platform this "verifier" does not
 * even start**. A verifier that does not start is not a verifier.
 *
 * Usage (in the root of the repository):
 *   npm run mutation:check
 *
 * Exit code 0 = everything is guarded; non-zero = a test is a sham.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One mutation:
 * - `file`   the file that is broken
 * - `apply`  how it is broken (it returns the new content)
 * - `check`  what is run to see that it turned red
 * - `expect` the text that has to appear in the output.
 *   **This one is the key**: judging nothing but "the exit code is non-zero"
 *   mistakes a compile failure for "the test held".
 */
const MUTATIONS = [
  {
    name: 'C1 the serial port really opens',
    file: 'src/main/hal/serial.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/serial-real-factory.test.ts'],
    expect: 'opening the port: it calls the open() of serialport',
    apply: (s) => replace(s, '  await port.open();', '  // await port.open();  // mutation'),
  },
  {
    name: 'C2 the marker protocol is a single line',
    file: 'src/main/hal/serial.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/serial.test.ts'],
    expect: 'the command that is sent and the marker are on the same line (the board echoes once and the echo answers once = the marker appears twice)',
    apply: (s) =>
      replace(
        s,
        '    this.port?.write(`${command}; echo ${marker}\\r\\n`);',
        '    this.port?.write(`${marker}\\r\\n${command}\\r\\n${marker}\\r\\n`);',
      ),
  },
  {
    name: 'C3 the SSH shell is asynchronous',
    file: 'src/main/hal/ssh.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/ssh.test.ts'],
    expect: 'openSession returns the shell channel, not the client (the shell() of ssh2 gives the channel in its callback)',
    apply: (s) =>
      replace(
        s,
        '  private openShell(cols: number, rows: number): Promise<ClientChannel> {\n    return new Promise((resolve, reject) => {\n      this.client!.shell({ term: \'xterm-256color\', cols, rows }, (err, ch) => {\n        if (err) {\n          reject(makeError(\'CONN_OPEN_FAILED\', `opening the SSH shell failed: ${err.message}`, {\n            detail: { host: this.opts.host, cause: err.message },\n          }));\n          return;\n        }\n        resolve(ch);\n      });\n    });\n  }',
        '  private openShell(cols: number, rows: number): Promise<ClientChannel> {\n    let channel: ClientChannel | undefined;\n    this.client!.shell({ term: \'xterm-256color\', cols, rows }, (err, ch) => {\n      if (err) throw makeError(\'CONN_OPEN_FAILED\', `opening the SSH shell failed: ${err.message}`);\n      channel = ch;\n    });\n    if (!channel) throw makeError(\'CONN_OPEN_FAILED\', \'opening the SSH shell failed: no channel\');\n    return Promise.resolve(channel);\n  }',
      ),
  },
  {
    name: 'C4 the terminal output does not replay the history',
    file: 'src/renderer/terminal/TerminalView.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/terminal-view.test.tsx'],
    expect: 'every chunk is written once and the history is not replayed (C4)',
    apply: (s) =>
      replace(
        s,
        `  useEffect(() => {
    if (!subscribe) return;
    return subscribe((chunk: string) => {
      termRef.current?.write(chunk);
    });
  }, [subscribe]);`,
        `  const accRef = useRef('');
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((chunk: string) => {
      accRef.current += chunk;
      termRef.current?.write(accRef.current);
    });
  }, [subscribe]);`,
      ),
  },
  {
    name: 'C5 the file transfer is dispatched by the transport',
    file: 'src/main/files/transfer.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/file-transfer.test.ts'],
    expect: 'pull uses the pull of the connection, it does not run a pull command on the remote side',
    apply: (s) =>
      replace(
        s,
        '    await conn.pull(remotePath, localPath);',
        '    await conn.exec(`pull ${remotePath} ${localPath}`);',
      ),
  },
  {
    name: 'C6 the renderer presents the error',
    file: 'src/renderer/shell/ErrorBar.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-error.test.tsx'],
    expect: 'shows why it failed (with the real shape)',
    apply: (s) =>
      replace(
        s,
        '    <div className="shell-error" role="alert">\n      <span>{message}</span>',
        '    <div className="shell-error" role="alert">\n      <span>{\'broken\'}</span>',
      ),
  },
  {
    name: 'M7 the preload must be CommonJS',
    file: 'electron.vite.config.ts',
    check: ['npm', 'run', 'build'],
    expect: 'the build artefact self-check failed',
    apply: (s) => replace(s, 'format: PRELOAD_FORMAT,', "format: 'es',"),
  },
  {
    name: 'M8 an error across the IPC has to be unwrapped',
    file: 'src/preload/index.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/preload.test.ts'],
    expect: 'the error code',
    apply: (s) =>
      replace(
        s,
        '  if (!result.ok) throw appErrorToException(result.error);',
        '  // mutation: it does not unwrap, it takes the failure for a success',
      ),
  },
  {
    name: 'M9 the pipe mode has to send an LF on return',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: 'LF',
    apply: (s) =>
      replace(
        s,
        '          toRemote += `${this.editor.commit()}\\n`;',
        '          toRemote += this.editor.commit();',
      ),
  },
  {
    name: 'M10 an upload has to send the absolute path',
    file: 'src/renderer/shell/files.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-error.test.tsx'],
    expect: 'an upload uses the absolute path of the host, not the file name',
    apply: (s) =>
      replace(
        s,
        'const localPath = host.getPathForFile(file);',
        'const localPath = file.name;',
      ),
  },
  {
    name: 'M11 the reply buffer of the serial port may not be clipped',
    file: 'src/main/hal/serial.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/serial.test.ts'],
    expect: '64 KB',
    apply: (s) =>
      replace(
        s,
        '      if (this.execBuffer !== undefined) this.execBuffer += chunk;',
        '      if (this.execBuffer !== undefined) this.execBuffer = (this.execBuffer + chunk).slice(-1024);',
      ),
  },
  {
    name: 'M13 every log line gets a timestamp',
    file: 'src/main/logging/session-log.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/session-log-format.test.ts'],
    expect: 'the implementation can be fed with the sample and writes a log of the same shape',
    apply: (s) =>
      replace(
        s,
        "    for (const raw of text.replace(/\\n+$/, '').split('\\n')) {",
        "    for (const raw of [text]) {",
      ),
  },
  {
    name: 'M14 the ANSI sequences have to be stripped clean (the hidden cursor and the OSC included)',
    file: 'src/main/logging/session-log.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/session-log-format.test.ts'],
    expect: 'it strips ESC[?25l (the hidden cursor) and the OSC sequences — the old implementation missed those two',
    apply: (s) =>
      replace(
        s,
        '  const CSI = /\\x1b\\[[0-9;?]*[ -/]*[@-~]/g;',
        '  const CSI = /\\x1b\\[[0-9;]*[A-Za-z]/g;',
      ),
  },
  {
    name: 'M15 the history of the pipe mode has to come back',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: 'the history can be recalled',
    apply: (s) =>
      replace(
        s,
        '  historyPrev(): void {\n    if (this.history.length === 0) return;',
        '  historyPrev(): void {\n    if (true) return;\n    if (this.history.length === 0) return;',
      ),
  },
  {
    name: 'M16 the kill ring of the pipe mode has to be pasted back',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: 'the kill ring can be pasted back',
    apply: (s) =>
      replace(s, '    if (this.killed) this.insert(this.killed);', '    // mutation: it is not pasted back'),
  },
  {
    name: 'M17 the redraw may not cross the prompt',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: 'the redraw may not go past the prompt — a prompt that was erased is no prompt',
    apply: (s) =>
      replace(
        s,
        '    const back = displayWidth(before.text.slice(0, before.cursor));',
        '    const back = visibleLength(this.prompt) + displayWidth(before.text.slice(0, before.cursor));',
      ),
  },
  {
    name: 'M18 Ctrl+C has to clear the line',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: 'Ctrl+C has to clear the line — the name of the case promises a "clear line"',
    apply: (s) =>
      replace(
        s,
        "          this.editor.clear();\n          echo += '^C\\r\\n';",
        "          echo += '^C\\r\\n';",
      ),
  },
  {
    name: 'M19 the log file name has to carry the full HHMMSS',
    file: 'src/main/logging/session-log.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/session-log.test.ts'],
    expect: 'the file name is <label>-<HHMMSS>.log — before, one digit was cut off',
    apply: (s) =>
      replace(
        s,
        "    const stem = logFileName(safeName(opts.label), at).replace(/\\.log$/, '');",
        "    const stem = logFileName('', at).slice(0, 6);",
      ),
  },
  {
    name: 'M20 the stdin of the ADB has to take the error',
    file: 'src/main/hal/adb.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/adb.test.ts'],
    expect: 'the error of stdin has to be caught — otherwise an EPIPE takes the main process down',
    apply: (s) =>
      replace(
        s,
        "    child.stdin.on('error', (err: Error) => {",
        "    // mutation: nobody takes the error of stdin\n    child.stdin.on('nothing', (err: Error) => {",
      ),
  },
  {
    name: 'M21 the terminal mode at runtime is decided by the profile',
    file: 'src/main/terminal/manager.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/terminal-manager.test.ts'],
    expect: 'the terminal mode is decided by the pty of the profile — the runtime and the interface have to take it from the same source',
    apply: (s) =>
      replace(
        s,
        '    const pty = capabilitiesFor(profile).pty;',
        '    const pty = connection.capabilities().pty;',
      ),
  },
  {
    name: 'M22 the remote target of an upload has to get the basename',
    file: 'src/main/hal/local.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/local.test.ts'],
    expect: 'the remote target of push is a **directory**',
    apply: (s) =>
      replace(
        s,
        '    const target = join(remotePath, basename(localPath));',
        '    const target = remotePath;',
      ),
  },
  {
    name: 'M23 no next prompt is drawn on submit',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: 'the prompt is drawn only when the next command begins — the output is not pushed behind the next prompt',
    apply: (s) =>
      replace(
        s,
        "          echo += '\\r\\n';\n          this.promptPending = true;",
        "          echo += `\\r\\n${this.prompt}`;\n          this.promptPending = false;",
      ),
  },
  {
    name: 'M24 the environment script of the ADB may not carry a CR',
    file: 'src/main/hal/adb.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/adb.test.ts'],
    expect: 'the script may not contain a CR — a lonely CR is taken for a command by the remote shell',
    apply: (s) =>
      replace(
        s,
        '    this.child.stdin.write(terminalEnvScript());',
        '    this.child.stdin.write(`${terminalEnvScript()}\\r\\n`);',
      ),
  },
  {
    name: 'M25 entering a directory has to list it again',
    file: 'src/renderer/files/FileBrowser.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/file-browser.test.tsx'],
    expect: 'entering a directory lists that directory again — the list may not stay the one from the previous path',
    apply: (s) =>
      replace(
        s,
        '      void load(entry.path);',
        '      // mutation: it does not list it again',
      ),
  },
  {
    name: 'M26 "↑ parent" has to use parentPath',
    file: 'src/renderer/files/FileBrowser.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/file-browser.test.tsx'],
    expect: 'at the component level: entering /.cache and pressing "one level up" returns to the root and lists the new path',
    apply: (s) =>
      replace(
        s,
        '    const parent = parentPath(currentPath);',
        "    const parent = currentPath.replace(/\\/[^/]*$/, '');",
      ),
  },
  {
    name: 'M12 the capabilities are decided by the profile',
    file: 'src/main/hal/capabilities.ts',
    check: ['npx', 'vitest', 'run', 'tests/integration/registry.test.ts'],
    expect: 'a pty written in the profile overrides the default of the transport — the profile decides the capability bits',
    apply: (s) =>
      replace(
        s,
        '    pty: typeof explicit === \'boolean\' ? explicit : defaults.pty,',
        '    pty: defaults.pty,',
      ),
  },
  {
    name: 'M27 rule 4: a binding to *.usage must declare measure **equal to** utilization',
    file: 'src/main/tags/validator.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: 'rule 4',
    apply: (s) =>
      replace(
        s,
        "      if (measure !== 'utilization') {",
        "      if (measure === undefined) {  // mutation: it only checks whether it is declared",
      ),
  },
  {
    name: 'M28 rule 26: the set of implemented capabilities has to be looked up',
    file: 'src/main/tags/vocabulary.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: 'rule 26 · a value of requires.capabilities must belong to the set of implemented capabilities',
    apply: (s) =>
      replace(
        s,
        'export function isImplementedCapability(value: string): boolean {\n  return (IMPLEMENTED_CAPABILITIES as readonly string[]).includes(value);\n}',
        'export function isImplementedCapability(value: string): boolean {\n  return true;  // mutation: everything counts as implemented\n}',
      ),
  },
  {
    name: 'M29 the danger floor: an absolute path counts as well (the basename is the fallback)',
    file: 'src/main/tags/floor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: 'rule 16 · a command that hits the danger floor must be declared destructive',
    apply: (s) =>
      replace(
        s,
        '  return baseName(token) === pattern;',
        '  return token === pattern;  // mutation: the basename fallback is removed',
      ),
  },
  {
    name: 'M30 the danger floor: rm -rf / and rm -rf /* are both caught',
    file: 'src/main/tags/floor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: 'rule 16 · a command that hits the danger floor must be declared destructive',
    apply: (s) =>
      replace(
        s,
        "    if (p === '/' || p === '/*') {",
        "    if (p === '/root' || p === '/*') {  // mutation: it misses /",
      ),
  },
  {
    name: 'M31 TagStore: stale/error has to **keep the old value**',
    file: 'src/main/tags/store.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-store.test.ts'],
    expect: 'keeps the old value',
    apply: (s) =>
      replace(
        s,
        "    if (input.status === 'stale' || input.status === 'error') {\n      const good = this.lastGood.get(input.tag);\n      value = good === undefined ? null : good;\n    } else if",
        "    if (input.status === 'stale' || input.status === 'error') {\n      value = null;  // mutation: the old value is not kept\n    } else if",
      ),
  },
  {
    name: 'M32 the sampler: a truncated section may **not** be published as usual',
    file: 'src/main/tags/sampler.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-sampler.test.ts'],
    expect: 'the **truncated** section (the end marker never arrived) → it reports an error and **publishes no half data**',
    apply: (s) =>
      replace(
        s,
        "          'this section got no end marker — the board only replied halfway (half data is not published)',\n        );\n        continue;\n      }",
        "          'this section got no end marker — the board only replied halfway (half data is not published)',\n        );\n        // mutation: publish it as usual\n      }",
      ),
  },
  {
    name: 'M33 the round trip queue: only one round trip is in flight at a time',
    file: 'src/main/hal/round-trip-queue.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/round-trip-queue.test.ts'],
    expect: '**only one round trip is in flight at any moment** — even when the later one is an action',
    apply: (s) =>
      replace(
        s,
        '    if (this.draining) return;',
        '    // mutation: the re-entry guard is removed → the two chains run on their own',
      ),
  },
  {
    name: 'M34 the scheduler: a missed period has to be **skipped**, not made up',
    file: 'src/main/tags/scheduler.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-scheduler.test.ts'],
    expect: 'skip',
    apply: (s) =>
      replace(
        s,
        '          if (waited > group.intervalMs + slack) {',
        '          if (false) {  // mutation: it never skips',
      ),
  },
  {
    name: 'M35 the scheduler: the sampling has to **go through the queue**, not straight to exec',
    file: 'src/main/tags/scheduler.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-scheduler.test.ts'],
    expect: '**it never calls sampleGroup directly** — everything goes through the queue (P3)',
    apply: (s) =>
      replace(
        s,
        "    void this.queue\n      .run('card-sampling', async () => {",
        '    // mutation: it goes around the queue and samples directly\n    void this.sampler.sampleGroup(group.id);\n    void this.queue\n      .run(\'card-sampling\', async () => {',
      ),
  },
  {
    name: 'M36 the read permission: the coverage decision may not be constantly true (constantly true = a read without permission)',
    file: 'src/main/cards/permissions.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/tags-service.test.ts'],
    expect: 'a tag that is not permitted',
    apply: (s) =>
      replace(
        s,
        '  return perms.read.some((pattern) => matchTagPattern(pattern, tag));',
        '  return true;  // mutation: it covers everything',
      ),
  },
  {
    name: 'M37 the path traversal: a path outside the root has to be blocked',
    file: 'src/main/cards/paths.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/paths.test.ts'],
    expect: 'null',
    apply: (s) =>
      replace(
        s,
        "  if (full !== base && !full.startsWith(base + sep)) return null;",
        "  // mutation: the out of bounds check is not removed",
      ),
  },
  {
    name: 'M38 the manifest: an unknown field has to be reported (a field typed wrong may not be ignored silently)',
    file: 'src/main/cards/manifest.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/manifest.test.ts'],
    expect: 'network',
    apply: (s) =>
      replace(
        s,
        '    if (!allowed.includes(key)) {',
        '    if (false) {  // mutation: an unknown field is not reported',
      ),
  },
  {
    name: 'M39 rule 5: offline means "unverified", not "invalid"',
    file: 'src/main/cards/validate.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/validate.test.ts'],
    expect: '**offline → it is a warning, not an error** ("not verified" is not "not valid")',
    apply: (s) =>
      replace(
        s,
        '    if (ctx.availableActions === null) {',
        '    if (false) {  // mutation: the offline branch is gone',
      ),
  },
  {
    name: 'M40 the bridge: an unknown method has to answer unknown_method (**that is the top Proxy**)',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: '**an unknown name is still answered with unknown_method** (not a TypeError)',
    apply: (s) =>
      replace(
        s,
        "      return () => Promise.resolve({ ok: false, reason: 'unknown_method' });",
        '      return undefined;  // mutation: an unknown method gets no answer',
      ),
  },
  {
    name: 'M40b the bridge: an unknown method of the **namespace layer** has to answer unknown_method as well',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: '**an unknown method inside a namespace is unknown_method as well** (the top level and the namespace are two layers of Proxy)',
    apply: (s) =>
      replace(
        s,
        "        return () => Promise.resolve({ ok: false, reason: 'unknown_method' });",
        '        return undefined;  // mutation: an unknown method gets no answer',
      ),
  },
  {
    name: 'M41 the bridge: the handshake has to carry the instanceId (that is what identifies the caller)',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: 'inst-42',
    apply: (s) =>
      replace(
        s,
        '  const INSTANCE_ID = ${JSON.stringify(instanceId)};',
        "  const INSTANCE_ID = '';  // mutation: it carries no instance id",
      ),
  },
  {
    name: 'M42 the wildcard subscription: the permission filter of the subscription path may not disappear',
    file: 'src/main/cards/tags-service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/tags-service.test.ts'],
    expect: 'the subscription: not a single one that is not permitted is pushed',
    apply: (s) =>
      // **Both have to go**: with a fixed permission set "judged at the
      // subscription" and "judged at the push" are equivalent, so breaking
      // only one of them leaves the other in place → the test stays green
      // (that is not the test's fault, the two places are redundant to begin
      // with)
      replace(
        replace(
          s,
          `    if (!permissionCovers(this.perms, pattern)) return () => undefined;`,
          `    // mutation: the permission is not judged at the subscription`,
        ),
        '      if (!matchTagPattern(pattern, reading.tag)) return;\n      // **The permission is judged again** (iron rule 2)\n      if (!permissionCovers(this.perms, reading.tag)) return;',
        '      if (!matchTagPattern(pattern, reading.tag)) return;\n      // mutation: the permission is not judged when it is pushed',
      ),
  },
  {
    name: 'M43 the storage: the quota of a single key has to hold (otherwise one card fills the disk)',
    file: 'src/main/cards/storage.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/storage.test.ts'],
    expect: 'quota_exceeded',
    apply: (s) =>
      replace(
        s,
        "    if (size > KEY_LIMIT_BYTES) return { ok: false, reason: 'quota_exceeded' };",
        '    // mutation: the quota of a single key is not looked up',
      ),
  },
  {
    name: 'M44 a CSP violation has to be filed under **the right card** (the instance id in the sourceUrl)',
    file: 'src/main/cards/runtime-log.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/runtime-log.test.ts'],
    expect: 'a CSP violation is filed under **the right card**',
    apply: (s) =>
      replace(
        s,
        "  const match = /^cockpit:\\/\\/card\\/([^/]+)\\//.exec(sourceUrl);",
        "  const match = /^(.*)$/.exec(sourceUrl);  // mutation: the instance id is not taken from the sourceUrl",
      ),
  },
  {
    name: 'M45 the runtime candidates: a profile whose board_pack is null has to be dropped',
    file: 'src/main/tags/runtime.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/runtime-retry.test.ts'],
    expect: 'only the profiles that are bound to a board pack are kept — null and the default are both dropped',
    apply: (s) =>
      replace(
        s,
        '    .filter((p) => p.board_pack != null)',
        '    .filter((p) => p.board_pack !== undefined)  // mutation: null is a candidate again',
      ),
  },

  {
    name: 'M46 the shell CSP: frame-src has to allow cockpit: (otherwise not one card installs)',
    file: 'src/main/shell-csp.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/shell-csp.test.ts'],
    expect: '**frame-src has to allow `cockpit:`** — the card is at cockpit://card, the shell at cockpit://app',
    apply: (s) =>
      replace(
        s,
        '"object-src \'none\'; base-uri \'none\'; frame-src cockpit:";',
        '"object-src \'none\'; base-uri \'none\'; frame-src \'none\';";',
      ),
  },
  {
    name: 'M47 the bridge injection: the URL has to carry the instance id (a relative root path eats it)',
    file: 'src/main/cards/protocol.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/protocol.test.ts'],
    expect: '**the injected URL has to be routable by the handler** (a path relative to the root would swallow the instance id)',
    apply: (s) =>
      replace(
        s,
        'return `<script type="module" src="cockpit://card/${id}/__host/bridge.js"></script>`;',
        'return `<script type="module" src="/__host/bridge.js"></script>`;  // mutation: the instance id is eaten',
      ),
  },
  {
    name: 'M48 a CSP violation: the sentence that goes into the log has to say what it wanted to do',
    file: 'src/main/cards/csp-violation.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/csp-violation.test.ts'],
    expect: '**it names the directive and says what it wanted to do**',
    apply: (s) =>
      replace(
        s,
        "  const target = violation.blockedURI === '' ? '(no address)' : violation.blockedURI;",
        "  const target = '';  // mutation: it does not say what it wanted to reach",
      ),
  },
  {
    name: 'M49 the symbolic link: a soft link may not pierce the card directory',
    file: 'src/main/cards/paths.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/paths.test.ts'],
    expect: 'a soft link pointing **outside** the card directory',
    apply: (s) =>
      replace(
        s,
        '    if (!isInside(realBase, realFull)) return null;',
        '    if (!isInside(realBase, realFull)) { /* mutation: the soft link is not judged */ }',
      ),
  },
  {
    name: 'M50 rule 2: the list of ids has to exclude itself (otherwise editing a file once is a "duplicate name")',
    file: 'src/main/cards/wiring.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/wiring.test.ts'],
    expect: '**a second refresh does not judge the card itself as a duplicate**',
    apply: (s) =>
      replace(
        s,
        '      .filter((c) => c.dir !== dir)',
        '      .filter(() => true)  // mutation: it counts itself as well',
      ),
  },
  {
    name: 'M51 the session closes: the unsubscribe function has to be called for real',
    file: 'src/main/cards/session.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/session.test.ts'],
    expect: '**closing the session → the unsubscribe function is called**',
    apply: (s) =>
      replace(
        s,
        '          dispose();',
        '          void 0;  // mutation: the subscription is not released',
      ),
  },
  {
    name: 'M52 the bridge: it has to unwrap (the card wants the value, not the transport envelope)',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: '**on success → the card receives the "value", not the transport envelope**',
    apply: (s) =>
      replace(
        s,
        "      resolve(payload.ok ? payload.value : { ok: false, reason: payload.reason || 'failed' });",
        '      resolve(payload);  // mutation: it hands the envelope to the card as it is',
      ),
  },
  {
    name: 'M53 the subscription limit: one card may not fill up the main process',
    file: 'src/main/cards/session.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/session.test.ts'],
    expect: 'too_many_subscriptions',
    apply: (s) =>
      replace(
        s,
        'export const MAX_SUBSCRIPTIONS_PER_SESSION = 64;',
        'export const MAX_SUBSCRIPTIONS_PER_SESSION = 100000;  // mutation: there is no limit',
      ),
  },
  {
    name: 'M54 the storage directory: it may not land inside the card root (otherwise one write is a loop)',
    file: 'src/main/util/paths.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/card-dirs.test.ts'],
    expect: '**the storage directory is not inside the card root** (otherwise every write of the storage triggers a hot refresh)',
    apply: (s) =>
      replace(
        s,
        "  return join(userDataDir(appName), 'card-storage');",
        "  return join(userDataDir(appName), 'cards');  // mutation: it lands inside the card root",
      ),
  },

  {
    name: 'M55 the CSP listener script: it has to listen for securitypolicyviolation for real',
    file: 'src/main/cards/csp-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/csp-script.test.ts'],
    expect: '**it listens for securitypolicyviolation** (the only reliable signal of a CSP violation in the browser)',
    apply: (s) =>
      replace(
        s,
        "addEventListener('securitypolicyviolation'",
        "addEventListener('nothing-here'",
      ),
  },
  {
    name: 'M56 the bridge: a top level method has to be a function itself (that is the contract)',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: 'the bridge script · the top-level methods are functions',
    apply: (s) =>
      replace(
        s,
        '`  Object.assign(cockpit, {',
        '`  Object.assign(cockpit.nested = {}, {',
      ),
  },
  {
    name: 'M57 the broker: a CSP violation has to be handed to the main process',
    file: 'src/renderer/cards/broker.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/card-broker.test.tsx'],
    expect: 'The card frame broker · CSP violations',
    apply: (s) =>
      replace(
        s,
        "if (data.type === 'cockpit-csp') {",
        "if (false) {",
      ),
  },
  {
    name: 'M58 the protocol: it has to serve __host/csp.js',
    file: 'src/main/cards/protocol.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/protocol.test.ts'],
    expect: 'csp.js',
    apply: (s) =>
      replace(
        s,
        "if (rel === '__host/csp.js') {",
        "if (rel === '__host/nothing.js') {",
      ),
  },
  {
    name: 'M59 the protocol: the CSP listener script has to come before the bridge (the listener has to be early)',
    file: 'src/main/cards/protocol.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/protocol.test.ts'],
    expect: '**the CSP listener comes before the bridge** (it listens early enough for the bridge to use it)',
    apply: (s) =>
      replace(
        s,
        'return injectAtStart(html, cspScriptTag(instanceId) + bridgeTagFor(instanceId));',
        'return injectAtStart(html, bridgeTagFor(instanceId) + cspScriptTag(instanceId));',
      ),
  },

  {
    name: 'M60 the watcher: the user root directory has to be created when it is missing (otherwise the first installed card is never found)',
    file: 'src/main/cards/watcher.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/watcher.test.ts'],
    expect: '**the user root is created when it does not exist** ("a card is a file" needs a place to put the cards)',
    apply: (s) =>
      replace(
        s,
        '          mkdirSync(root.dir, { recursive: true });',
        '          /* mutation: the directory is not created */',
      ),
  },
  {
    name: 'M61 the watcher: after a change it has to attach again (the directory of a newly installed card has to be watched)',
    file: 'src/main/cards/watcher.ts',
    // → **Only on Linux** ✓ — on Windows `fs.watch` on a directory already
    //   reports the subtree ✓ (ReadDirectoryChangesW ✓) → the re-attach
    //   cannot be seen there ✓ → the guard would be judged wrongly ✓.
    only: 'linux',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/watcher.test.ts'],
    expect: '**the directory of a card that was installed after the startup is watched as well** (edit the file and it takes effect)',
    apply: (s) =>
      replace(
        s,
        '      ensureWatching();\n      onChange();',
        '      onChange();  // mutation: it does not attach again',
      ),
  },

  {
    name: 'M62 the instance key has to carry a content fingerprint (otherwise a changed card is not reloaded = "editing a file reloads it" is a lie)',
    file: 'src/main/cards/registry.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/registry.test.ts'],
    expect: '**the card file was changed → the instance id changed** (so the iframe reloads, which is the hot reload of "edit the file and it takes effect")',
    apply: (s) =>
      replace(
        s,
        'const key = `${cardId} ${connectionId ?? \'\'} ${revision}`;',
        'const key = `${cardId} ${connectionId ?? \'\'}`;  // mutation: the fingerprint does not take part',
      ),
  },

  {
    name: 'M63 the layout: a drag has to reach the disk (otherwise the position only lives in the memory and is gone after a restart)',
    file: 'src/main/cards/layout.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/layout.test.ts'],
    expect: '**after a set, get returns the same value** (what was written and what is read back agree)',
    apply: (s) =>
      replace(
        s,
        "    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');",
        '    /* mutation: nothing reaches the disk */',
      ),
  },

  // ── The fake device (the synthetic data of debugging) ─────────────
  //
  // **Why the fake device needs a guard as well**: it feeds a **real kind
  // and a real store** — once it starts making up numbers (instead of
  // handing out the raw text), **values that nobody can explain** show up
  // on the panel, and the person debugging takes them for the real state of
  // the board.

  {
    name: 'M64 the fake device: a file that cannot be read has to give nothing (giving 0 is the false reading of a "busy board")',
    file: 'src/main/hal/fake/exec.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'the file does not exist → not a single byte (so that tag reports unavailable, not 0)',
    apply: (s) =>
      replace(s, "    return device.read(path.text) ?? '';", "    return device.read(path.text) ?? '0';"),
  },
  {
    name: 'M65 the fake device: the variable of the for loop has to be replaced by every item of the glob (otherwise every temperature is empty)',
    file: 'src/main/hal/fake/exec.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'the temperatures are merged by type, not by the number of the zone',
    apply: (s) =>
      replace(
        s,
        `        const substituted = bodyText.replace(
          new RegExp(\`\\\\$\${variable}(?![A-Za-z0-9_])\`, 'g'),
          () => match,
        );`,
        '        const substituted = bodyText;',
      ),
  },
  {
    name: 'M66 the fake device: the profile has to point at a real board pack (otherwise the candidate selection does not pick it)',
    file: 'src/main/hal/fake/profile.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'the fake profile carries a board_pack — otherwise the candidate selection does not pick it',
    apply: (s) => replace(s, "    board_pack: 'rk3588-atk',", "    board_pack: 'rk3588-nonexistent',"),
  },
  {
    name: 'M67 the fake device: a timeout has to time out for real (otherwise the stale state is never seen)',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'the round trip times out → stale, and the previous value is kept (one hiccup may not make the whole instrument disappear)',
    apply: (s) =>
      replace(
        s,
        '      if (this.timeoutEvery > 0 && this.fastRounds % this.timeoutEvery === 0) {',
        '      if (this.timeoutEvery > 0 && this.fastRounds % this.timeoutEvery === 1) {',
      ),
  },
  {
    name: 'M68 the fake device: a broken meminfo is broken (MemAvailable may not be filled in silently)',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'meminfo is broken',
    apply: (s) =>
      replace(
        s,
        '      broken = this.breakMeminfoEvery > 0 && this.meminfoRounds % this.breakMeminfoEvery === 0;',
        '      broken = this.breakMeminfoEvery > 0 && this.meminfoRounds % this.breakMeminfoEvery === 1;',
      ),
  },
  {
    name: 'M69 the fake device: the counter has to move forward (otherwise the usage stays pending forever)',
    file: 'src/main/hal/fake/device.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'the second sample of cpu.usage is ok, and it is a real number between 0 and 100',
    apply: (s) =>
      replace(
        s,
        '    const dt = Math.max(0, (at - this.lastAt) / 1000);',
        '    const dt = 0; // mutation: the counter does not move forward',
      ),
  },
  {
    name: 'M70 the fake device: the terminal banner has to be sent for real (sent at construction = nobody receives it)',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'the banner really has to be sent (at the moment of the construction there is no listener yet, so sending at that moment is sending nothing)',
    apply: (s) =>
      replace(
        s,
        "    this.emit(`⚠ synthetic data (${FAKE_DEVICE_MARKER}) — this is not a real board; type help to see what it can do\\r\\n`);",
        '    /* mutation: the banner is not sent */',
      ),
  },
  {
    name: 'M71 the fake device: it has to be the pipe mode (with a pty the command never matches)',
    file: 'src/main/hal/fake/profile.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'the fake profile declares the pipe mode (with pty=true the host only forwards the raw keys, and the command never matches)',
    apply: (s) => replace(s, '      pty: false,', '      pty: true,'),
  },
  {
    name: 'M72 the fake device: when it fails to load it has to **refuse** (it may not fall back to a real host connection)',
    file: 'src/main/hal/fake/wiring.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-wiring.test.ts'],
    expect: 'the routing: the fake device is only used when it loaded, and when it did not load it is **refused**, it never falls back to a real connection',
    apply: (s) =>
      replace(s, "  return fakeReady ? 'fake' : 'refuse';", "  return 'fake'; // mutation: it always goes through the fake device"),
  },
  {
    name: 'M73 the fake device: the broken meminfo has to be injected for real (otherwise the error state is never seen)',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'meminfo is broken',
    apply: (s) =>
      replace(
        s,
        '      broken = this.breakMeminfoEvery > 0 && this.meminfoRounds % this.breakMeminfoEvery === 0;',
        '      broken = false; // mutation: the meminfo is never broken',
      ),
  },
  {
    name: 'M77 the control plane: a string parameter has to be quoted (unquoted = the injection surface is open)',
    file: 'src/main/actions/encoder.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/encoder.test.ts'],
    expect: 'a string is wrapped in single quotes',
    apply: (s) =>
      replace(
        s,
        "      return quoteShellValue(raw, 'parameter value');",
        '      return raw; // mutation: it is not quoted',
      ),
  },
  {
    name: 'M78 the control plane: the value of an enum has to be looked up for real (not looked up = any value is let through)',
    file: 'src/main/actions/encoder.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/encoder.test.ts'],
    expect: 'an enum value that is not in values is rejected',
    apply: (s) =>
      replace(
        s,
        '      if (!values.includes(raw)) {',
        '      if (values.length === 0) { // mutation: it looks up the wrong thing',
      ),
  },
  {
    name: 'M79 the control plane: the runtime floor re-check has to hit the table for real (a miss = a dangerous action is let through)',
    file: 'src/main/actions/floor-check.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/floor-check.test.ts'],
    expect: 'reboot → matches',
    apply: (s) =>
      replace(
        s,
        '  const match = matchDangerFloorArgv(argv);',
        '  const match = { matched: false, pattern: null, why: null }; // mutation: it does not hit the table',
      ),
  },
  {
    name: 'M80 the control plane: the basename form counts as well (/usr/bin/reboot is as guilty as reboot)',
    file: 'src/main/tags/floor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/floor-check.test.ts'],
    expect: 'the basename counts too (/usr/bin/reboot is as guilty as reboot)',
    apply: (s) => replace(s, '  return baseName(token) === pattern;', '  return false; // mutation: the basename is not looked at'),
  },
  {
    name: 'M87 the control plane: the result has to follow the readback (a readback that does not match may not be reported as ok)',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: 'a readback mismatch is not ok, and verified is false',
    apply: (s) =>
      replace(
        s,
        '    ok: readback.ok,',
        '    ok: true, // mutation: the result of the readback is ignored',
      ),
  },
  {
    name: 'M88 the control plane: the audit line has to carry the readback value (otherwise nobody can trace it afterwards)',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: 'the audit row carries the **params** and the **readback value**',
    apply: (s) => replace(s, '  record(outcome, readback.value);', '  record(outcome); // mutation: the readback value is not written down'),
  },
  {
    name: 'M89 the control plane: the audit line has to carry the parameters (the parameters are half of the trace)',
    file: 'src/main/actions/audit.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/audit.test.ts'],
    expect: 'a newline inside the params must not split the row in two (one action per row)',
    apply: (s) =>
      replace(
        s,
        '    `params=${JSON.stringify(row.params)}`,',
        "    '    params=' + JSON.stringify({}), // mutation: the parameters are not written down",
      ),
  },
  {
    name: 'M83 the control plane: readback form 5 has to be marked verified:false (marking it true = calling an unverified thing verified)',
    file: 'src/main/actions/readback.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/readback.test.ts'],
    expect: 'verified: false',
    apply: (s) =>
      replace(
        s,
        "        ok: true,\n        verified: false,\n        detail: spec.consequence ?? 'this action has no readable state',",
        "        ok: true,\n        verified: true, // mutation: it says \"verified\" for something that is not\n        detail: spec.consequence ?? 'this action has no readable state',",
      ),
  },
  {
    name: 'M84 the control plane: a serial port has no exit code → it has to report unsupported_transport (not "does not match")',
    file: 'src/main/actions/readback.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/readback.test.ts'],
    expect: 'unsupported_transport',
    apply: (s) =>
      replace(
        s,
        "      reason: 'unsupported_transport',\n      detail: 'this connection has no exit code (serial), command_ok cannot be used',",
        "      reason: 'failed', // mutation: it is taken for \"does not match\"\n      detail: 'this connection has no exit code (serial), command_ok cannot be used',",
      ),
  },
  {
    name: 'M81 the queue: four priority levels (an action has to be put in front of a sampling)',
    file: 'src/main/hal/round-trip-queue.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/round-trip-queue.test.ts'],
    expect: 'the four levels: action-verify > manual-refresh > card-sampling > diagnostics',
    apply: (s) =>
      replace(
        s,
        "const PRIORITY: readonly RoundTripKind[] = [\n  'action-verify',\n  'manual-refresh',",
        "const PRIORITY: readonly RoundTripKind[] = [\n  'manual-refresh',\n  'action-verify',",
      ),
  },
  {
    name: 'M82 the queue: a transaction that waits past its deadline has to be dropped (not executed)',
    file: 'src/main/hal/round-trip-queue.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/round-trip-queue.test.ts'],
    expect: 'the queue exceeds the deadline → it reports conn_busy (that transaction is dropped and not executed)',
    apply: (s) =>
      replace(
        s,
        '        if (waited > entry.deadlineMs) {',
        '        if (waited > entry.deadlineMs * 1000) { // mutation: the deadline is nothing but a word',
      ),
  },
  {
    name: 'M90 the fake device: a cat that cannot read the file has to **report an error** (an empty string + 0 = saying "the file is not there" means "the value is empty")',
    file: 'src/main/hal/fake/file-ops.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device-files.test.ts'],
    expect: 'reading a file that does not exist → **an error**, not an empty string',
    apply: (s) =>
      replace(
        s,
        '    return failure(1, `cat: ${path}: No such file or directory`);',
        '    return failure(0, `cat: ${path}: No such file or directory`); // mutation: it pretends to have succeeded',
      ),
  },
  {
    name: 'M91 the fake device: a push has to write into the virtual disk for real (not writing = it reports success without a transfer)',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device-files.test.ts'],
    expect: 'push: the file of the host really enters the virtual fs',
    apply: (s) =>
      replace(
        s,
        '    this.fs.write(target, readFileSync(localPath));',
        '    // mutation: it reads it but does not write it\n    void readFileSync(localPath);',
      ),
  },
  {
    name: 'M92 the bridge: a port that has not arrived yet has to **wait** (answering not_connected at once = the card silently does nothing)',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: 'a call has to **wait for the port** instead of answering not_connected at once',
    apply: (s) =>
      replace(
        s,
        '    if (port !== null) return post(method, args);',
        '    if (true) return Promise.resolve({ ok: false, reason: \'not_connected\' }); // mutation: it does not wait',
      ),
  },
  {
    name: 'M93 the control plane: the readback value has to be inside `readback` (flat = it does not match the contract spec/04 §2.4)',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: 'the value that was read back is in `readback` (contract spec/04 §2.4 / spec/03 §5.2)',
    apply: (s) =>
      replace(
        s,
        '          readback: {',
        '          readback_flat: { // mutation: it flattens the readback (the contract wants it nested)',
      ),
  },
  {
    name: 'M94 the workflow pack: an unknown field has to be reported (ignoring it silently = the workflow runs on and does one thing less)',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: '**fields other than description and version are not accepted** (closed schema)',
    apply: (s) =>
      replace(
        s,
        "      fail(`Unknown field '${key}'`, ctx.source, { path: `${ctx.path}${path}${path ? '.' : ''}${key}` });",
        '      void key; // mutation: an unknown field is ignored silently',
      ),
  },
  {
    name: 'M95 the workflow layer: the **exclusion list** of the discovery has to exclude for real (missing one = an intermediate file is sent up as a product)',
    file: 'src/main/workflows/discover.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/discover.test.ts'],
    expect: 'it is found by the pattern, **the ones of the exclusion list are not**',
    apply: (s) =>
      replace(
        s,
        '.filter((entry) => !excluded.some((rule) => matchesPattern(entry.name, rule)))',
        '.filter(() => true) // mutation: the exclusion list is ignored',
      ),
  },
  {
    name: 'M96 the target registry: a profile that does not exist has to **report an error** (it may not quietly connect to another target)',
    file: 'src/main/workflows/targets.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/targets.test.ts'],
    expect: '**the profile does not exist → it reports an error** (it never quietly connects to another target)',
    apply: (s) =>
      replace(
        s,
        '    if (profile === undefined) {',
        '    if (false) { // mutation: it connects to another target',
      ),
  },
  {
    name: 'M97 the workflow layer: a cross target criterion has to be **read on the named role** (reading it on the guest = a false positive)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '**the criterion is read on the named role** (ask the board on the board)',
    apply: (s) =>
      replace(
        s,
        '  const result = await runReadbackOnRole(ctx, readRole, step.readback, substitution);',
        '  const result = await runReadbackOnRole(ctx, stepRole ?? readRole, step.readback, substitution); // mutation: it reads on the role of this step',
      ),
  },
  {
    name: 'M99 the workflow layer: the output of a command has to **go into the slot** (the next step needs it ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: 'the `out` slot',
    apply: (s) =>
      replace(
        s,
        '  if (step.out !== undefined && outcome.output !== undefined) {',
        '  if (false) { // mutation: the output does not go into the slot',
      ),
  },
  {
    name: 'M100 the fake device: **every role** has to go through the fake device (only one = the workflow layer cannot be rehearsed)',
    file: 'src/main/hal/fake/wiring.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-wiring.test.ts'],
    expect: 'fake device',
    apply: (s) =>
      replace(
        s,
        '  if (!fakeProfileIds(env).includes(profileId)) return \'not-fake\';',
        "  if (profileId !== 'fake-board') return 'not-fake'; // mutation: it only knows one role",
      ),
  },
  {
    name: 'M101 the workflow layer: an input in a command has to **use the encoded fragment** (the raw value = the injection surface is open)',
    file: 'src/main/workflows/substitute.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: 'the inputs are **encoded by type** (`; reboot` stays a literal)',
    apply: (s) =>
      replace(
        s,
        '    const encoded = ctx.encoded[name];',
        '    const encoded = ctx.inputs[name] === undefined ? undefined : String(ctx.inputs[name]); // mutation: the raw value',
      ),
  },
  {
    name: 'M102 the workflow pack: the placement has to be in the **closed vocabulary** (a typo = it lands in the wrong place silently)',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: '**placement must be in the closed vocabulary** (a misspelling is reported, it may not silently fall back)',
    apply: (s) =>
      replace(
        s,
        '    if (!isPlacement(placement)) {',
        '    if (false) { // mutation: the vocabulary is not looked up',
      ),
  },
  {
    name: 'M103 the control plane: the **verification command** of a readback has to pass the danger floor as well (a command from the pack may not run a dangerous command in the name of "verification")',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: 'executor · the verification command of the readback also passes the danger floor',
    apply: (s) =>
      replace(
        s,
        '          const verifyFloor = checkFloor(cmd);',
        '          const verifyFloor = { verdict: "ok", matched: false }; // mutation: the floor is not looked up',
      ),
  },
  {
    name: 'M105 the workflow layer: a role fact has to be **quoted** (the profile is half trusted → it may not be spliced in raw)',
    file: 'src/main/workflows/substitute.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: 'the role facts are **quoted** (a profile is only half trusted, so it may not be interpolated as it is)',
    apply: (s) =>
      replace(
        s,
        "    return typeof value === 'number' ? String(value) : quoteShellValue(String(value), 'connection fact');",
        '    return String(value); // mutation: it is spliced in raw',
      ),
  },
  {
    name: 'M111 the workflow service: **a resume starts at the step it stopped at** (the earlier steps do not run again ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: 'resume',
    apply: (s) =>
      replace(
        s,
        '    if (index < startAt) continue;',
        '    // mutation: a resume runs everything from the beginning again',
      ),
  },
  {
    name: 'M112 the audit line: it has to carry the **final command** (the first link of the trace ✓)',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: 'the command that runs is the encoded one',
    apply: (s) =>
      replace(
        s,
        '      command,\n      ...(deps.auditInputs === undefined ? {} : { inputs: deps.auditInputs }),',
        '      ...(deps.auditInputs === undefined ? {} : { inputs: deps.auditInputs }), // mutation: the command does not go into the audit line',
      ),
  },
  {
    name: 'M113 the audit line: the **input values** of the workflow have to go in (otherwise nobody sees which project was used afterwards ✓)',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: 'the audit row of the workflow carries **the inputs of this step** (the arguments of a workflow live in the workflow pack, not in the board pack)',
    apply: (s) =>
      replace(
        s,
        '      ...(deps.auditInputs === undefined ? {} : { inputs: deps.auditInputs }),',
        '      // mutation: the inputs do not go into the audit line',
      ),
  },
  {
    name: 'M114 the card validation: the **workflow half** of rule 3 (declared but not authorised → it is reported ✓)',
    file: 'src/main/cards/validate.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/validate.test.ts'],
    expect: '**it is declared but not granted → it is reported** (rule 3 may not have an exception)',
    apply: (s) =>
      replace(
        s,
        "  for (const workflowId of requires.workflows ?? []) {",
        '  for (const workflowId of [] as string[]) { // mutation: the workflow half is not looked up',
      ),
  },
  {
    name: 'M117 the workflow service: **the same workflow may only run once at a time** (two workflows on one line cross the wires ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**the same workflow may only run once at a time** (two workflows fighting over one serial port would cross the wires)',
    apply: (s) =>
      replace(
        s,
        "      if (existing.workflowId === id && existing.state === 'running') {",
        "      if (false) { // mutation: it does not block the concurrency",
      ),
  },
  {
    name: 'M120 the workflow pack: the version key has to match the contract (`apiVersion`, **not** formatVersion ✓)',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: 'apiVersion accepts only devboard/v1 (**the same vocabulary as the board pack and the card manifest**)',
    apply: (s) =>
      replace(
        s,
        "  if (raw['apiVersion'] !== KNOWN_API_VERSION) {",
        "  if (raw['apiVersion'] !== 'devboard/v2') { // mutation: the version key has drifted",
      ),
  },
  {
    name: 'M121 the workflow pack: `default` has to be legal itself (the host may not pre-fill an illegal value ✓)',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: '**the `default` itself must be valid** (the host may not prefill an invalid value)',
    apply: (s) =>
      replace(
        s,
        '    if (def.default !== undefined) checkDefault(def, name, ctx);',
        '    // mutation: the default is not verified',
      ),
  },
  {
    name: 'M122 the HAL: a cancel has to **kill the process for real** (not "stop waiting" ✓ — the symptom of the vanguard ✓)',
    file: 'src/main/util/spawn.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/spawn-abort.test.ts'],
    expect: '**the process really was killed** (not "we stopped waiting")',
    apply: (s) =>
      replace(
        s,
        '      try {\n        child.kill(\'SIGTERM\');\n      } catch {\n        // If it has already exited, fine\n      }\n      setTimeout(() => {\n        try {\n          child.kill(\'SIGKILL\');\n        } catch {\n          // If it is already gone, fine\n        }\n      }, 200);',
        '      // mutation: **it only stops waiting** (the symptom of the vanguard ✓ — the process keeps running in the background ✗)',
      ),
  },
  {
    name: 'M123 the workflow layer: a **cancel** has to turn the state into cancelled (not failed ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**cancelling**: the state becomes cancelled (**not failed**)',
    apply: (s) =>
      replace(
        s,
        "    status.state = 'cancelled';",
        "    status.state = 'failed'; // mutation: the cancel is taken for a failure",
      ),
  },
  {
    name: 'M124 the workflow layer: the settling after a **cancel** may not turn the state back ✓ (C-1 of the independent review 40 ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**when it finishes on its own after the cancellation, it may not turn the state back** (after the unwind of the await it is still cancelled)',
    apply: (s) =>
      replace(
        s,
        "      if (status.state !== 'cancelled') {",
        '      if (true) { // mutation: the settling turns the "cancel" back',
      ),
  },
  {
    name: 'M125 the workflow layer: cancelling a run that **already ended** → not one character of the state changes (idempotent ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**cancelling a run that already finished → the state does not change** (idempotent — it may not turn done into cancelled)',
    apply: (s) =>
      replace(
        s,
        "    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') {",
        '    if (false) { // mutation: it changes the state even for a run that already ended',
      ),
  },
  {
    name: 'M126 the executor: cancelled → the reason is cancelled (not "the readback does not match" ✓)',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**the cancelled step gets the reason cancelled** (not "the readback did not match" — the operator stopped it, the board did not disobey)',
    apply: (s) =>
      replace(
        s,
        '  if (execResult.cancelled === true) {',
        '  if (false) { // mutation: it takes the "cancel" for "it ran"',
      ),
  },
  {
    name: 'M127 the workflow layer: stopped by a person → **the next step does not run** (the person does not want it, so it goes no further ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '**it was stopped → the later step does not run** (the operator no longer wants it, so it does not go on)',
    apply: (s) =>
      replace(
        s,
        "    if (opts.signal?.aborted === true) break;\n    const stage = await runStep(step, {",
        "    // mutation: it keeps going after it was called off\n    const stage = await runStep(step, {",
      ),
  },
  {
    name: 'M128 the workflow layer: stopped by a person → **the cross target criterion does not run** (after a cancel nobody waits for one more command ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '**it was stopped → the cross-target criterion does not run** (after a cancellation nobody should wait for another command)',
    apply: (s) =>
      replace(
        s,
        '  if (ctx.opts.signal?.aborted === true) return undefined;',
        '  if (false) return undefined; // mutation: it still reads back after the cancel',
      ),
  },
  {
    name: 'M130 the workflow layer: a **cancel** has to write an audit line ("who called it off" has to be traceable — I-8 of the independent review 40 ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**a cancellation records one audit row** (who stopped it can be looked up)',
    apply: (s) =>
      replace(
        s,
        '    // One audit line is written ("who called it off" has to be traceable — I-8 of the independent review 40)\n    this.opts.runDeps.audit({\n      at: this.now(),\n      actor: \'host\',\n      actionId: `workflow:${status.workflowId}:cancel`,\n      params: { runId },\n      ok: true,\n      verified: true,\n      detail: \'a human called this run off\',\n    });',
        '    // mutation: no audit line is written',
      ),
  },
  {
    name: 'M131 the readback: the command was cancelled → the reason says "cancelled" (not "the readback does not match" ✓)',
    file: 'src/main/actions/readback.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/readback.test.ts'],
    expect: '**the command of the action was cancelled** → the reason is cancelled (**not a mismatch**)',
    apply: (s) =>
      replace(
        s,
        '  if (actionResult.cancelled === true) {',
        '  if (false) { // mutation: it says "does not match" for a "cancel"',
      ),
  },
  {
    name: 'M132 the workflow layer: the `status` has to say **which step it is at right now** (the interface may not be dead silent ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**half way through, `status` states "which step it is at and since when"** (the interface may not be dead silent)',
    apply: (s) =>
      replace(
        s,
        '              status.current = { stepId: info.stepId, kind: info.kind, at: info.at };',
        '              status.current = null; // mutation: it does not say "which step it is at right now"',
      ),
  },
  {
    name: 'M133 the workflow layer: the **timeline fills while it runs** (not only when it is done ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**the timeline is filled while it runs** (not only when it is over)',
    apply: (s) =>
      replace(
        s,
        '              status.stages = [...status.stages, stage];',
        '              // mutation: it is not reported in real time',
      ),
  },
  {
    name: 'M134 the workflow layer: a transfer that did not work → **the half file has to be removed** (no leftovers ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: 'the transfer did not succeed → **the half-written file is removed** (no residue is left)',
    apply: (s) =>
      replace(
        s,
        '  const command = `rm -f -- ${quotePath(path)}`;',
        '  const command = `true`; // mutation: it is not cleaned up',
      ),
  },
  {
    name: 'M135 the workflow layer: the destination **was there already** → **it may not be deleted** (do not delete the user\'s things ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: 'the destination **already has** that file → **it may not be deleted** (the user\'s data stays)',
    apply: (s) =>
      replace(
        s,
        "  if (before !== 'not-there') {",
        '  if (false) { // mutation: it deletes the files of the user as well',
      ),
  },
  {
    name: 'M136 the workflow layer: the **cleanup path has to be encoded** (`to.path` comes from the pack ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '**the cleanup path must be encoded** (`to.path` comes from the pack, and an unencoded path is an injection surface)',
    apply: (s) =>
      replace(
        s,
        '  const command = `rm -f -- ${quotePath(path)}`;',
        '  const command = `rm -f -- ${path}`; // mutation: it is not encoded',
      ),
  },
  {
    name: 'M137 the workflow layer: **it was transferred but not verified** → **it is not removed** (that is not "the transfer failed" ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '**it was transferred but not verified** → **it is kept** (that is not the same as "not transferred") and the reason is stated',
    apply: (s) =>
      replace(
        s,
        '  const commandFailed = !outcome.ok;',
        '  const commandFailed = true; // mutation: it also cleans up a "transferred but not verified" one',
      ),
  },
  {
    name: 'M138 the card session: the authorisation of a workflow looks at **its own dimension** (it may not be mixed into permissions.write ✓)',
    file: 'src/main/cards/session.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/session.test.ts'],
    expect: 'the session · the **fourth dimension of authorisation** of a workflow (contract §3.3)',
    apply: (s) =>
      replace(
        s,
        "        api.permission === 'write' ? session.perms.write : (session.perms.workflows ?? []);",
        '        session.perms.write; // mutation: the two dimensions are mixed into one',
      ),
  },
  {
    name: 'M139 the workflow state on the card side: a **reduced projection** (not one of the path, the role, the details or the audit number ✓ — V3-M7 ✓)',
    file: 'src/main/cards/workflow-view.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/workflow-view.test.ts'],
    expect: '**every step keeps only the few fields the contract names**',
    apply: (s) =>
      replace(
        s,
        `    stages: status.stages.map((stage) => ({
      stepId: stage.stepId,
      kind: stage.kind,
      ok: stage.ok,
      verified: stage.verified,
      ...(stage.reason === undefined ? {} : { reason: stage.reason }),
    })),`,
        '    stages: status.stages.map((stage) => ({ ...stage })), // mutation: it leaks all of it',
      ),
  },
  {
    name: 'M140 the card validation **rule 14**: a workflow permission may not be a wildcard (contract §9 ✓)',
    file: 'src/main/cards/validate.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/validate.test.ts'],
    expect: 'rule 14 · workflow permissions (the last one of contract §9)',
    apply: (s) =>
      replace(
        s,
        "  for (const id of perms.workflows ?? []) {\n    if (id.includes('*')) {",
        "  for (const id of perms.workflows ?? []) {\n    if (false) {",
      ),
  },
  {
    name: 'M141 the card validation **rule 14**: a workflow the host does not have → it is reported ✓',
    file: 'src/main/cards/validate.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/validate.test.ts'],
    expect: 'rule 14 · workflow permissions (the last one of contract §9)',
    apply: (s) =>
      replace(
        s,
        "    } else if (!ctx.availableWorkflows.includes(id)) {",
        "    } else if (false) {",
      ),
  },
  {
    name: 'M144 the workflow layer: the **exception path** may not turn a "cancel" into failed ✓ (I-1 of the independent review 40 ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '**an exception after the cancellation → the state is still cancelled** (not failed)',
    apply: (s) =>
      replace(
        s,
        "    } catch (err) {\n      // A cancelled run → the state may not be turned back by this\n      // exception path (I-1 of the independent review 40)\n      // → \"The human called it off\" has to survive to the end (contract\n      //   section 8·A·A2 — a cancellation is not a failure)\n      if (status.state !== 'cancelled') {",
        "    } catch (err) {\n      // mutation: the exception path turns the \"cancel\" into failed\n      if (true) {",
      ),
  },
  {
    name: 'M145 the workflow layer: **a step that failed still has its line** (an exception may not cut through the whole run ✓ — I-2 of the independent review 40 ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '**the target cannot be reached → there is a row on the timeline** (the whole run is not thrown)',
    apply: (s) =>
      replace(
        s,
        '    const detail = err instanceof Error ? err.message : String(err);',
        '    throw err; // mutation: the exception cuts through the whole run (the timeline does not even get a line ✗)\n    const detail = err instanceof Error ? err.message : String(err);',
      ),
  },
  {
    name: 'M146 the workflow pack: **the from.path of a file.transfer is required** (contract §4.4 ✓)',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: '**a from without a path is reported by the validator** (it must not be left to explode at runtime)',
    apply: (s) =>
      replace(
        s,
        "      if (step.from.path === undefined) {\n        fail('the from of a file.transfer step must declare path (the path on the source side)', ctx.source);\n      }",
        '      // mutation: it does not take from.path (it only crashes at runtime ✗)',
      ),
  },
  {
    name: 'M147 the workflow layer: the **value mode also gets the default** (both substitution modes have to have it ✓ — I-3 of the independent review 40 ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '**the value form also receives the default** (the expect of a readback uses the value form)',
    apply: (s) =>
      replace(
        s,
        '  const mergedInputs: Record<string, unknown> = { ...defaults, ...inputs };',
        '  const mergedInputs: Record<string, unknown> = inputs; // mutation: the value mode does not get the default',
      ),
  },
  {
    name: 'M148 on the card side: an input declaration has to carry a **default** (the card can pre-fill it itself ✓ — I-3 of the independent review 40 ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: 'the input declarations in the list **carry the default** (the card has to be able to prefill it)',
    apply: (s) =>
      replace(
        s,
        '              ...(def.default === undefined ? {} : { default: def.default }),',
        '              // mutation: the card gets no default',
      ),
  },
  {
    name: 'M149 the workflow pack validation **rule 11**: a destructive step may not have `readback.kind: none` ✓',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: '**a destructive step may not use `readback.kind: none`** (an irreversible action may not skip verification)',
    apply: (s) =>
      replace(
        s,
        "  if (step.danger === 'destructive' && step.readback?.kind === 'none') {",
        '  if (false) { // mutation: rule 11 is not executed',
      ),
  },
  {
    name: 'M152 several cards: **two cards on one board → the round trips do not cross** (the same queue ✓ — on a serial port nothing crosses over ✓)',
    file: 'src/main/tags/runtime.ts',
    check: ['npx', 'vitest', 'run', 'tests/integration/multi-card-contention.test.ts'],
    expect: 'actions called at the same time do not interleave their round trips (one queue — no talking over each other on a serial line)',
    apply: (s) =>
      replace(
        s,
        "    return this.queue.run('action-verify', () => fn(connection));",
        '    return fn(connection); // mutation: it does not go through the queue (two cards cross over ✗)',
      ),
  },
  {
    name: 'M153 MCP: **a malicious Origin → 403** (the first line of defence against a DNS rebinding ✓ — contract §7.1 ✓)',
    file: 'src/main/mcp/security.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/security.test.ts'],
    expect: '**a malicious Origin → 403** (a cross-site request from a web page)',
    apply: (s) =>
      replace(
        s,
        "  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';",
        '  return true; // mutation: every Origin is let through',
      ),
  },
  {
    name: 'M154 MCP: **another host name → 403** (the second line of defence against a DNS rebinding ✓ — contract §7.1 ✓)',
    file: 'src/main/mcp/security.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/security.test.ts'],
    expect: '**another host name → 403** (the other half of DNS rebinding)',
    apply: (s) =>
      replace(
        s,
        "  return name === '127.0.0.1' || name === 'localhost' || name === '::1';",
        '  return true; // mutation: every host name is let through',
      ),
  },
  {
    name: 'M155 MCP: **the Bearer authentication has to match** (a wrong token → 401 ✓ — contract §7.1 ✓)',
    file: 'src/main/mcp/security.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/security.test.ts'],
    expect: '**the wrong token → 401**',
    apply: (s) =>
      replace(
        s,
        '  if (a.length !== b.length) return false;',
        '  // mutation: it lets it through even when the length differs',
      ),
  },
  {
    name: 'M156 MCP: **no Origin → let it through** (it is not a browser client ✓ — contract §7.1 "present and not legal" ✓)',
    file: 'src/main/mcp/security.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/security.test.ts'],
    expect: '**no Origin → let through** (a client that is not a browser, such as an agent itself)',
    apply: (s) =>
      replace(
        s,
        "  if (origin === undefined || origin === '') return true;",
        "  if (origin === undefined || origin === '') return false; // mutation: it refuses even without an Origin",
      ),
  },
  {
    name: 'M157 the MCP discovery file: **write the .tmp first and rename it atomically** (an agent may not read half a file ✓ — contract §7.2 ✓)',
    file: 'src/main/mcp/discovery.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/discovery.test.ts'],
    expect: '**half a file cannot be read while it is written** (a temporary file is written first and then renamed atomically)',
    apply: (s) =>
      replace(
        s,
        '  renameSync(tmp, path);',
        '  writeFileSync(path, readFileSync(tmp, \'utf8\'), { encoding: \'utf8\' }); // mutation: it is not renamed atomically',
      ),
  },
  {
    name: 'M158 the MCP discovery file: **the mode 0600** (the token may not be read by another user on the same machine ✓ — contract §7.2 ✓)',
    file: 'src/main/mcp/discovery.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/discovery.test.ts'],
    expect: 'readable by the current user only',
    apply: (s) =>
      replace(
        s,
        "  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\\n`, { encoding: 'utf8', mode: 0o600 });",
        "  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\\n`, { encoding: 'utf8' }); // mutation: the permission is not pinned",
      ),
  },
  {
    name: 'M159 the MCP discovery file: **it has to be removed on exit** (no discovery file pointing at a dead process ✓ — contract §7.2 ✓)',
    file: 'src/main/mcp/discovery.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/discovery.test.ts'],
    expect: '**once it is deleted it is gone** (the GUI cleans it up on exit)',
    apply: (s) =>
      replace(
        s,
        '    rmSync(path, { force: true });',
        '    // mutation: it is not deleted',
      ),
  },
  {
    name: 'M162 MCP: **`list_workflows` gives only the keys the contract names** (one key more = one thing more leaks ✓ — contract §2.4 ✓)',
    file: 'src/main/mcp/server.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/server.test.ts'],
    expect: 'only the id, the name and the input declarations',
    apply: (s) =>
      replace(
        s,
        '            inputs: w.inputs,\n          })),',
        '            inputs: w.inputs,\n            version: w.version,\n          })),',
      ),
  },
  {
    name: 'M163 MCP: **a failing tool answers ok:false + reason** (it throws no exception ✓ — contract §4 ✓)',
    file: 'src/main/mcp/server.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/server.test.ts'],
    expect: '`run_workflow` runs a workflow **without such a pack** → **it fails** (it does not quietly run anyway)',
    apply: (s) =>
      replace(
        s,
        '          return withVersion(\n            failure(reasonOf(err), err instanceof Error ? err.message : String(err)),\n          );',
        "          return withVersion({ ok: true, run_id: 'wf-bogus' }); // mutation: a failure is reported as a success",
      ),
  },
  {
    name: 'M164 MCP: **every response carries the apiVersion** (contract §4 ✓)',
    file: 'src/main/mcp/convention.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/server.test.ts'],
    expect: '**every response carries apiVersion** (contract §4: the version field is on every response)',
    apply: (s) =>
      replace(
        s,
        '  return { apiVersion: API_VERSION, ...value };',
        '  return value as T & { apiVersion: string }; // mutation: it carries no version',
      ),
  },
  {
    name: 'M165 MCP HTTP: **a malicious Origin → 403** (a DNS rebinding ✓ — only a real HTTP server can verify it ✓)',
    file: 'src/main/mcp/http.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/http.test.ts'],
    expect: '**a malicious Origin → 403** (DNS rebinding)',
    apply: (s) =>
      replace(
        s,
        "  if (!checkOrigin(typeof origin === 'string' ? origin : undefined)) {",
        '  if (false) { // mutation: the Origin is not verified',
      ),
  },
  {
    name: 'M166 MCP HTTP: **no token → 401** (contract §7.1 ✓)',
    file: 'src/main/mcp/http.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/http.test.ts'],
    expect: '**no token → 401**',
    apply: (s) =>
      replace(
        s,
        "  if (!checkAuthorization(typeof auth === 'string' ? auth : undefined, opts.token)) {",
        '  if (false) { // mutation: the token is not verified',
      ),
  },
  {
    name: 'M167 MCP HTTP: **it binds 127.0.0.1 only** (contract §7.1 ✓ — it may not bind 0.0.0.0 ✓)',
    file: 'src/main/mcp/http.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/http.test.ts'],
    expect: '**it binds 127.0.0.1 only** (contract §7.1 — it may not bind 0.0.0.0)',
    apply: (s) =>
      replace(
        s,
        "  if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {",
        '  if (false) { // mutation: it binds to any address',
      ),
  },
  {
    name: 'M168 MCP HTTP: **a notification → 202 with an empty body** (the specification "Sending Messages" ✓)',
    file: 'src/main/mcp/http.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/http.test.ts'],
    expect: '**a notification → 202 with an empty body** (specification, "Sending Messages", item 4)',
    apply: (s) =>
      replace(
        s,
        '  if (reply === null) {\n    res.writeHead(202);',
        '  if (false) { // mutation: the notification answers 200 as well',
      ),
  },
  {
    name: 'M169 the MCP read side: **the command of `exec_regex` is not given to the agent** ✓ (contract §1.3 ✓)',
    file: 'src/main/tags/pack-view.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags/pack-view.test.ts'],
    expect: 'command',
    apply: (s) =>
      replace(
        s,
        "  exec_regex: ['pattern', 'format'],",
        "  exec_regex: ['pattern', 'format', 'command'],",
      ),
  },
  {
    name: 'M170 the MCP read side: **the host path and the interpreter of `script` are not given to the agent** ✓',
    file: 'src/main/tags/pack-view.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags/pack-view.test.ts'],
    expect: '**neither the host path nor the interpreter of `script` is given** (it would leak the directory structure of the host)',
    apply: (s) =>
      replace(
        s,
        "  script: [],",
        "  script: ['path', 'interpreter', 'format'],",
      ),
  },
  {
    name: 'M171 the MCP read side: **the field of `list_tags` is `name`, not `tag`** ✓ (contract §2.1 ✓)',
    file: 'src/main/mcp/read-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/read-tools.test.ts'],
    expect: 'name',
    apply: (s) =>
      replace(
        s,
        "      name: reading.tag,",
        "      tag: reading.tag,",
      ),
  },
  {
    name: 'M172 the MCP read side: **`list_tags` has to compute `source_reader`** ✓ (**without it everything is null** ✓)',
    file: 'src/main/mcp/read-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/read-tools.test.ts'],
    expect: 'source_reader',
    apply: (s) =>
      replace(
        s,
        "      source_reader: sourceReaderOf(reading.tag, pack),",
        "      source_reader: null,",
      ),
  },
  {
    name: 'M173 the MCP read side: **the status of a reader is a mapping** ✓ (**not constantly ok** ✓)',
    file: 'src/main/mcp/read-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/read-tools.test.ts'],
    expect: 'status',
    apply: (s) =>
      replace(
        s,
        "  if (mine.some((r) => r.status === 'error')) return 'error';",
        "  if (false) return 'error';",
      ),
  },
  {
    name: 'M174 the MCP write side: **`dry_run` does not execute** ✓ (contract §2.4 ✓)',
    file: 'src/main/mcp/action-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/action-tools.test.ts'],
    expect: '**it does not run** · **it writes no audit row** ("it is not an attempt")',
    apply: (s) =>
      replace(
        s,
        "  if (opts.dryRun === true) {",
        "  if (false) {",
      ),
  },
  {
    name: 'M175 the MCP write side: **`dry_run` comes before the confirmation** ✓ (**otherwise there is no preview of a destructive step** ✓)',
    file: 'src/main/mcp/action-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/action-tools.test.ts'],
    expect: 'dry_run',
    apply: (s) =>
      replace(
        s,
        "  if (opts.dryRun === true) {\n    return {\n      ok: true,\n      dry_run: true,",
        "  if (opts.dryRun === true) {\n    return {\n      ok: false,\n      reason: 'needs_confirmation',\n      dry_run: false,",
      ),
  },
  {
    name: 'M177 the MCP write side: **the action does not exist → `not_found`** ✓ (**not `denied`** ✓)',
    file: 'src/main/mcp/action-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/action-tools.test.ts'],
    expect: 'not_found',
    apply: (s) =>
      replace(
        s,
        "    return { ok: false, reason: 'not_found', detail: `No such action: ${actionId}` };\n  }\n\n  // **② The unified permission area is the gate of the agent side** ✓",
        "    return { ok: false, reason: 'denied', detail: `No such action: ${actionId}` };\n  }\n\n  // **② The unified permission area is the gate of the agent side** ✓",
      ),
  },
  {
    name: 'M178 the MCP card: **`missing_tags` and `unreadable_tags` are separate** ✓ (**mixed together the agent is deceived** ✓)',
    file: 'src/main/cards/state.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/state.test.ts'],
    expect: 'unreadable',
    apply: (s) =>
      replace(
        s,
        "    unreadable_tags: unreadable,",
        "    unreadable_tags: [],",
      ),
  },
  {
    name: 'M179 the MCP card: **a wildcard instance that is absent from the readings does not count as missing** ✓ (the sampler does not guess the concrete name ✓)',
    file: 'src/main/cards/state.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/state.test.ts'],
    expect: '**a wildcard instance is absent from the readings → it is not listed** (that means "not on the board / not sampled yet")',
    apply: (s) =>
      replace(
        s,
        "  for (const pattern of manifest.permissions.read) {\n    if (!isProvided(pack, pattern)) out.push(pattern);\n  }",
        "  for (const pattern of manifest.permissions.read) {\n    out.push(pattern);\n  }",
      ),
  },
  {
    name: 'M180 the MCP read side: **`connected` has to look at whether the runtime is `running`** ✓ (**looking at the profileId alone reports it wrongly** ✓)',
    file: 'src/main/mcp/wiring.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/wiring.test.ts'],
    expect: 'connected',
    apply: (s) =>
      replace(
        s,
        "      if (status.state === 'running' && status.profileId === profileId) return true;",
        "      if (status.profileId === profileId) return true;",
      ),
  },
  {
    name: 'M185 the living SDK documentation: **the API list comes from the registry** ✓ (**a hand written one drifts** ✓)',
    file: 'src/main/mcp/sdk-docs.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/sdk-docs.test.ts'],
    expect: 'tags.get',
    apply: (s) =>
      replace(
        s,
        "  for (const api of cardApis()) {",
        "  for (const api of []) {",
      ),
  },
  {
    name: 'M186 the living SDK documentation: **an API that is not implemented is not listed** ✓ (**listing it = the card believes it can call it** ✓)',
    file: 'src/main/mcp/sdk-docs.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/sdk-docs.test.ts'],
    expect: 'notify',
    apply: (s) =>
      replace(
        s,
        "    lines.push(`## cockpit.${api.name}`);",
        "    lines.push(`## cockpit.${api.name}`);\n    if (api.name === 'capabilities') lines.push('cockpit.notify');",
      ),
  },
  {
    name: 'M187 the living SDK documentation: **every method has to carry one sentence** ✓ (**a name alone does not tell the agent when to use it** ✓)',
    file: 'src/main/cards/api-registry.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/sdk-docs.test.ts'],
    expect: '**every method carries a sentence of explanation** (**the name alone is not enough** — the agent does not know when to use it)',
    apply: (s) =>
      replace(
        s,
        "      name: 'tags.get',\n      summary: 'Read the current value and status of a tag. **Use this to read a number for a panel**.',",
        "      name: 'tags.get',",
      ),
  },
  {
    name: 'M188 the living SDK documentation: **the example card is a real card** ✓ (**an invented one does not match the reality** ✓)',
    file: 'src/main/mcp/sdk-docs.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/sdk-docs.test.ts'],
    expect: 'cpu-usage',
    apply: (s) =>
      replace(
        s,
        '      const tags = Array.isArray(perms.read)\n        ? perms.read.filter((t): t is string => typeof t === \'string\')\n        : [];',
        "      const tags: string[] = []; // mutation: the example card does not list the read permission",
      ),
  },
  {
    name: 'M193 installing a card through MCP: **a broken manifest is not installed** ✓ (**not "install a broken card"** ✓)',
    file: 'src/main/mcp/card-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/card-tools.test.ts'],
    expect: 'manifest',
    apply: (s) =>
      replace(
        s,
        "    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, path);",
        "    manifest = parseManifest({ apiVersion: 'devboard/v1', kind: 'Card', id: 'x', name: 'x', version: '1', entry: 'index.html', permissions: { read: [], write: [] } }, path);",
      ),
  },
  {
    name: 'M194 the MCP workflow dry_run: **not one step runs** ✓ (**it is a preview** ✓)',
    file: 'src/main/mcp/workflow-dry-run.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/workflow-dry-run.test.ts'],
    expect: '**no step is executed** (**it is a preview**)',
    apply: (s) =>
      replace(
        s,
        "  return { ok: true, steps };",
        "  return { ok: true, steps, run_id: 'wf-dry-run' }; // mutation: the preview also produces a run_id",
      ),
  },
  {
    name: 'M195 the MCP workflow dry_run: **the danger level has to be given** ✓ (**the agent has to know which step destroys things** ✓)',
    file: 'src/main/mcp/workflow-dry-run.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/workflow-dry-run.test.ts'],
    expect: '**the danger level is given** (**the agent has to know which step destroys things**)',
    apply: (s) =>
      replace(
        s,
        "    danger: step.danger ?? 'reversible',",
        "    danger: 'reversible', // mutation: the danger level the step declares itself is not looked at",
      ),
  },
  {
    name: 'M196 the MCP promote: **the host only records "who wants the full screen"** ✓ (**laying out the rows is the renderer\'s business** ✓)',
    file: 'src/main/mcp/promote.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/promote.test.ts'],
    expect: '**it records "who wants full screen"** (**the host does not guess how many rows to fill** — only the renderer knows that)',
    apply: (s) =>
      replace(
        s,
        "    layout: { ...state, promoted: { ...target } },",
        "    layout: { ...state, promoted: null }, // mutation: it does not record who wants the full screen",
      ),
  },
  {
    name: 'M197 the MCP promote: **more than one instance is an error** ✓ (**it does not guess** ✓)',
    file: 'src/main/mcp/promote.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/promote.test.ts'],
    expect: 'invalid_params',
    apply: (s) =>
      replace(
        s,
        "    if (candidates.length > 1) {",
        "    if (candidates.length > 99) {",
      ),
  },
  {
    name: 'M198 the workflow: **only the kernel-module step asks the kernel version of the target machine** ✓ (**asking it is a hard dependency either way** ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/placement-facts.test.ts'],
    expect: 'user-program',
    apply: (s) =>
      replace(
        s,
        "      step.to.placement === 'kernel-module'",
        "      true",
      ),
  },
  {
    name: 'M74 the fake device: a timeout falls only on the fast group (the reading of the slow group must not be carried away)',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'the timeout lands only on the fast group (the readings of the slow group may not be taken away by the timeout of the fast group)',
    apply: (s) =>
      replace(s, '    if (isFast) {', '    if (true) { // mutation: every group counts as a fast group'),
  },

  {
    name: 'M75 the shell: "is in the main area" is decided by the instance key (not by the cardId)',
    file: 'src/renderer/shell/nav.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-nav.test.ts'],
    expect: 'the placed card is marked by state',
    apply: (s) =>
      replace(
        s,
        '    const key = slotKey(card.cardId, card.connectionId);',
        '    const key = card.cardId; // mutation: it is decided by the cardId',
      ),
  },
  {
    name: 'M76 the shell: the session row has to carry a close button (a serial or an SSH connection is exclusive)',
    file: 'src/renderer/shell/nav.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-nav.test.ts'],
    expect: 'the session row has a close button (a serial or SSH connection is exclusive; without a way to close it, it holds the port for good)',
    apply: (s) =>
      replace(
        s,
        '    onClose: () => ctx.onCloseSession(session.sessionId),\n',
        '    // mutation: there is no path to close it\n',
      ),
  },

  // ── The actions and the workflows (ADR-D49) ─────────────────────
  {
    name: 'M230 an action step: **the parameters have to be converted to the type the action declares** (`"1"` → `1` ✓ — without the conversion an action with a type cannot be called ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '**an integer parameter is converted to the type the action declares** ("1" → 1)',
    apply: (s) =>
      replace(
        s,
        '    values[key] = spec === undefined ? value : coerceParam(value, spec.type);',
        '    values[key] = value; // mutation: it is not converted to the declared type',
      ),
  },
  {
    name: 'M231 the adb path: **the `platform-tools_*` with a version has to be found** ✓ (that is where the adb of this machine is ✓)',
    file: 'src/main/util/settings.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/util/settings.test.ts'],
    expect: '`resolveAdbPath` **finds the `platform-tools_*` that carries the version** (the one fixed on 2026-11-16)',
    apply: (s) =>
      replace(
        s,
        `    const candidates = readdirSync(downloads)
      .filter((name) => name.startsWith('platform-tools'))
      .map((name) => join(downloads, name, 'platform-tools', 'adb.exe'));`,
        '    const candidates: string[] = []; // mutation: it does not scan Downloads any more',
      ),
  },
  {
    name: 'M232 building a connection: **the entry point has to resolve the adb path itself** ✓ (the CLI and the application may not each look for their own ✓)',
    file: 'src/main/hal/registry.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/util/settings.test.ts'],
    expect: '`createConnection` **resolves the adb path itself** (the CLI has to get it as well — fixed on 2026-11-16)',
    apply: (s) =>
      replace(
        s,
        '  const adbPath = opts.adbPath ?? resolveAdbPath(loadSettings(settingsPath()));',
        '  const adbPath = opts.adbPath ?? "adb"; // mutation: the entry point does not resolve it any more',
      ),
  },

  // ── The colour discipline (ADR-D41) ───────────────────────────
  {
    name: 'M181 the material layer: **it may not enter a card** (once a card can build a second set of materials the unified skin breaks at once)',
    file: 'src/shared/theme/map.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/visual-material.test.ts'],
    expect: 'the material layer does not reach the cards (a card may only use the contract aliases)',
    apply: (s) =>
      replace(
        s,
        '  if (includeMaterial) Object.assign(vars, materialVars(theme));',
        '  if (includeMaterial || true) Object.assign(vars, materialVars(theme)); // mutation: the card gets the material layer as well',
      ),
  },
  {
    name: 'M182 the colour discipline: **no colour value may be copied into the CSS again** (the breeding ground of a second source of truth)',
    file: 'src/renderer/shell/visual.css',
    check: ['npx', 'vitest', 'run', 'tests/web/visual-material.test.ts'],
    expect: 'no colour literal',
    apply: (s) =>
      replace(
        s,
        '  --ui-highlight: var(--shell-mat-edge-highlight);',
        '  --ui-highlight: rgba(255, 255, 255, 0.06); // mutation: it copied a second one',
      ),
  },
  {
    name: 'M183 the terminal: **the fallback colour has to equal the seed truth** (it may not copy a second fallback colour)',
    file: 'src/renderer/shell/theme.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/visual-material.test.ts'],
    expect: 'the fallback colours of the terminal are the values of the seed (not a second copy)',
    apply: (s) =>
      replace(
        s,
        "    background: v('--cockpit-bg', FALLBACK['bg-0']),",
        "    background: v('--cockpit-bg', '#14171c'), // mutation: the old fallback colour of the plan 1 era",
      ),
  },
  {
    name: 'M184 the material layer: **no shadow variable is allowed** (defining it again in the CSS = a second source of truth)',
    file: 'src/renderer/shell/visual.css',
    check: ['npx', 'vitest', 'run', 'tests/web/visual-material.test.ts'],
    expect: 'defines the material variables a second time',
    apply: (s) =>
      replace(
        s,
        '  --ui-highlight: var(--shell-mat-edge-highlight);',
        '  --shell-mat-edge-highlight: rgba(255, 255, 255, 0.06);\n  --ui-highlight: var(--shell-mat-edge-highlight);',
      ),
  },

  // ── The devices and the connections (ADR-D43) ───────────────────
  {
    name: 'M199 the connection profile: **the `device_key` defaults to the profile id** ✓ (**one board, one connection** ✓ is handled that way ✓)',
    file: 'src/main/profiles/schema.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/device-key.test.ts'],
    expect: '**no `device_key` written → the default is the profile id**',
    apply: (s) =>
      replace(
        s,
        "    : profile.id;",
        "    : ''; // mutation: the default does not fall back to the profile id",
      ),
  },
  {
    name: 'M200 the MCP execute_action: **another device is given → `not_found`** ✓ (**it never silently hits the current board** ✓)',
    file: 'src/main/mcp/action-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/device-key.test.ts'],
    expect: 'another device is given',
    apply: (s) =>
      replace(
        s,
        '  if (deviceKey === current) return undefined;',
        '  if (true) return undefined; // mutation: it lets a mismatched device pass',
      ),
  },
  {
    name: 'M202 the workflow: **a role fact comes from `options.ssh`** ✓ (**that scp has to use the address of the board** ✓)',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/role-facts.test.ts'],
    expect: 'options.ssh',
    apply: (s) =>
      replace(
        s,
        "      host: str(sshFact['host']) ?? str(options['host']) ?? '',",
        "      host: str(options['host']) ?? '', // mutation: it does not read options.ssh",
      ),
  },
  {
    name: 'M203 the interface: **it is grouped by board** ✓ (**the several connections of one board become one board** ✓ — the board itself and the connection are two layers ✓)',
    file: 'src/renderer/shell/devices.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/device-picker.test.ts'],
    expect: 'the several connections of one board collapse into one board',
    apply: (s) =>
      replace(
        s,
        '      byKey.set(connection.deviceKey, {',
        '      byKey.set(connection.id, { // mutation: it is grouped by connection, not by board',
      ),
  },
  {
    name: 'M204 the interface: **a connection without a board pack is not a board** ✓ (**the host or the guest is not a board** ✓)',
    file: 'src/renderer/shell/devices.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/device-picker.test.ts'],
    expect: 'a connection without a board pack is not a board (the local machine and the guest are not boards)',
    apply: (s) =>
      replace(
        s,
        '    if (connection.boardPack === null) continue;',
        '    if (connection.boardPack === undefined) continue; // mutation: it does not filter by the board pack',
      ),
  },
  {
    name: 'M205 the host: **the connection is picked per board** ✓ (**what the user clicks is a board** ✓ — **not a connection** ✓)',
    file: 'src/main/profiles/device-select.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/profiles/device-select.test.ts'],
    expect: '**a board → the host picks its first connection** (**the operator clicks a board, not a channel**)',
    apply: (s) =>
      replace(
        s,
        '  const candidates = profiles.filter((profile) => deviceKeyOf(profile) === deviceKey);',
        '  const candidates = profiles.filter((profile) => profile.id === deviceKey); // mutation: it is picked by connection, not by board',
      ),
  },
  {
    name: 'M206 the host: **it does not reconnect when it is already on that board** ✓ (a needless connection costs the readings ✗)',
    file: 'src/main/profiles/device-select.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/profiles/device-select.test.ts'],
    expect: '**already on that board → it does not connect again** (a pointless connection loses the readings)',
    apply: (s) =>
      replace(
        s,
        '    if (already !== undefined) return { ok: true, profileId: already.id, reused: true };',
        '    // mutation: it no longer checks "already on this board", it reconnects every time',
      ),
  },
  {
    name: 'M208 the card: **the declared workflows are exactly those three** ✓ (**no more, no fewer** ✓ — the authorisation surface may not grow ✗)',
    file: 'cards/build-deploy/manifest.json',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/build-deploy-card.test.ts'],
    expect: '**the workflows it declares are exactly the three compile / upload / run workflows** (**no more and no less**)',
    apply: (s) =>
      replace(
        s,
        '    "workflows": [\n      "hello-kernel.compile",\n      "hello-kernel.upload",\n      "hello-kernel.load"\n    ]',
        '    "workflows": [\n      "hello-kernel.compile",\n      "hello-kernel.upload",\n      "hello-kernel.load",\n      "prepare-credentials.authorize-key"\n    ]',
      ),
  },
  {
    name: 'M210 the card: **"it ran" and "it succeeded" are told apart** ✓ (**`verified: false` is not a success** ✓)',
    file: 'cards/build-deploy/card.js',
    check: ['npx', 'vitest', 'run', 'tests/web/build-deploy-card.test.tsx'],
    expect: 'every stage distinguishes "it ran" from "it succeeded" (verified: false is not a success)',
    apply: (s) =>
      replace(
        s,
        "    li.className = `bd__run-item ${stage.ok ? (stage.verified ? 'is-ok' : 'is-warn') : 'is-bad'}`;",
        "    li.className = `bd__run-item ${stage.ok ? 'is-ok' : 'is-bad'}`; // mutation: something that was not verified counts as succeeded",
        "    if (!ok) li.classList.add('is-bad');\n    else li.classList.add('is-ok'); // mutation: something that was not verified counts as succeeded",
      ),
  },
  {
    name: 'M212 the card: **the key facts of the manual may not be wrong** ✓ (**a wrong fact is a lie** ✗)',
    file: 'cards/board-hardware/card.js',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/board-hardware-card.test.ts'],
    expect: '**the key facts of the manual are all there** (**a wrong one would be lying to the user**)',
    apply: (s) => replace(s, 'GPIO1_A3', 'GPIO1_A4'), // mutation: the pin is wrong
  },
  {
    name: 'M213 the card: **it recognises first whether it is the board of the manual** ✓ (**it may not pretend to apply** ✗)',
    file: 'cards/board-hardware/card.js',
    check: ['npx', 'vitest', 'run', 'tests/web/board-hardware-card.test.tsx'],
    expect: 'another board is not the board of the manual, so it says the list may not apply',
    apply: (s) =>
      replace(
        s,
        '  if (model.includes(BOARD_KEY)) {',
        '  if (true) { // mutation: it says it applies to every board',
      ),
  },
  {
    name: 'M215 the validator: **the command of a reader passes the danger floor** ✓ (**rule 28** ✓ — a board pack takes effect directly ✓)',
    file: 'src/main/tags/validator.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: 'rule 28 · the command a reader uses to collect data may not hit the danger floor',
    apply: (s) =>
      replace(
        s,
        '    if (floor.matched) {',
        '    if (false) { // mutation: the command of the reader does not pass the floor',
      ),
  },
  {
    name: 'M219 the validator: **the parameter values of a reader may not contain shell metacharacters** ✓ (**rule 29** ✓)',
    file: 'src/main/tags/validator.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: 'rule 29 · the argument values of a reader may not contain shell metacharacters',
    apply: (s) =>
      replace(
        s,
        '      if (hit !== undefined) {',
        '      if (false) { // mutation: the metacharacters in a parameter value are let through',
      ),
  },
  {
    name: 'M220 the validator: **the command of an exec_regex may not be an interpreter wrapper** ✓ (**rule 30** ✓)',
    file: 'src/main/tags/validator.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: 'rule 30 · the command of exec_regex may not be an interpreter wrapper',
    apply: (s) =>
      replace(
        s,
        '      if (!SHELL_WRAPPERS.has(base)) continue;',
        '      if (true) continue; // mutation: the interpreter wrapper is let through',
      ),
  },
  {
    name: 'M221 the validator: **the script kind may not be used in a board pack** ✓ (**rule 31** ✓)',
    file: 'src/main/tags/validator.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: 'rule 31 · the script kind may not be used in a board pack',
    apply: (s) =>
      replace(
        s,
        "    if (reader.kind !== 'script') continue;",
        "    if (true) continue; // mutation: script is let through",
      ),
  },
  {
    name: 'M223 the permission area: **a card writing to the board is forbidden by default** ✓ (**the answer of C2** ✓ — ADR-D47 ✓)',
    file: 'src/main/permissions/policy.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/permissions/policy.test.ts'],
    expect: '**a card writing to the board: forbidden by default** (C2 is blocked here)',
    apply: (s) =>
      replace(
        s,
        '  if (op.startsWith(KIND_PREFIX.action)) return false;',
        '  if (false) return false; // mutation: a card writing to the board is allowed as well',
      ),
  },
  {
    name: 'M224 the settings page: **the switch is handed over** ✓ (**who + which action + on or off** ✓)',
    file: 'src/renderer/shell/pages/SettingsPage.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/settings-permissions.test.tsx'],
    expect: 'a switch hands over "who, which operation, on or off"',
    apply: (s) =>
      replace(
        s,
        "onChange={(next) => onPermission('card', row.op, next)}",
        // no inline comment in a mutation — in JSX it would eat the closing bracket (a syntax error does not count as held)
        "onChange={(next) => onPermission('agent', row.op, next)}",
      ),
  },
  {
    name: 'M233 the settings page: **the master switch does not cover the dangerous actions** ✓ (**a reboot may not follow the whole class** ✓)',
    file: 'src/renderer/shell/pages/SettingsPage.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/settings-permissions.test.tsx'],
    expect: 'the master switch only covers the non-destructive actions (a destructive one is enabled one by one)',
    apply: (s) =>
      replace(
        s,
        "  const bulkActions = permissions.filter(\n    (row) => row.kind === 'action' && row.danger !== 'destructive',\n  );",
        "  const bulkActions = permissions.filter((row) => row.kind === 'action'); // mutation: the dangerous actions are in the master switch as well",
      ),
  },
  {
    name: 'M226 the permission area: **a dangerous action is off by default** ✓ (**"turning a permission on means the danger is known"** ✓ — ADR-D48 ✓)',
    file: 'src/main/permissions/policy.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/permissions/policy.test.ts'],
    expect: 'danger',
    apply: (s) =>
      replace(
        s,
        '  if (dangerous) return false;',
        '  if (false) return false; // mutation: the dangerous actions are on by default as well',
      ),
  },
  {
    name: 'M227 the authorisation: **a destructive action no longer asks a person** ✓ (**it runs directly** ✓ — ADR-D48 ✓)',
    file: 'src/main/actions/authorization.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/authorization.test.ts'],
    expect: 'destructive',
    apply: (s) =>
      replace(
        s,
        "  if (!Object.prototype.hasOwnProperty.call(granted.actions, action.id)) {",
        "  if (false && !Object.prototype.hasOwnProperty.call(granted.actions, action.id)) { // mutation: it lets it through even without an authorisation",
      ),
  },
  {
    name: 'M228 the authorisation: **outside the guard range → refused** ✓ (**not "should it ask"** ✓ — ADR-D48 ✓)',
    file: 'src/main/actions/authorization.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/authorization.test.ts'],
    expect: 'guard',
    apply: (s) =>
      replace(
        s,
        "    if (!withinRange(params[name], range)) {",
        "    if (false && !withinRange(params[name], range)) { // mutation: it lets it through even outside the range",
      ),
  },
  {
    name: 'M229 the workflow: **its existence is the explanation** ✓ (**the approval ledger is gone** ✓ — ADR-D48 ✓)',
    file: 'src/main/workflows/registry.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/registry.test.ts'],
    expect: 'require',
    apply: (s) =>
      replace(
        s,
        "  require(id: string): RegisteredWorkflow {",
        "  requireApproved(id: string): RegisteredWorkflow { // mutation: it asks for an approval again",
      ),
  },
  {
    name: 'M225 the permission area: **a card triggering a workflow is allowed by default** ✓ (**"he clicked it, so it ran"** ✓ — ADR-D47 ✓)',
    file: 'src/main/permissions/policy.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/permissions/policy.test.ts'],
    expect: '**a card triggering a workflow: allowed by default** (the gate is this switch)',
    apply: (s) =>
      replace(
        s,
        "  if (actor === 'agent') return true;",
        "  if (actor === 'agent' && op.startsWith(KIND_PREFIX.workflow)) return false; // mutation: the card may not trigger a workflow",
      ),
  },
  {
    name: 'M218 installing a card: **if the board pack does not have the action it is not installed** ✓ (**the board pack decides** ✓ — ADR-D46 ✓)',
    file: 'src/main/mcp/card-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/card-tools.test.ts'],
    expect: '**the board pack does not offer the action to be written → it is not installed** (**the board pack decides**)',
    apply: (s) =>
      replace(
        s,
        '  if (missing.length > 0 && !offline) {',
        '  if (false) { // mutation: it installs an action that the board pack does not have',
      ),
  },
  {
    name: 'M214 the card: **"it cannot be read" is not 0** ✓ (**a missing number and a zero are two things** ✓)',
    file: 'cards/board-hardware/card.js',
    check: ['npx', 'vitest', 'run', 'tests/web/board-hardware-card.test.tsx'],
    expect: 'when it cannot be read it says so (not 0 — "no value" and "zero" are two different things)',
    apply: (s) =>
      replace(
        s,
        "  if (status === 'unavailable') return ",
        "  if (status === 'unavailable') return '0'; // mutation: it says 0 when it cannot be read\n  if (false) return ",
      ),
  },
  {
    name: 'M211 the card: **the inputs are carried along when it runs** ✓ (**no empty parameters** ✓)',
    file: 'cards/build-deploy/card.js',
    check: ['npx', 'vitest', 'run', 'tests/web/build-deploy-card.test.tsx'],
    expect: 'clicking compile calls the compile workflow, with the directory and the project',
    apply: (s) =>
      replace(
        s,
        'if (editable.build_dir) inputs.build_dir = editable.build_dir;',
        "if (editable.build_dir) inputs.build_dir = ''; // mutation: the inputs are not carried along",
      ),
  },
  {
    name: 'M207 the interface: **the menu lists the boards** ✓ (**not the connections** ✓ — the user stated it explicitly on 2026-11-16 ✓)',
    file: 'src/renderer/shell/DevicePicker.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/device-picker-view.test.tsx'],
    expect: 'the menu lists boards (two of them: the real board and the fake one)',
    apply: (s) =>
      replace(
        s,
        '            {boards.map((board, index) => (',
        '            {connections.filter((c) => c.boardPack !== null).map((board, index) => ( // mutation: it lists the connections, not the boards',
      ),
  },
  // ── The findings of 2026-11-21 ✓ ──
  {
    name: 'M234 the id of a card is **a name** ✓ (**it may not climb out of the card root** ✓)',
    file: 'src/main/cards/manifest.ts',
    // → **The parser is the authority** ✓ (one implementation ✓) → its own
    //   test says that an id of ".." does not parse ✓ → and the installation
    //   never sees such an id ✓.
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/manifest.test.ts'],
    expect: 'an id that is not a name',
    apply: (s) =>
      replace(
        s,
        '  if (!isSafeCardId(id)) {',
        '  if (false && !isSafeCardId(id)) { // mutation: every id is allowed',
      ),
  },
  {
    name: 'M236 the runtime **claims a board only after the connection is up**',
    file: 'src/main/tags/runtime.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-runtime.test.ts'],
    expect: 'a failed start leaves no board behind',
    // → **The old code wrote the identity before the connection ✓ and never
    //   cleared it again ✓** → the mutation has to do both ✓ (otherwise the
    //   catch clears it again ✓ and nothing is left to see ✓).
    apply: (s) =>
      replace(
        replace(
          s,
          '    this.stop();\n    this.detailCode = undefined;',
          '    this.stop();\n    this.detailCode = undefined;\n    // mutation: it claims the board before it is connected\n    this.profileId = profile.id;\n    this.deviceKey = deviceKeyOf(profile);',
        ),
        '      this.profileId = undefined;\n      this.deviceKey = undefined;',
        '      // mutation: the identity of a board that was not reached stays',
      ),
  },
  {
    name: 'M237 the readings of the old board **do not survive the switch** ✓',
    file: 'src/main/tags/store.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-runtime.test.ts'],
    expect: 'the readings of the old board do not survive the switch',
    apply: (s) =>
      replace(
        s,
        "      status: 'unavailable' as const,",
        "      status: 'ok' as const, // mutation: the readings of the old board stay",
      ),
  },
  {
    name: 'M240 the cells of the work area **follow the board** ✓ (**otherwise the cards disappear** ✓)',
    file: 'src/main/cards/layout.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/layout.test.ts'],
    expect: 'the cells are re-bound to the new connection',
    apply: (s) =>
      replace(
        s,
        '    if (!changed) return;',
        '    if (true) return; // mutation: the cells do not follow the board',
      ),
  },
  {
    name: 'M239 installing a card while the board is not there: **the check of the actions is skipped** ✓ (**the card is degraded** ✓ — contract §9 rule 5 ✓)',
    file: 'src/main/mcp/card-tools.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/mcp/card-tools.test.ts'],
    expect: 'the card is degraded',
    apply: (s) =>
      replace(
        s,
        '  if (missing.length > 0 && !offline) {',
        '  if (missing.length > 0) { // mutation: offline does not skip the check',
      ),
  },
  {
    name: 'M238 a run of a workflow **gives its targets back** ✓ (the connection is closed then ✓)',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: 'gives them back',
    apply: (s) =>
      replace(
        s,
        '      await this.opts.runDeps.targets.release?.(targets).catch(() => undefined);',
        '      // mutation: the targets are never given back',
      ),
  },
  {
    name: 'M241 the cells of the work area **follow the connection on every path** (✓ **the board that connects on its own counts** ✓)',
    file: 'src/main/cards/wiring.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/wiring.test.ts'],
    expect: 'the cell has to follow the connection',
    apply: (s) =>
      replace(
        s,
        '      if (connectionId !== lastConnectionId) {',
        '      if (false) { // mutation: the cells do not follow the connection',
      ),
  },
  {
    name: 'M242 the failure of the wizard **names the transport it used** (✓ **the ADB line has no serial port** ✓)',
    file: 'src/main/wizard/run.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/wizard-run.test.ts'],
    expect: 'the ADB failure may not talk about a serial port',
    apply: (s) =>
      replace(
        s,
        "    transport === 'adb'\n      ? `**the ADB connection failed**",
        "    transport === 'adb' && false\n      ? `**the ADB connection failed**",
      ),
  },
];

/** One replacement. It throws when the original text is not there — a mutation that does not apply is itself a failed guard */
function replace(src, oldText, newText) {
  if (!src.includes(oldText)) {
    throw new Error(`the original text is not there, the mutation did not apply:\n${oldText.slice(0, 120)}`);
  }
  return src.replace(oldText, newText);
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    rc: res.status ?? 1,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

let pass = 0;
let fail = 0;
let envProblems = 0;

/**
 * The criterion for "the suite did not run".
 *
 * **Why the two have to be told apart**: after a mutation the test suite can
 * also **fail to load** (for example when the architecture of a native module
 * does not match), and that also makes vitest exit non-zero — but that **is
 * not a failed guard**, it is an environment problem.
 * Reporting the two together as "a sham" leads the developer to the
 * **exactly opposite** conclusion: "these regression tests are props". And if
 * a guard really has failed, it can be read as an environment problem just as
 * easily. **Both directions deceive.**
 */
const ENV_PROBLEM = [
  /Tests\s+no tests/i,
  /No test files found/i,
  /Failed to load/i,
  /is not a valid Win32 application/i,
  /Cannot find (module|package)/i,
  /Failed to resolve import/i,
];

function isEnvProblem(out) {
  return ENV_PROBLEM.some((re) => re.test(out));
}

/**
 * **The file that still has to be restored**.
 *
 * Why it is needed: while a mutation runs the source file is "broken". If the
 * process is killed while the checks run (Ctrl+C, a timeout, a closed
 * window), the restore in the `finally` **does not happen** — and the source
 * file stays in the repository with the mutation in it.
 *
 * That is not a hypothesis: once a run was killed on a timeout, the error
 * presentation of App.tsx stayed in the broken state, every test after it was
 * red, and the cause was dozens of lines away.
 *
 * So: **both the exit signals and the normal exit restore**.
 */
let pendingRestore = null;

/**
 * The restore journal.
 *
 * ── Why the signal hooks are not enough ──
 *
 * `SIGKILL` (the OOM killer, a killed container, a task cut off on a timeout)
 * **cannot be caught** — the `finally`, the `exit` hook and the signal
 * handlers all do not run.
 *
 * That is not a hypothesis: on 2026-11-14 a mutation run was SIGKILLed and
 * **three mutants stayed in the working tree**, two of them Criticals that the
 * previous round of review had fixed (the serial port does not open, the
 * danger floor does not hit); they were then committed together by
 * `git add -A` — and the unit suite was **red** at HEAD.
 *
 * → So the original text is written into the journal **before** a file is
 * broken; the next run looks at it first: it is there → the last run was cut
 * off → **restore first, then run**.
 */
const JOURNAL = join(ROOT, '.mutation-restore.json');

function writeJournal(path, original) {
  try {
    writeFileSync(JOURNAL, JSON.stringify({ path, original }));
  } catch {
    // if it cannot be written down, only the exit signal path is left
  }
}

function clearJournal() {
  try {
    rmSync(JOURNAL, { force: true });
  } catch {
    /* ignored */
  }
}

/** Was the last run cut off? Restore the file first. @returns whether something was restored */
function restoreFromJournal() {
  if (!existsSync(JOURNAL)) return false;
  let entry = null;
  try {
    entry = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  } catch {
    clearJournal();
    return false;
  }
  try {
    if (entry && typeof entry.path === 'string' && typeof entry.original === 'string') {
      writeFileSync(entry.path, entry.original, 'utf8');
      console.log(`(the mutation that was interrupted last time has been restored: ${entry.path})`);
    }
  } catch {
    console.error(`✗ the restore failed: ${entry?.path} — restore it by hand with git checkout`);
  }
  clearJournal();
  return true;
}

function restorePending() {
  if (!pendingRestore) return;
  try {
    writeFileSync(pendingRestore.path, pendingRestore.original, 'utf8');
    console.log('\n(the interrupted mutation has been restored)');
  } catch {
    // it has to be said even when it cannot be restored
    console.error(`\n✗ the restore failed: ${pendingRestore.path} — restore it by hand with git checkout`);
  }
  pendingRestore = null;
  clearJournal();
}

/** The state of the working tree (`git status --porcelain`) */
function gitStatusPorcelain() {
  const r = spawnSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

process.on('SIGINT', () => {
  restorePending();
  process.exit(130);
});
process.on('SIGTERM', () => {
  restorePending();
  process.exit(143);
});
process.on('exit', restorePending);

console.log('=== mutation testing: it checks that the regression tests really guard ===');
console.log();

/**
 * A subset of them can be run on their own: `node scripts/mutation-check.mjs M10 M11`.
 *
 * **Why it is needed**: running all of them at once takes several minutes
 * (the web tests are slow on their own), and a tool call has a limit — a run
 * that does not finish is **killed in the middle of a mutation**, and the
 * source file stays in the repository with the mutation in it.
 */
const FILTERS = process.argv.slice(2);
// → **A guard that only makes sense on one platform** ✓ is skipped on the
//   others ✓ (and it says so ✓ — it is not judged wrongly ✓).
const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const onThisPlatform = (m) => m.only === undefined || m.only === PLATFORM;
const selected = FILTERS.length
  ? MUTATIONS.filter((m) => onThisPlatform(m) && FILTERS.some((f) => m.name.includes(f)))
  : MUTATIONS.filter(onThisPlatform);

// → **A guard that belongs to another platform says so** ✓ (a silent skip
//   would look like a guard that passed ✓).
for (const m of MUTATIONS) {
  if (m.only !== undefined && m.only !== PLATFORM) {
    console.log(`– ${m.name.split(' ')[0]} is not judged here (it belongs to ${m.only} ✓)`);
  }
}

if (selected.length === 0) {
  console.error(`no mutation matches: ${FILTERS.join(', ')}`);
  console.error('the id of a mutation is the token in front of its name (C1, M7, M40b, …)');
  process.exit(1);
}

// Was the last run cut off? Restore first (the journal still holds the original)
restoreFromJournal();

/**
 * The working tree **has to be clean** before a mutation runs.
 *
 * On a dirty repository the "changes that were there anyway" and "the changes
 * the mutation caused" are mixed together — a wrong restore cannot be told
 * apart, and when something goes off nobody knows which is which.
 * The last incident happened exactly this way: a dirty working tree was
 * committed together by `git add -A`.
 */
const dirtyBefore = gitStatusPorcelain();
if (dirtyBefore !== '') {
  console.error('✗ the working tree is not clean — the mutation refuses to run on a dirty repository');
  console.error(dirtyBefore);
  console.error('   commit or stash it clean first, then run again.');
  process.exit(1);
}

for (const m of selected) {
  const path = join(ROOT, m.file);
  // → **The line endings are normalized** ✓ — a file that has CRLF on this
  //   machine ✓ and LF in the repository ✓ would make **every** mutation of
  //   it fail to apply ✓ (the text it searches for is not there ✓) → the
  //   guard would prove nothing ✓ (found on 2026-11-21 ✓: four guards had
  //   rotted that way ✓).
  // → **The bytes are kept aside** ✓ — the file has to end up **exactly**
  //   as it was ✓ (a file with CRLF ✓ that is written back with LF ✓ would
  //   look changed ✓ → the run would report a dirty tree ✓ — found on
  //   2026-11-21 ✓).
  const bytes = readFileSync(path);
  const original = bytes.toString('utf8').replace(/\r\n/g, '\n');

  let mutated;
  try {
    mutated = m.apply(original);
  } catch (err) {
    console.log(`✗ ${m.name}: ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
    continue;
  }

  writeFileSync(path, mutated, 'utf8');
  pendingRestore = { path, original };
  // **the bookkeeping comes before the break** — a SIGKILL still leaves a trace
  writeJournal(path, original);

  let result;
  try {
    result = run(m.check[0], m.check.slice(1));
  } finally {
    // restore — whatever the verdict was, the file has to end up as it was
    // → **The bytes go back** ✓ (byte for byte ✓)
    writeFileSync(path, bytes);
    pendingRestore = null;
    clearJournal();
  }

  if (result.rc === 0) {
    console.log(`✗ ${m.name}: the tests are **still all green** after the break — this test is a sham`);
    fail += 1;
  } else if (isEnvProblem(result.out)) {
    console.log(`⚠ ${m.name}: **the suite did not run** (an environment problem, not a failed guard)`);
    console.log('    A common cause: the architecture of a native module does not match the current platform (node_modules was carried over from another system).');
    console.log('    This one **cannot be judged** — fix the environment and run it again.');
    envProblems += 1;
  } else if (!result.out.includes(m.expect)) {
    console.log(
      `✗ ${m.name}: it turned red, but **for the wrong reason** (the output does not contain "${m.expect}") — ` +
        'it may be a compile failure, which does not count as held',
    );
    fail += 1;
  } else {
    console.log(`✓ ${m.name}: the tests turned red after the break (held)`);
    pass += 1;
  }
}

/**
 * After the run the working tree **still has to be clean**.
 *
 * It changed = a file was not restored → it is a failure (better to be noisy
 * than to leave a mine behind).
 */
const leftover = gitStatusPorcelain();
if (leftover !== '') {
  console.error('✗ the working tree is not clean after the run — a file was not restored:');
  console.error(leftover);
  fail += 1;
}

console.log();
console.log(
  `=== the result: ${pass} held, ${fail} failed guards` +
    (envProblems > 0 ? `, ${envProblems} environment problems (they cannot be judged, they are not failed guards)` : '') +
    ' ===',
);
if (envProblems > 0) {
  console.log('    The "environment problems" **have not been judged** — fix the environment (the native modules have to match the platform) and run it again.');
}
process.exit(fail > 0 || envProblems > 0 ? 1 : 0);
