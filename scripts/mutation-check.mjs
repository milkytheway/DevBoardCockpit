#!/usr/bin/env node
/**
 * 变异测试：证明这些回归测试**真的在守**着修好的东西。
 *
 * 为什么需要它：整支评审修完 6 条 Critical 后，其中 3 条（C1 串口端口不开、
 * C4 终端输出重复渲染、C6 renderer 不呈现错误）**没有任何测试守着**——
 * 把修复改回去，整个套件仍然全绿。
 * 「测试通过」和「测试能抓住这个 bug」是两件事，只有变异能区分。
 *
 * 做法：把修复改回坏的样子 → 跑对应的测试 → **必须变红** → 还原 → 必须变绿。
 *
 * **用 Node 写而不是 shell**：这个工程的目标平台是 Windows，
 * 而 `npm.ps1` 在 PowerShell 下会把 `--` 之后的内容吃掉——
 * 也就是说，**在目标平台上，这个「验证器」自己跑不起来**。
 * 「验证器跑不起来」等于「没有验证器」。
 * （`docs/11-计划1评审报告.md` R-57）
 *
 * 用法（在仓库根目录）：
 *   npm run mutation:check
 *
 * 退出码 0 = 全部守住；非 0 = 有测试形同虚设。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 每个变异：
 * - `file`   要改坏的文件
 * - `apply`  怎么改坏（返回新内容）
 * - `check`  跑什么来验它变红了
 * - `expect` 输出里必须出现的字样。
 *   **这一条是关键**：只判「退出码非 0」会把「编译失败」误判成「测试守住了」。
 */
const MUTATIONS = [
  {
    name: 'C1 串口端口真的打开',
    file: 'src/main/hal/serial.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/serial-real-factory.test.ts'],
    expect: '打开端口',
    apply: (s) => replace(s, '  await port.open();', '  // await port.open();  // 变异'),
  },
  {
    name: 'C2 marker 单行协议',
    file: 'src/main/hal/serial.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/serial.test.ts'],
    expect: 'marker 在同一行',
    apply: (s) =>
      replace(
        s,
        '    this.port?.write(`${command}; echo ${marker}\\r\\n`);',
        '    this.port?.write(`${marker}\\r\\n${command}\\r\\n${marker}\\r\\n`);',
      ),
  },
  {
    name: 'C3 SSH shell 异步',
    file: 'src/main/hal/ssh.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/ssh.test.ts'],
    expect: 'shell 通道',
    apply: (s) =>
      replace(
        s,
        `  private openShell(cols: number, rows: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client!.shell({ term: 'xterm-256color', cols, rows }, (err, ch) => {
        if (err) {
          reject(makeError('CONN_OPEN_FAILED', \`SSH 开 shell 失败：\${err.message}\`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        resolve(ch);
      });
    });
  }`,
        `  private openShell(cols: number, rows: number): Promise<ClientChannel> {
    let channel: ClientChannel | undefined;
    this.client!.shell({ term: 'xterm-256color', cols, rows }, (err, ch) => {
      if (err) throw makeError('CONN_OPEN_FAILED', \`SSH 开 shell 失败：\${err.message}\`);
      channel = ch;
    });
    if (!channel) throw makeError('CONN_OPEN_FAILED', 'SSH 开 shell 失败：没有拿到通道');
    return Promise.resolve(channel);
  }`,
      ),
  },
  {
    name: 'C4 终端输出不重放历史',
    file: 'src/renderer/terminal/TerminalView.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/terminal-view.test.tsx'],
    expect: '不重放历史',
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
    name: 'C5 文件互传按传输分派',
    file: 'src/main/files/transfer.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/file-transfer.test.ts'],
    expect: 'pull 走连接自己的 pull',
    apply: (s) =>
      replace(
        s,
        '    await conn.pull(remotePath, localPath);',
        '    await conn.exec(`pull ${remotePath} ${localPath}`);',
      ),
  },
  {
    name: 'C6 renderer 呈现错误',
    file: 'src/renderer/shell/ErrorBar.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-error.test.tsx'],
    expect: '把失败的原因显示出来',
    apply: (s) =>
      replace(
        s,
        `    <div className="shell-error" role="alert">
      <span>{message}</span>`,
        `    <div className="shell-error" role="alert">
      <span>{'坏了'}</span>`,
      ),
  },
  {
    name: 'M7 preload 必须是 CommonJS',
    file: 'electron.vite.config.ts',
    check: ['npm', 'run', 'build'],
    expect: '构建产物自检不过',
    apply: (s) => replace(s, 'format: PRELOAD_FORMAT,', "format: 'es',"),
  },
  {
    name: 'M8 错误跨 IPC 要拆包',
    file: 'src/preload/index.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/preload.test.ts'],
    expect: '错误码',
    apply: (s) =>
      replace(
        s,
        '  if (!result.ok) throw appErrorToException(result.error);',
        '  // 变异：不拆包，直接把失败当成成功',
      ),
  },
  {
    name: 'M9 pipe 模式回车要发 LF',
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
    name: 'M10 上传要传绝对路径',
    file: 'src/renderer/shell/Shell.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-error.test.tsx'],
    expect: '绝对路径',
    apply: (s) =>
      replace(
        s,
        'const localPath = window.cockpit.getPathForFile(file);',
        'const localPath = file.name;',
      ),
  },
  {
    name: 'M11 串口的回包缓冲不许被裁剪',
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
    name: 'M13 日志逐行加时间戳',
    file: 'src/main/logging/session-log.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/session-log-format.test.ts'],
    expect: '实现能把样本喂进去',
    apply: (s) =>
      replace(
        s,
        "    for (const raw of text.replace(/\\n+$/, '').split('\\n')) {",
        "    for (const raw of [text]) {",
      ),
  },
  {
    name: 'M14 ANSI 要剥干净（含隐藏光标与 OSC）',
    file: 'src/main/logging/session-log.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/session-log-format.test.ts'],
    expect: '剥掉 ESC[?25l',
    apply: (s) =>
      replace(
        s,
        '  const CSI = /\\x1b\\[[0-9;?]*[ -/]*[@-~]/g;',
        '  const CSI = /\\x1b\\[[0-9;]*[A-Za-z]/g;',
      ),
  },
  {
    name: 'M15 pipe 模式的历史要能回来',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: '历史能回来',
    apply: (s) =>
      replace(
        s,
        '  historyPrev(): void {\n    if (this.history.length === 0) return;',
        '  historyPrev(): void {\n    if (true) return;\n    if (this.history.length === 0) return;',
      ),
  },
  {
    name: 'M16 pipe 模式的 kill ring 要能贴回来',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: 'kill ring 能贴回来',
    apply: (s) =>
      replace(s, '    if (this.killed) this.insert(this.killed);', '    // 变异：不贴回来'),
  },
  {
    name: 'M17 重画不得越过提示符',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: '重画不得越过提示符',
    apply: (s) =>
      replace(
        s,
        '    const back = displayWidth(before.text.slice(0, before.cursor));',
        '    const back = visibleLength(this.prompt) + displayWidth(before.text.slice(0, before.cursor));',
      ),
  },
  {
    name: 'M18 Ctrl+C 要清行',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: 'Ctrl+C 要清掉这一行',
    apply: (s) =>
      replace(
        s,
        "          this.editor.clear();\n          echo += '^C\\r\\n';",
        "          echo += '^C\\r\\n';",
      ),
  },
  {
    name: 'M19 日志文件名要带全 HHMMSS',
    file: 'src/main/logging/session-log.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/session-log.test.ts'],
    expect: '文件名是',
    apply: (s) =>
      replace(
        s,
        "    const stem = logFileName(safeName(opts.label), at).replace(/\\.log$/, '');",
        "    const stem = logFileName('', at).slice(0, 6);",
      ),
  },
  {
    name: 'M20 ADB 的 stdin 必须接 error',
    file: 'src/main/hal/adb.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/adb.test.ts'],
    expect: 'stdin 的 error 必须有人接',
    apply: (s) =>
      replace(
        s,
        "    child.stdin.on('error', (err: Error) => {",
        "    // 变异：stdin 的 error 没人接\n    child.stdin.on('nothing', (err: Error) => {",
      ),
  },
  {
    name: 'M21 运行时的终端模式由 profile 决定',
    file: 'src/main/terminal/manager.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/terminal-manager.test.ts'],
    expect: '终端模式由 profile 的 pty 决定',
    apply: (s) =>
      replace(
        s,
        '    const pty = capabilitiesFor(profile).pty;',
        '    const pty = connection.capabilities().pty;',
      ),
  },
  {
    name: 'M22 上传的远端目标要补 basename',
    file: 'src/main/hal/local.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/local.test.ts'],
    expect: '上传',
    apply: (s) =>
      replace(
        s,
        '    const target = join(remotePath, basename(localPath));',
        '    const target = remotePath;',
      ),
  },
  {
    name: 'M23 提交时不要画下一个提示符',
    file: 'src/main/terminal/line-editor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/line-editor.test.ts'],
    expect: '提示符在下一条命令开始时才画',
    apply: (s) =>
      replace(
        s,
        "          echo += '\\r\\n';\n          this.promptPending = true;",
        "          echo += `\\r\\n${this.prompt}`;\n          this.promptPending = false;",
      ),
  },
  {
    name: 'M24 ADB 的环境脚本不许带 CR',
    file: 'src/main/hal/adb.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/adb.test.ts'],
    expect: '脚本里不能有 CR',
    apply: (s) =>
      replace(
        s,
        '    this.child.stdin.write(terminalEnvScript());',
        '    this.child.stdin.write(`${terminalEnvScript()}\\r\\n`);',
      ),
  },
  {
    name: 'M25 进目录要重新列',
    file: 'src/renderer/files/FileBrowser.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/file-browser.test.tsx'],
    expect: '进目录要**重新列那个目录**',
    apply: (s) =>
      replace(
        s,
        '      void load(entry.path);',
        '      // 变异：不重新列',
      ),
  },
  {
    name: 'M26 「↑ 上级」要用 parentPath',
    file: 'src/renderer/files/FileBrowser.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/file-browser.test.tsx'],
    expect: '组件级：进 /.cache 再点「↑ 上级」回到根',
    apply: (s) =>
      replace(
        s,
        '    const parent = parentPath(currentPath);',
        "    const parent = currentPath.replace(/\\/[^/]*$/, '');",
      ),
  },
  {
    name: 'M12 能力位由 profile 决定',
    file: 'src/main/hal/capabilities.ts',
    check: ['npx', 'vitest', 'run', 'tests/integration/registry.test.ts'],
    expect: '覆盖传输默认值',
    apply: (s) =>
      replace(
        s,
        '    pty: typeof explicit === \'boolean\' ? explicit : defaults.pty,',
        '    pty: defaults.pty,',
      ),
  },
  {
    name: 'M27 规则 4：绑 *.usage 必须 measure **等于** utilization',
    file: 'src/main/tags/validator.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: '规则 4',
    apply: (s) =>
      replace(
        s,
        "      if (measure !== 'utilization') {",
        "      if (measure === undefined) {  // 变异：只判有没有声明",
      ),
  },
  {
    name: 'M28 规则 26：已实现能力集要真的查',
    file: 'src/main/tags/vocabulary.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: '规则 26',
    apply: (s) =>
      replace(
        s,
        'export function isImplementedCapability(value: string): boolean {\n  return (IMPLEMENTED_CAPABILITIES as readonly string[]).includes(value);\n}',
        'export function isImplementedCapability(value: string): boolean {\n  return true;  // 变异：什么都算已实现\n}',
      ),
  },
  {
    name: 'M29 危险地板：绝对路径也要算（basename 兜底）',
    file: 'src/main/tags/floor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: '规则 16',
    apply: (s) =>
      replace(
        s,
        '  return baseName(token) === pattern;',
        '  return token === pattern;  // 变异：去掉 basename 兜底',
      ),
  },
  {
    name: 'M30 危险地板：rm -rf / 与 rm -rf /* 都要拦',
    file: 'src/main/tags/floor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-validator.test.ts'],
    expect: '规则 16',
    apply: (s) =>
      replace(
        s,
        "    if (p === '/' || p === '/*') {",
        "    if (p === '/root' || p === '/*') {  // 变异：漏掉 /",
      ),
  },
  {
    name: 'M31 TagStore：stale/error 要**保留旧值**',
    file: 'src/main/tags/store.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-store.test.ts'],
    expect: '保留旧值',
    apply: (s) =>
      replace(
        s,
        "    if (input.status === 'stale' || input.status === 'error') {\n      const good = this.lastGood.get(input.tag);\n      value = good === undefined ? null : good;\n    } else if",
        "    if (input.status === 'stale' || input.status === 'error') {\n      value = null;  // 变异：不保留旧值\n    } else if",
      ),
  },
  {
    name: 'M32 采样器：截断的那段**不许照常发布**',
    file: 'src/main/tags/sampler.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-sampler.test.ts'],
    expect: '截断',
    apply: (s) =>
      replace(
        s,
        "          '这一段没收到结束标记——板子只回了一半（不发布半截数据）',\n        );\n        continue;\n      }",
        "          '这一段没收到结束标记——板子只回了一半（不发布半截数据）',\n        );\n        // 变异：照常发布\n      }",
      ),
  },
  {
    name: 'M33 往返队列：同一时刻只有一次往返在飞',
    file: 'src/main/hal/round-trip-queue.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/round-trip-queue.test.ts'],
    expect: '任何时刻只有一次往返在飞',
    apply: (s) =>
      replace(
        s,
        '    if (this.draining) return;',
        '    // 变异：去掉重入保护 → 两条链各自开跑',
      ),
  },
  {
    name: 'M34 调度器：错过的周期要**跳过**，不补发',
    file: 'src/main/tags/scheduler.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-scheduler.test.ts'],
    expect: '跳过',
    apply: (s) =>
      replace(
        s,
        '          if (waited > group.intervalMs + slack) {',
        '          if (false) {  // 变异：永不跳过',
      ),
  },
  {
    name: 'M35 调度器：采样必须**经队列**，不直接碰 exec',
    file: 'src/main/tags/scheduler.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/tags-scheduler.test.ts'],
    expect: '一切经队列',
    apply: (s) =>
      replace(
        s,
        "    void this.queue\n      .run('sample', async () => {",
        '    // 变异：绕开队列，直接采\n    void this.sampler.sampleGroup(group.id);\n    void this.queue\n      .run(\'sample\', async () => {',
      ),
  },
  {
    name: 'M36 读权限：覆盖判定不能恒真（恒真 = 越权读）',
    file: 'src/main/cards/permissions.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/tags-service.test.ts'],
    expect: '没权限的 tag',
    apply: (s) =>
      replace(
        s,
        '  return perms.read.some((pattern) => matchTagPattern(pattern, tag));',
        '  return true;  // 变异：什么都覆盖',
      ),
  },
  {
    name: 'M37 路径穿越：越界必须挡住',
    file: 'src/main/cards/paths.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/paths.test.ts'],
    expect: 'null',
    apply: (s) =>
      replace(
        s,
        "  if (full !== base && !full.startsWith(base + sep)) return null;",
        "  // 变异：不去掉越界检查",
      ),
  },
  {
    name: 'M38 manifest：未知字段必须报错（拼错的字段不能静默忽略）',
    file: 'src/main/cards/manifest.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/manifest.test.ts'],
    expect: 'network',
    apply: (s) =>
      replace(
        s,
        '    if (!allowed.includes(key)) {',
        '    if (false) {  // 变异：未知字段不报错',
      ),
  },
  {
    name: 'M39 规则 5：离线时是「未验证」不是「不合法」',
    file: 'src/main/cards/validate.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/validate.test.ts'],
    expect: '未验证',
    apply: (s) =>
      replace(
        s,
        '    if (ctx.availableActions === null) {',
        '    if (false) {  // 变异：离线分支没了',
      ),
  },
  {
    name: 'M40 bridge：不认识的方法必须回 unknown_method（**顶层那层 Proxy**）',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: '不认识的名字仍然回 unknown_method',
    apply: (s) =>
      replace(
        s,
        "      return () => Promise.resolve({ ok: false, reason: 'unknown_method' });",
        '      return undefined;  // 变异：不认识的方法不回话',
      ),
  },
  {
    name: 'M40b bridge：**命名空间那层**也不认识的方法要回 unknown_method',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: '命名空间里不认识的方法也是 unknown_method',
    apply: (s) =>
      replace(
        s,
        "        return () => Promise.resolve({ ok: false, reason: 'unknown_method' });",
        '        return undefined;  // 变异：不认识的方法不回话',
      ),
  },
  {
    name: 'M41 bridge：握手必须带 instanceId（认人的依据）',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: 'inst-42',
    apply: (s) =>
      replace(
        s,
        '  const INSTANCE_ID = ${JSON.stringify(instanceId)};',
        "  const INSTANCE_ID = '';  // 变异：不带实例 id",
      ),
  },
  {
    name: 'M42 通配订阅：订阅路径的权限过滤不能整体消失',
    file: 'src/main/cards/tags-service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/tags-service.test.ts'],
    expect: '一个都不推',
    apply: (s) =>
      // **两处都要打掉**：权限固定时「订阅时判」与「推送时判」等价，
      // 只打掉一处，另一处还在 → 测试照样绿（这不是测试的问题，是这两处本来就冗余）
      replace(
        replace(
          s,
          `    if (!permissionCovers(this.perms, pattern)) return () => undefined;`,
          `    // 变异：订阅时不再判权限`,
        ),
        `      if (!matchTagPattern(pattern, reading.tag)) return;
      // **再判一次权限**（铁律 2）
      if (!permissionCovers(this.perms, reading.tag)) return;`,
        `      if (!matchTagPattern(pattern, reading.tag)) return;
      // 变异：推送时不再判权限`,
      ),
  },
  {
    name: 'M43 存储：单键配额必须守（否则一张卡能写满磁盘）',
    file: 'src/main/cards/storage.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/storage.test.ts'],
    expect: 'quota_exceeded',
    apply: (s) =>
      replace(
        s,
        "    if (size > KEY_LIMIT_BYTES) return { ok: false, reason: 'quota_exceeded' };",
        '    // 变异：不查单键配额',
      ),
  },
  {
    name: 'M44 CSP 违规：必须归到**对的那张卡**（sourceUrl 里的实例 id）',
    file: 'src/main/cards/runtime-log.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/runtime-log.test.ts'],
    expect: 'CSP 违规归到',
    apply: (s) =>
      replace(
        s,
        "  const match = /^cockpit:\\/\\/card\\/([^/]+)\\//.exec(sourceUrl);",
        "  const match = /^(.*)$/.exec(sourceUrl);  // 变异：不从 sourceUrl 里取实例 id",
      ),
  },
  {
    name: 'M45 运行时候选：board_pack 为 null 的 profile 必须剔掉',
    file: 'src/main/tags/runtime.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/runtime-retry.test.ts'],
    expect: 'null 与缺省都剔掉',
    apply: (s) =>
      replace(
        s,
        '    .filter((p) => p.board_pack != null)',
        '    .filter((p) => p.board_pack !== undefined)  // 变异：null 又被当成候选',
      ),
  },

  {
    name: 'M46 外壳 CSP：frame-src 必须允许 cockpit:（否则一张卡都装不上）',
    file: 'src/main/shell-csp.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/shell-csp.test.ts'],
    expect: 'frame-src 必须允许',
    apply: (s) =>
      replace(
        s,
        '"object-src \'none\'; base-uri \'none\'; frame-src cockpit:";',
        '"object-src \'none\'; base-uri \'none\'; frame-src \'none\';";',
      ),
  },
  {
    name: 'M47 bridge 注入：URL 必须带实例 id（相对根路径会把实例 id 吃掉）',
    file: 'src/main/cards/protocol.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/protocol.test.ts'],
    expect: '注入出来的 URL',
    apply: (s) =>
      replace(
        s,
        'return `<script type="module" src="cockpit://card/${id}/__host/bridge.js"></script>`;',
        'return `<script type="module" src="/__host/bridge.js"></script>`;  // 变异：实例 id 被吃掉',
      ),
  },
  {
    name: 'M48 CSP 违规：进日志的那句话必须说清楚「它想干什么」',
    file: 'src/main/cards/csp-violation.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/csp-violation.test.ts'],
    expect: '想干什么',
    apply: (s) =>
      replace(
        s,
        "  const target = violation.blockedURI === '' ? '（没有地址）' : violation.blockedURI;",
        "  const target = '';  // 变异：不说它想访问什么",
      ),
  },
  {
    name: 'M49 符号链接：软链不能捅穿卡片目录',
    file: 'src/main/cards/paths.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/paths.test.ts'],
    expect: '软链指向卡片目录',
    apply: (s) =>
      replace(
        s,
        '    if (!isInside(realBase, realFull)) return null;',
        '    if (!isInside(realBase, realFull)) { /* 变异：软链不判 */ }',
      ),
  },
  {
    name: 'M50 规则 2：id 名单要排除自己（否则改一次文件就成「重名」）',
    file: 'src/main/cards/wiring.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/wiring.test.ts'],
    expect: '第二次刷新不会把卡片自己判成重名',
    apply: (s) =>
      replace(
        s,
        '      .filter((c) => c.dir !== dir)',
        '      .filter(() => true)  // 变异：把自己也算进去',
      ),
  },
  {
    name: 'M51 会话关闭：退订函数必须真的被调用',
    file: 'src/main/cards/session.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/session.test.ts'],
    expect: '退订函数被调用',
    apply: (s) =>
      replace(
        s,
        '          dispose();',
        '          void 0;  // 变异：不释放订阅',
      ),
  },
  {
    name: 'M52 bridge：必须解包（卡片要拿到值，不是传输信封）',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: '卡片拿到的是「值」',
    apply: (s) =>
      replace(
        s,
        "      resolve(payload.ok ? payload.value : { ok: false, reason: payload.reason || 'failed' });",
        '      resolve(payload);  // 变异：把信封原样交给卡片',
      ),
  },
  {
    name: 'M53 订阅上限：一张卡不能把 main 打满',
    file: 'src/main/cards/session.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/session.test.ts'],
    expect: 'too_many_subscriptions',
    apply: (s) =>
      replace(
        s,
        'export const MAX_SUBSCRIPTIONS_PER_SESSION = 64;',
        'export const MAX_SUBSCRIPTIONS_PER_SESSION = 100000;  // 变异：没有上限',
      ),
  },
  {
    name: 'M54 存储目录：不能落在卡片根目录里（否则写一次存储就是一个回路）',
    file: 'src/main/util/paths.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/card-dirs.test.ts'],
    expect: '存储目录不在卡片根目录里',
    apply: (s) =>
      replace(
        s,
        "  return join(userDataDir(appName), 'card-storage');",
        "  return join(userDataDir(appName), 'cards');  // 变异：落在卡片根目录里",
      ),
  },

  {
    name: 'M55 CSP 监听脚本：必须真的监听 securitypolicyviolation',
    file: 'src/main/cards/csp-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/csp-script.test.ts'],
    expect: '监听 securitypolicyviolation',
    apply: (s) =>
      replace(
        s,
        "addEventListener('securitypolicyviolation'",
        "addEventListener('nothing-here'",
      ),
  },
  {
    name: 'M56 bridge：顶层方法必须自己就是函数（契约的用法）',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: '顶层方法就是函数',
    apply: (s) =>
      replace(
        s,
        '`  Object.assign(cockpit, {',
        '`  Object.assign(cockpit.nested = {}, {',
      ),
  },
  {
    name: 'M57 经纪人：CSP 违规必须转给 main',
    file: 'src/renderer/cards/broker.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/card-broker.test.tsx'],
    expect: 'CSP 违规',
    apply: (s) =>
      replace(
        s,
        "if (data.type === 'cockpit-csp') {",
        "if (false) {",
      ),
  },
  {
    name: 'M58 协议：必须伺服 __host/csp.js',
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
    name: 'M59 协议：CSP 监听脚本必须在 bridge 之前（监听得早）',
    file: 'src/main/cards/protocol.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/protocol.test.ts'],
    expect: 'CSP 监听脚本在 bridge 之前',
    apply: (s) =>
      replace(
        s,
        'return injectAtStart(html, cspScriptTag(instanceId) + bridgeTagFor(instanceId));',
        'return injectAtStart(html, bridgeTagFor(instanceId) + cspScriptTag(instanceId));',
      ),
  },

  {
    name: 'M60 监听：用户根目录不存在时要建出来（否则第一次装卡永远不被发现）',
    file: 'src/main/cards/watcher.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/watcher.test.ts'],
    expect: '用户根目录不存在',
    apply: (s) =>
      replace(
        s,
        '          mkdirSync(root.dir, { recursive: true });',
        '          /* 变异：不建目录 */',
      ),
  },
  {
    name: 'M61 监听：变化后要重新挂（新装的卡，它的目录才有人看着）',
    file: 'src/main/cards/watcher.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/watcher.test.ts'],
    expect: '启动之后才装进来的卡',
    apply: (s) =>
      replace(
        s,
        '      ensureWatching();\n      onChange();',
        '      onChange();  // 变异：不重新挂',
      ),
  },

  {
    name: 'M62 实例键里要有内容指纹（否则改了文件卡片不重载 = 「改文件即热更新」是假的）',
    file: 'src/main/cards/registry.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/registry.test.ts'],
    expect: '改了卡片文件 → 实例 id 变了',
    apply: (s) =>
      replace(
        s,
        'const key = `${cardId} ${connectionId ?? \'\'} ${revision}`;',
        'const key = `${cardId} ${connectionId ?? \'\'}`;  // 变异：指纹不参与',
      ),
  },

  {
    name: 'M63 布局：拖完必须真的落盘（否则位置只在内存里，重启就没）',
    file: 'src/main/cards/layout.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/layout.test.ts'],
    expect: 'set 之后 get 等值',
    apply: (s) =>
      replace(
        s,
        "    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');",
        '    /* 变异：不落盘 */',
      ),
  },

];

/** 替换一次。原文不在就抛错——「变异没打上」本身就是守卫失效 */
function replace(src, oldText, newText) {
  if (!src.includes(oldText)) {
    throw new Error(`原文不在，变异没打上：\n${oldText.slice(0, 120)}`);
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
 * 「套件没跑起来」的判据。
 *
 * **为什么必须区分**：变异之后测试套件**加载失败**（比如原生模块架构不匹配）
 * 也会让 vitest 退出非 0——但那**不是守卫失效**，是环境问题。
 * 两者混在一起报成「形同虚设」，开发者会得出**完全相反**的结论：
 * 「这几个回归测试是摆设」。而如果真的有一个守卫失效，它也可能被读成「环境问题」。
 * **两个方向都会骗人。**
 * （`docs/13-计划1复评报告.md` S-02）
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
 * **待还原的文件**。
 *
 * 为什么需要它：变异期间源文件是「坏」的。如果进程在跑检查的过程中
 * 被杀掉（Ctrl+C、超时、关窗），`finally` 里的还原**不会执行**——
 * 源文件就带着变异留在仓库里了。
 *
 * 那不是假设：有一次跑超时被砍，App.tsx 的错误呈现就留在坏状态，
 * 之后的测试全红，而原因在几十行之外。
 *
 * 所以：**退出信号与正常退出都要还原**。
 */
let pendingRestore = null;

/**
 * 还原日志（journal）。
 *
 * ── 为什么信号钩子不够 ──
 *
 * `SIGKILL`（OOM killer、容器被杀、任务超时被砍）**拦不住**——
 * `finally`、`exit` 钩子、信号处理器统统不执行。
 *
 * 那不是假设：2026-11-14 有一次跑变异被 SIGKILL，
 * **三个「变异体」留在工作树里**，其中两个是上一轮评审修好的 Critical
 * （串口端口不开、危险地板不命中），随后被 `git add -A` 一起提交了——
 * 单元套件在 HEAD 上是**红的**。
 *
 * → 所以在改坏文件**之前**把原文写进 journal；
 * 下次运行时先看它：有就说明上次被砍了 → **先还原，再跑**。
 */
const JOURNAL = join(ROOT, '.mutation-restore.json');

function writeJournal(path, original) {
  try {
    writeFileSync(JOURNAL, JSON.stringify({ path, original }));
  } catch {
    // 记不上就只剩退出信号那条路了
  }
}

function clearJournal() {
  try {
    rmSync(JOURNAL, { force: true });
  } catch {
    /* 忽略 */
  }
}

/** 上次被砍了？先把文件还原回来。@returns 有没有还原过 */
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
      console.log(`（已还原上次被中断的变异：${entry.path}）`);
    }
  } catch {
    console.error(`✗ 还原失败：${entry?.path} —— 请手动 git checkout 它`);
  }
  clearJournal();
  return true;
}

function restorePending() {
  if (!pendingRestore) return;
  try {
    writeFileSync(pendingRestore.path, pendingRestore.original, 'utf8');
    console.log('\n（已还原被中断的变异）');
  } catch {
    // 还原不了也要说出来
    console.error(`\n✗ 还原失败：${pendingRestore.path} —— 请手动 git checkout 它`);
  }
  pendingRestore = null;
  clearJournal();
}

/** 工作树的状态（`git status --porcelain`） */
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

console.log('=== 变异测试：验证回归测试真的在守 ===');
console.log();

/**
 * 可以只跑其中几项：`node scripts/mutation-check.mjs M10 M11`。
 *
 * **为什么需要**：12 项一次跑完要好几分钟（web 测试本身就慢），
 * 而工具调用有上限——一次跑不完就会**在变异中途被杀**，
 * 源文件带着变异留在仓库里。
 */
const FILTERS = process.argv.slice(2);
const selected = FILTERS.length
  ? MUTATIONS.filter((m) => FILTERS.some((f) => m.name.includes(f)))
  : MUTATIONS;

if (selected.length === 0) {
  console.error(`没有匹配的变异：${FILTERS.join(', ')}`);
  console.error(`可用的编号：C1–C6、M7–M12`);
  process.exit(1);
}

// 上次被砍了？先还原（journal 里还留着原文）
restoreFromJournal();

/**
 * **工作树必须干净**才跑变异。
 *
 * 在脏仓库上跑，「本来就有的改动」与「变异造成的改动」混在一起——
 * 还原错了就说不清，出事时分不清谁是谁。
 * 而且上一次事故正是这么发生的：脏工作树被 `git add -A` 一起提交了。
 */
const dirtyBefore = gitStatusPorcelain();
if (dirtyBefore !== '') {
  console.error('✗ 工作树不干净 —— 拒绝在脏仓库上跑变异');
  console.error(dirtyBefore);
  console.error('   先 commit 或 stash 干净了再跑。');
  process.exit(1);
}

for (const m of selected) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');

  let mutated;
  try {
    mutated = m.apply(original);
  } catch (err) {
    console.log(`✗ ${m.name}：${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
    continue;
  }

  writeFileSync(path, mutated, 'utf8');
  pendingRestore = { path, original };
  // **先记账再改坏**——被 SIGKILL 了也有据可查
  writeJournal(path, original);

  let result;
  try {
    result = run(m.check[0], m.check.slice(1));
  } finally {
    // 还原——不管验成什么样，文件必须回到原样
    writeFileSync(path, original, 'utf8');
    pendingRestore = null;
    clearJournal();
  }

  if (result.rc === 0) {
    console.log(`✗ ${m.name}：改坏之后测试**仍然全绿** —— 这个测试形同虚设`);
    fail += 1;
  } else if (isEnvProblem(result.out)) {
    console.log(`⚠ ${m.name}：**套件没跑起来**（环境问题，不是守卫失效）`);
    console.log('    常见原因：原生模块的架构与当前平台对不上（node_modules 是从别的系统搬来的）。');
    console.log('    这一项**判不了**——修好环境再跑一次。');
    envProblems += 1;
  } else if (!result.out.includes(m.expect)) {
    console.log(
      `✗ ${m.name}：红了，但**红的原因不对**（输出里找不到「${m.expect}」）—— ` +
        '可能是编译失败，不算守住',
    );
    fail += 1;
  } else {
    console.log(`✓ ${m.name}：改坏之后测试变红（守住了）`);
    pass += 1;
  }
}

/**
 * 跑完之后**工作树必须还是干净的**。
 *
 * 变了 = 有文件没还原干净 → 判失败（宁可吵，也别留一颗雷）。
 */
const leftover = gitStatusPorcelain();
if (leftover !== '') {
  console.error('✗ 跑完之后工作树不干净 —— 有文件没还原干净：');
  console.error(leftover);
  fail += 1;
}

console.log();
console.log(
  `=== 结果：守住 ${pass} 项，守卫失效 ${fail} 项` +
    (envProblems > 0 ? `，环境问题 ${envProblems} 项（判不了，不是守卫失效）` : '') +
    ' ===',
);
if (envProblems > 0) {
  console.log('    「环境问题」的那些项**没有判定过**——修好环境（原生模块要与平台对得上）再跑一次。');
}
process.exit(fail > 0 || envProblems > 0 ? 1 : 0);
