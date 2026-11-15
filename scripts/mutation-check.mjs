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
    file: 'src/renderer/shell/files.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-error.test.tsx'],
    expect: '绝对路径',
    apply: (s) =>
      replace(
        s,
        'const localPath = host.getPathForFile(file);',
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
        "    void this.queue\n      .run('card-sampling', async () => {",
        '    // 变异：绕开队列，直接采\n    void this.sampler.sampleGroup(group.id);\n    void this.queue\n      .run(\'card-sampling\', async () => {',
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

  // ── 假设备（调试用的合成数据）────────────────────────────────────
  //
  // **为什么假设备也要有守卫**：它喂的是**真 kind + 真 store**——
  // 一旦它开始编数（而不是吐原始文本），面板上就会出现**没人能解释的值**，
  // 而调试的人会把那些值当成板子的真实状态。

  {
    name: 'M64 假设备：读不到的文件必须给空（给 0 就是「板子满载」的假数）',
    file: 'src/main/hal/fake/exec.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: '一个字都没有',
    apply: (s) =>
      replace(s, "    return device.read(path.text) ?? '';", "    return device.read(path.text) ?? '0';"),
  },
  {
    name: 'M65 假设备：for 循环里的变量要替换成 glob 的每一项（否则温度全是空的）',
    file: 'src/main/hal/fake/exec.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: '温度按 type 归并',
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
    name: 'M66 假设备：profile 必须指着真的板型包（不然候选挑选选不上它）',
    file: 'src/main/hal/fake/profile.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: '假 profile 带 board_pack',
    apply: (s) => replace(s, "    board_pack: 'rk3588-atk',", "    board_pack: 'rk3588-nonexistent',"),
  },
  {
    name: 'M67 假设备：超时要真的超时（不然 stale 那一态永远看不见）',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: '往返超时',
    apply: (s) =>
      replace(
        s,
        '      if (this.timeoutEvery > 0 && this.fastRounds % this.timeoutEvery === 0) {',
        '      if (this.timeoutEvery > 0 && this.fastRounds % this.timeoutEvery === 1) {',
      ),
  },
  {
    name: 'M68 假设备：meminfo 坏了就是坏了（不能偷偷把 MemAvailable 补上）',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'meminfo 坏掉',
    apply: (s) =>
      replace(
        s,
        '      broken = this.breakMeminfoEvery > 0 && this.meminfoRounds % this.breakMeminfoEvery === 0;',
        '      broken = this.breakMeminfoEvery > 0 && this.meminfoRounds % this.breakMeminfoEvery === 1;',
      ),
  },
  {
    name: 'M69 假设备：计数器必须往前走（否则占用率永远是 pending）',
    file: 'src/main/hal/fake/device.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: '第二次采样 cpu.usage 是 ok',
    apply: (s) =>
      replace(
        s,
        '    const dt = Math.max(0, (at - this.lastAt) / 1000);',
        '    const dt = 0; // 变异：计数器不推进',
      ),
  },
  {
    name: 'M70 假设备：终端横幅必须真的发出去（构造时发 = 没人接）',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: '横幅要真的发出去',
    apply: (s) =>
      replace(
        s,
        "    this.emit(`⚠ 合成数据（${FAKE_DEVICE_MARKER}）—— 不是真板子；输入 help 看能做什么\\r\\n`);",
        '    /* 变异：不发横幅 */',
      ),
  },
  {
    name: 'M71 假设备：得是 pipe 模式（pty 的话命令永远匹配不上）',
    file: 'src/main/hal/fake/profile.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: '假 profile 声明 pipe 模式',
    apply: (s) => replace(s, '      pty: false,', '      pty: true,'),
  },
  {
    name: 'M72 假设备没载入成功时要**拒绝**（不能回落成真本机连接）',
    file: 'src/main/hal/fake/wiring.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-wiring.test.ts'],
    expect: '路由：载入成功才走假设备',
    apply: (s) =>
      replace(s, "  return fakeReady ? 'fake' : 'refuse';", "  return 'fake'; // 变异：永远走假设备"),
  },
  {
    name: 'M73 假设备：meminfo 的坏要真的注入（不然 error 那一态看不见）',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: 'meminfo 坏掉',
    apply: (s) =>
      replace(
        s,
        '      broken = this.breakMeminfoEvery > 0 && this.meminfoRounds % this.breakMeminfoEvery === 0;',
        '      broken = false; // 变异：meminfo 永远不坏',
      ),
  },
  {
    name: 'M77 控制面：string 参数必须加引号（不加 = 注入面敞开）',
    file: 'src/main/actions/encoder.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/encoder.test.ts'],
    expect: 'string 单引号包裹',
    apply: (s) =>
      replace(
        s,
        "      return quoteShellValue(raw, '参数值');",
        '      return raw; // 变异：不加引号',
      ),
  },
  {
    name: 'M78 控制面：enum 的取值必须真的查（不查 = 随便什么值都放行）',
    file: 'src/main/actions/encoder.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/encoder.test.ts'],
    expect: 'enum 的值不在 values 里',
    apply: (s) =>
      replace(
        s,
        '      if (!values.includes(raw)) {',
        '      if (values.length === 0) { // 变异：查错了东西',
      ),
  },
  {
    name: 'M79 控制面：运行时地板复查必须真的撞表（不撞 = 危险动作直接放行）',
    file: 'src/main/actions/floor-check.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/floor-check.test.ts'],
    expect: 'reboot → 命中',
    apply: (s) =>
      replace(
        s,
        '  const match = matchDangerFloorArgv(argv);',
        '  const match = { matched: false, pattern: null, why: null }; // 变异：不撞表',
      ),
  },
  {
    name: 'M80 控制面：basename 形态也要算（/usr/bin/reboot 与 reboot 同罪）',
    file: 'src/main/tags/floor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/floor-check.test.ts'],
    expect: 'basename 也算',
    apply: (s) => replace(s, '  return baseName(token) === pattern;', '  return false; // 变异：不看 basename'),
  },
  {
    name: 'M87 控制面：结果必须照回读来（回读不符不能报 ok）',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: '回读不符 → 不是 ok',
    apply: (s) =>
      replace(
        s,
        '    ok: readback.ok,',
        '    ok: true, // 变异：无视回读的结果',
      ),
  },
  {
    name: 'M88 控制面：审计行里必须有回读值（不然事后追不了责）',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: '审计行里有**参数**与**回读值**',
    apply: (s) => replace(s, '  record(outcome, readback.value);', '  record(outcome); // 变异：不记回读值'),
  },
  {
    name: 'M89 控制面：审计行必须带参数（参数是追责的一半）',
    file: 'src/main/actions/audit.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/audit.test.ts'],
    expect: '参数里的换行不能撑成两行',
    apply: (s) =>
      replace(
        s,
        '    `params=${JSON.stringify(row.params)}`,',
        "    '    params=' + JSON.stringify({}), // 变异：不记参数",
      ),
  },
  {
    name: 'M85 控制面：确认凭据必须一次性（用掉就没了）',
    file: 'src/main/actions/authorization.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/authorization.test.ts'],
    expect: '第二次用不行',
    apply: (s) =>
      replace(
        s,
        '    // **一次性**：用掉就删\n    this.issued.delete(token);',
        '    // 变异：不删（凭据可以重放）',
      ),
  },
  {
    name: 'M86 控制面：destructive 动作必须走确认（不能直接执行）',
    file: 'src/main/actions/authorization.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/authorization.test.ts'],
    expect: 'destructive → needs_confirmation',
    apply: (s) =>
      replace(
        s,
        "  const dangerous = action.danger === 'destructive' || floor.verdict === 'destructive';",
        "  const dangerous = action.danger === 'destructiv' || floor.verdict === 'destructive';",
      ),
  },
  {
    name: 'M83 控制面：回读形式 5 必须标 verified:false（标成 true = 把没验证当验证了）',
    file: 'src/main/actions/readback.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/readback.test.ts'],
    expect: 'verified: false',
    apply: (s) =>
      replace(
        s,
        "        ok: true,\n        verified: false,\n        detail: spec.consequence ?? '这个动作没有可回读的状态',",
        "        ok: true,\n        verified: true, // 变异：把「没验证」说成验证了\n        detail: spec.consequence ?? '这个动作没有可回读的状态',",
      ),
  },
  {
    name: 'M84 控制面：串口上没有退出码 → 必须报 unsupported_transport（不是「不符」）',
    file: 'src/main/actions/readback.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/readback.test.ts'],
    expect: 'unsupported_transport',
    apply: (s) =>
      replace(
        s,
        "      reason: 'unsupported_transport',\n      detail: '这条连接没有退出码（串口），command_ok 用不了',",
        "      reason: 'failed', // 变异：当成「不符」\n      detail: '这条连接没有退出码（串口），command_ok 用不了',",
      ),
  },
  {
    name: 'M81 队列：四级优先级（动作必须插到采样前面）',
    file: 'src/main/hal/round-trip-queue.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/round-trip-queue.test.ts'],
    expect: '四级：action-verify > manual-refresh > card-sampling > diagnostics',
    apply: (s) =>
      replace(
        s,
        "const PRIORITY: readonly RoundTripKind[] = [\n  'action-verify',\n  'manual-refresh',",
        "const PRIORITY: readonly RoundTripKind[] = [\n  'manual-refresh',\n  'action-verify',",
      ),
  },
  {
    name: 'M82 队列：排队超过 deadline 的事务要被丢掉（不执行）',
    file: 'src/main/hal/round-trip-queue.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/round-trip-queue.test.ts'],
    expect: '排队超过 deadline',
    apply: (s) =>
      replace(
        s,
        '        if (waited > entry.deadlineMs) {',
        '        if (waited > entry.deadlineMs * 1000) { // 变异：deadline 形同虚设',
      ),
  },
  {
    name: 'M90 假设备：cat 读不到文件必须**报错**（空串 + 0 = 把「文件不在」说成「值是空的」）',
    file: 'src/main/hal/fake/file-ops.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device-files.test.ts'],
    expect: '读不存在的文件',
    apply: (s) =>
      replace(
        s,
        '    return failure(1, `cat: ${path}: No such file or directory`);',
        '    return failure(0, `cat: ${path}: No such file or directory`); // 变异：假装成功',
      ),
  },
  {
    name: 'M91 假设备：push 必须真的写进虚拟盘（不写 = 报告成功却没传）',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device-files.test.ts'],
    expect: 'push：宿主上的文件真的进了虚拟 fs',
    apply: (s) =>
      replace(
        s,
        '    this.fs.write(target, readFileSync(localPath));',
        '    // 变异：读到了但不写\n    void readFileSync(localPath);',
      ),
  },
  {
    name: 'M92 bridge：端口没到要**等**（立刻回 not_connected = 卡片静默什么都不做）',
    file: 'src/main/cards/bridge-script.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/bridge-script.test.ts'],
    expect: '调用要**等端口**',
    apply: (s) =>
      replace(
        s,
        '    if (port !== null) return post(method, args);',
        '    if (true) return Promise.resolve({ ok: false, reason: \'not_connected\' }); // 变异：不等',
      ),
  },
  {
    name: 'M93 控制面：回读的值必须在 `readback` 里（平铺 = 与契约 spec/04 §2.4 不符）',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: '回读到的值在 `readback` 里',
    apply: (s) =>
      replace(
        s,
        '          readback: {',
        '          readback_flat: { // 变异：把 readback 摊平（契约要的是嵌套）',
      ),
  },
  {
    name: 'M94 流程包：未知字段必须报错（静默忽略 = 流程照跑，只是少做了一件事）',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: '之外的字段一律不认',
    apply: (s) =>
      replace(
        s,
        "      fail(`未知字段 '${key}'`, ctx.source, { path: `${ctx.path}${path}${path ? '.' : ''}${key}` });",
        '      void key; // 变异：静默忽略未知字段',
      ),
  },
  {
    name: 'M95 流程层：发现的**排除表**必须真的排除（漏一个 = 把中间文件当产物送上去）',
    file: 'src/main/workflows/discover.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/discover.test.ts'],
    expect: '排除表里的不要',
    apply: (s) =>
      replace(
        s,
        '.filter((entry) => !excluded.some((rule) => matchesPattern(entry.name, rule)))',
        '.filter(() => true) // 变异：不管排除表',
      ),
  },
  {
    name: 'M96 目标登记处：profile 不存在必须**报错**（不许悄悄连到别的目标）',
    file: 'src/main/workflows/targets.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/targets.test.ts'],
    expect: 'profile 不存在',
    apply: (s) =>
      replace(
        s,
        '    if (profile === undefined) {',
        '    if (false) { // 变异：连到别的目标去',
      ),
  },
  {
    name: 'M97 流程层：跨目标的判据必须**在指名的角色上读**（在客机上读 = 假阳性）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '判据在指名的角色上读',
    apply: (s) =>
      replace(
        s,
        '  const result = await runReadbackOnRole(ctx, readRole, step.readback, substitution);',
        '  const result = await runReadbackOnRole(ctx, stepRole ?? readRole, step.readback, substitution); // 变异：在本步的角色上读',
      ),
  },
  {
    name: 'M98 流程层：步声明 destructive 时必须**要人确认**（凭据准备那一步 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '声明 destructive 的步要人确认',
    apply: (s) =>
      replace(
        s,
        "    danger: step.danger ?? 'reversible',",
        "    danger: 'reversible', // 变异：步自己声明的 danger 被丢掉",
      ),
  },
  {
    name: 'M99 流程层：命令的输出必须**进槽**（下一步要靠它 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '槽里就是那条命令的输出',
    apply: (s) =>
      replace(
        s,
        '  if (step.out !== undefined && outcome.output !== undefined) {',
        '  if (false) { // 变异：输出不进槽',
      ),
  },
  {
    name: 'M100 假设备：**多个角色**都要走假设备（只认一个 = 流程层演不了）',
    file: 'src/main/hal/fake/wiring.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-wiring.test.ts'],
    expect: '假设备',
    apply: (s) =>
      replace(
        s,
        '  if (!fakeProfileIds(env).includes(profileId)) return \'not-fake\';',
        "  if (profileId !== 'fake-board') return 'not-fake'; // 变异：只认一个角色",
      ),
  },
  {
    name: 'M101 流程层：命令里的输入必须**用编码后的片段**（原始值 = 注入面敞开）',
    file: 'src/main/workflows/substitute.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '输入**按类型编码**',
    apply: (s) =>
      replace(
        s,
        '    const encoded = ctx.encoded[name];',
        '    const encoded = ctx.inputs[name] === undefined ? undefined : String(ctx.inputs[name]); // 变异：原始值',
      ),
  },
  {
    name: 'M102 流程包：placement 必须在**封闭词表**里（拼错 = 默默落错地方）',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: '封闭词表',
    apply: (s) =>
      replace(
        s,
        '    if (!isPlacement(placement)) {',
        '    if (false) { // 变异：词表不查了',
      ),
  },
  {
    name: 'M103 控制面：回读的**验证命令**也要过危险地板（包给的命令不能借「验证」之名跑危险命令）',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: '验证命令也要过地板',
    apply: (s) =>
      replace(
        s,
        '          const verifyFloor = checkFloor(cmd);',
        '          const verifyFloor = { verdict: "ok", matched: false }; // 变异：不查地板',
      ),
  },
  {
    name: 'M104 流程层：确认凭据必须**绑住这一步的输入**（换输入 = 凭据作废）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '同一张凭据换一组输入',
    apply: (s) =>
      replace(
        s,
        '    ...Object.fromEntries(Object.entries(ctx.inputs).map(([k, v]) => [`input:${k}`, v])),',
        '    // 变异：输入不进摘要',
      ),
  },
  {
    name: 'M105 流程层：角色事实要**包引号**（profile 是半可信的 → 不能原样插）',
    file: 'src/main/workflows/substitute.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '角色事实**要包引号**',
    apply: (s) =>
      replace(
        s,
        "    return typeof value === 'number' ? String(value) : quoteShellValue(String(value), '连接事实');",
        '    return String(value); // 变异：原样插',
      ),
  },
  {
    name: 'M106 流程注册表：**放一个文件进目录 ≠ 批准它**（否则 agent 能自写包就跑）',
    file: 'src/main/workflows/registry.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/registry.test.ts'],
    expect: '还没有被批准',
    apply: (s) =>
      replace(
        s,
        '          approved: approval !== undefined && approval.digest === digest,',
        '          approved: true, // 变异：放进目录就算批准',
      ),
  },
  {
    name: 'M107 流程注册表：**批准绑内容摘要**（改了内容要重新批准）',
    file: 'src/main/workflows/registry.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/registry.test.ts'],
    expect: '改了内容要重新批准',
    apply: (s) =>
      replace(
        s,
        '          approved: approval !== undefined && approval.digest === digest,',
        '          approved: approval !== undefined, // 变异：只认 id 不认内容',
      ),
  },
  {
    name: 'M108 流程服务：**只认 id 不认路径**（没批准的包跑不了）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '没批准的流程跑不了',
    apply: (s) =>
      replace(
        s,
        '    const registered = this.opts.registry.requireApproved(id);',
        '    const registered = this.opts.registry.get(id); // 变异：不查批准账\n    if (registered === undefined) {\n      throw makeError(\'IPC_INVALID_PAYLOAD\', `没有这个流程包：${id}`);\n    }',
      ),
  },
  {
    name: 'M109 确认凭据：**签发 ≠ 有效**（没人点，confirm_id 永远无效 ✓）',
    file: 'src/main/actions/authorization.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/authorization.test.ts'],
    expect: '签发 ≠ 有效',
    apply: (s) =>
      replace(
        s,
        "    if (entry.state !== 'approved') return false;",
        '    // 变异：签发即可用（确认通道形同虚设）',
      ),
  },
  {
    name: 'M110 流程服务：**确认链有落点**（人点头 → 从停住的那步继续 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '人点头之后继续跑',
    apply: (s) =>
      replace(
        s,
        '    const approved = this.opts.confirmations?.approve(confirmId, this.now()) ?? false;',
        '    const approved = true; // 变异：不用人点头就放行',
      ),
  },
  {
    name: 'M111 流程服务：**续跑从停住的那一步开始**（前面的步不重跑 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '续跑',
    apply: (s) =>
      replace(
        s,
        '    if (index < startAt) continue;',
        '    // 变异：续跑时从头再跑一遍',
      ),
  },
  {
    name: 'M112 审计行：必须带**最终命令**（追责的第一环 ✓）',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/executor.test.ts'],
    expect: '命令是编码过的',
    apply: (s) =>
      replace(
        s,
        '      command,\n      ...(deps.auditInputs === undefined ? {} : { inputs: deps.auditInputs }),',
        '      ...(deps.auditInputs === undefined ? {} : { inputs: deps.auditInputs }), // 变异：命令不进审计行',
      ),
  },
  {
    name: 'M113 审计行：流程的**输入值**要进去（不然事后看不到用了哪个工程 ✓）',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '这一步的输入',
    apply: (s) =>
      replace(
        s,
        '      ...(deps.auditInputs === undefined ? {} : { inputs: deps.auditInputs }),',
        '      // 变异：输入不进审计行',
      ),
  },
  {
    name: 'M114 卡片校验：规则 3 的**流程那一半**（声明了却没授权 → 报错 ✓）',
    file: 'src/main/cards/validate.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/validate.test.ts'],
    expect: '声明了却没授权',
    apply: (s) =>
      replace(
        s,
        "  for (const workflowId of requires.workflows ?? []) {",
        '  for (const workflowId of [] as string[]) { // 变异：流程那一半不查',
      ),
  },
  {
    name: 'M115 流程服务：**agent 只能请求确认，不能自己批准**（V3-C1 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: 'agent 只能「请求」确认',
    apply: (s) =>
      replace(
        s,
        '    const queued = this.opts.confirmations?.request(confirmId, this.now()) ?? false;',
        '    const queued = this.opts.confirmations?.approve(confirmId, this.now()) ?? false; // 变异：请求即批准',
      ),
  },
  {
    name: 'M116 流程服务：**卡级授权**要查（这张卡没被授过 → 跑不了 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '卡级授权',
    apply: (s) =>
      replace(
        s,
        '      if (!granted.includes(id)) {',
        '      if (false) { // 变异：不查卡级授权',
      ),
  },
  {
    name: 'M117 流程服务：**同一个流程同时只允许跑一次**（两个流程抢一条线会串台 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '同一个流程同时只允许跑一次',
    apply: (s) =>
      replace(
        s,
        "      if (existing.workflowId === id && existing.state === 'running') {",
        "      if (false) { // 变异：不挡并发",
      ),
  },
  {
    name: 'M118 授权账：流程的批准要**单独记**（与动作的域不同 ✓）',
    file: 'src/main/cards/grants.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/grants.test.ts'],
    expect: '流程',
    apply: (s) =>
      replace(
        s,
        `  workflowIds(cardId: string): string[] {
    return this.workflowGrants.get(cardId) ?? [];
  }`,
        `  workflowIds(cardId: string): string[] {
    return []; // 变异：流程的授权查不到
  }`,
      ),
  },
  {
    name: 'M120 流程包：版本词汇必须与契约一致（`apiVersion`，**不是** formatVersion ✓）',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: 'apiVersion 只认 devboard/v1',
    apply: (s) =>
      replace(
        s,
        "  if (raw['apiVersion'] !== KNOWN_API_VERSION) {",
        "  if (raw['apiVersion'] !== 'devboard/v2') { // 变异：版本词汇漂了",
      ),
  },
  {
    name: 'M121 流程包：`default` 自己也要合法（宿主不能预填一个非法值 ✓）',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: '宿主不能预填一个非法值',
    apply: (s) =>
      replace(
        s,
        '    if (def.default !== undefined) checkDefault(def, name, ctx);',
        '    // 变异：不校验 default',
      ),
  },
  {
    name: 'M122 HAL：取消必须**真的杀掉进程**（不是「不等了」✓ —— 尖兵的现象 ✓）',
    file: 'src/main/util/spawn.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/spawn-abort.test.ts'],
    expect: '进程真的被杀掉了',
    apply: (s) =>
      replace(
        s,
        `      try {
        child.kill('SIGTERM');
      } catch {
        // 已经退了就算了
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经没了就算了
        }
      }, 200);`,
        `      // 变异：**只是不等了**（尖兵的现象 ✓ —— 进程还在后台跑 ✗）`,
      ),
  },
  {
    name: 'M123 流程层：**取消**要把状态变成 cancelled（不是 failed ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '状态变 cancelled',
    apply: (s) =>
      replace(
        s,
        "    status.state = 'cancelled';",
        "    status.state = 'failed'; // 变异：取消被当成失败",
      ),
  },
  {
    name: 'M124 流程层：**取消**之后那次收尾不许把状态翻回去（独立评审 40 的 C-1 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '不能把状态翻回去',
    apply: (s) =>
      replace(
        s,
        "      if (status.state !== 'cancelled') {",
        '      if (true) { // 变异：收尾把「取消」翻回去了',
      ),
  },
  {
    name: 'M125 流程层：取消一个**已经结束**的运行 → 状态一个字都不改（幂等 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '状态不变',
    apply: (s) =>
      replace(
        s,
        "    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') {",
        '    if (false) { // 变异：连已经结束的运行也改状态',
      ),
  },
  {
    name: 'M126 执行器：被取消 → 理由是 cancelled（不是「回读不符」✓）',
    file: 'src/main/actions/executor.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '理由写 cancelled',
    apply: (s) =>
      replace(
        s,
        '  if (execResult.cancelled === true) {',
        '  if (false) { // 变异：把「取消」当成「跑成了」',
      ),
  },
  {
    name: 'M127 流程层：被叫停 → **后面那一步不跑**（人不要了，就别再往下做 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '后面那一步不跑',
    apply: (s) =>
      replace(
        s,
        "    if (opts.signal?.aborted === true) break;\n    const stage = await runStep(step, {",
        "    // 变异：叫停了也往下跑\n    const stage = await runStep(step, {",
      ),
  },
  {
    name: 'M128 流程层：被叫停 → **不跑跨目标的判据**（取消后别再让人多等一条命令 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '不跑跨目标的判据',
    apply: (s) =>
      replace(
        s,
        '  if (ctx.opts.signal?.aborted === true) return undefined;',
        '  if (false) return undefined; // 变异：取消后还去验',
      ),
  },
  {
    name: 'M129 流程层：**取消**要撤销那张待确认的凭据（人别去点一个已取消的运行 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '撤销那张待确认的凭据',
    apply: (s) =>
      replace(
        s,
        '      this.opts.confirmations?.revoke(pending);',
        '      // 变异：不撤销（凭据还能被人点成有效 ✗）',
      ),
  },
  {
    name: 'M130 流程层：**取消**要记一行审计（「谁叫停的」查得到 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '取消要记一行审计',
    apply: (s) =>
      replace(
        s,
        `    // **记一行审计** ✓（「谁叫停的」要查得到 ✓ —— 独立评审 40 的 I-8 ✓）
    this.opts.runDeps.audit({
      at: this.now(),
      actor: 'host',
      actionId: \`workflow:\${status.workflowId}:cancel\`,
      params: { runId },
      ok: true,
      verified: true,
      detail: '人叫停了这次运行',
    });`,
        '    // 变异：不记审计',
      ),
  },
  {
    name: 'M131 回读：命令被取消 → 理由说「取消」（不是「回读不符」✓）',
    file: 'src/main/actions/readback.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/actions/readback.test.ts'],
    expect: '理由是 cancelled',
    apply: (s) =>
      replace(
        s,
        '  if (actionResult.cancelled === true) {',
        '  if (false) { // 变异：把「取消」说成「不符」',
      ),
  },
  {
    name: 'M132 流程层：`status` 要说得出「**现在在第几步**」（界面不能一片死寂 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '说得出「现在在第几步',
    apply: (s) =>
      replace(
        s,
        '              status.current = { stepId: info.stepId, kind: info.kind, at: info.at };',
        '              status.current = null; // 变异：不说「现在在第几步」',
      ),
  },
  {
    name: 'M133 流程层：**时间线边跑边填**（不是跑完才给 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '时间线边跑边填',
    apply: (s) =>
      replace(
        s,
        '              status.stages = [...status.stages, stage];',
        '              // 变异：不实时上报',
      ),
  },
  {
    name: 'M134 流程层：传输没成 → **清掉那个半截文件**（不留残留 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '清掉那个半截文件',
    apply: (s) =>
      replace(
        s,
        '  const command = `rm -f -- ${quotePath(path)}`;',
        '  const command = `true`; // 变异：不清理',
      ),
  },
  {
    name: 'M135 流程层：目的地**原本就有** → **不许删**（别删用户的东西 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '不许删',
    apply: (s) =>
      replace(
        s,
        "  if (before !== 'not-there') {",
        '  if (false) { // 变异：连用户自己的文件也删',
      ),
  },
  {
    name: 'M136 流程层：**清理路径必须编码**（`to.path` 是包给的 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '清理路径必须编码',
    apply: (s) =>
      replace(
        s,
        '  const command = `rm -f -- ${quotePath(path)}`;',
        '  const command = `rm -f -- ${path}`; // 变异：不编码',
      ),
  },
  {
    name: 'M137 流程层：**传了但没验成** → **不清**（那不是「没传成」✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '传了，但没验成',
    apply: (s) =>
      replace(
        s,
        '  const commandFailed = !outcome.ok;',
        '  const commandFailed = true; // 变异：连「传了但没验成」也清',
      ),
  },
  {
    name: 'M138 卡片会话：流程的授权看**自己那一维**（不许混进 permissions.write ✓）',
    file: 'src/main/cards/session.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/session.test.ts'],
    expect: '第四维授权',
    apply: (s) =>
      replace(
        s,
        "        api.permission === 'write' ? session.perms.write : (session.perms.workflows ?? []);",
        '        session.perms.write; // 变异：两维混成一维',
      ),
  },
  {
    name: 'M139 卡片侧流程状态：**缩减投影**（路径/角色/明细/审计号一个都不给 ✓ —— V3-M7 ✓）',
    file: 'src/main/cards/workflow-view.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/workflow-view.test.ts'],
    expect: '只留契约说的那几个字段',
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
        '    stages: status.stages.map((stage) => ({ ...stage })), // 变异：全泄',
      ),
  },
  {
    name: 'M140 卡片校验 **规则 14**：流程权限不许通配符（契约 §九 ✓）',
    file: 'src/main/cards/validate.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/validate.test.ts'],
    expect: '规则 14',
    apply: (s) =>
      replace(
        s,
        "  for (const id of perms.workflows ?? []) {\n    if (id.includes('*')) {",
        "  for (const id of perms.workflows ?? []) {\n    if (false) {",
      ),
  },
  {
    name: 'M141 卡片校验 **规则 14**：宿主里没有这个流程 → 报错 ✓',
    file: 'src/main/cards/validate.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/cards/validate.test.ts'],
    expect: '规则 14',
    apply: (s) =>
      replace(
        s,
        "    } else if (!ctx.availableWorkflows.includes(id)) {",
        "    } else if (false) {",
      ),
  },
  {
    name: 'M142 确认链：人点头 → **从那一步继续**（前面的步**不重跑** ✓ —— 契约 §7.6 ✓）',
    file: 'src/main/workflows/interactive.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/interactive.test.ts'],
    expect: '从那一步继续',
    apply: (s) =>
      replace(
        s,
        '  const startAt = pack.steps.findIndex((s) => s.id === pending.stepId);',
        '  const startAt = 0; // 变异：从头再跑一遍（前面的步重跑了 ✗）',
      ),
  },
  {
    name: 'M143 确认链：**人摇头 → 那一步不许跑**（没人点头就不许做 ✗）',
    file: 'src/main/workflows/interactive.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/interactive.test.ts'],
    expect: '人摇头',
    apply: (s) =>
      replace(
        s,
        '  if (!yes) return first;',
        '  if (false) return first; // 变异：摇头也照样做',
      ),
  },
  {
    name: 'M144 流程层：**异常路径**也不许把「取消」翻成 failed（独立评审 40 的 I-1 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '取消之后走了异常路径',
    apply: (s) =>
      replace(
        s,
        "    } catch (err) {\n      // **取消过的运行 → 状态不许被这条异常路径翻回去** ✓（独立评审 40 的 I-1 ✓）\n      // → 「人叫停」必须活到最后 ✓（契约 §八·A·A2 ✓ —— 取消不是失败 ✓）\n      if (status.state !== 'cancelled') {",
        "    } catch (err) {\n      // 变异：异常路径把「取消」翻成 failed\n      if (true) {",
      ),
  },
  {
    name: 'M145 流程层：**步出错了也要有那一行**（异常不许穿透整次运行 ✓ —— 独立评审 40 的 I-2 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '目标连不上 → 时间线上有一行',
    apply: (s) =>
      replace(
        s,
        '    const detail = err instanceof Error ? err.message : String(err);',
        '    throw err; // 变异：异常穿透整次运行（时间线上一行都没有 ✗）\n    const detail = err instanceof Error ? err.message : String(err);',
      ),
  },
  {
    name: 'M146 流程包：**file.transfer 的 from.path 必填**（契约 §4.4 ✓）',
    file: 'src/main/workflows/format.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/format.test.ts'],
    expect: 'from 缺 path → 校验就报错',
    apply: (s) =>
      replace(
        s,
        "      if (step.from.path === undefined) {\n        fail('file.transfer 步的 from 必须有 path（源端的路径）', ctx.source);\n      }",
        '      // 变异：不收 from.path（留到运行时才炸 ✗）',
      ),
  },
  {
    name: 'M147 流程层：**值模式也要拿到 default**（两种替换模式都得有它 ✓ —— 独立评审 40 的 I-3 ✓）',
    file: 'src/main/workflows/runner.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/runner.test.ts'],
    expect: '值模式也要拿到默认值',
    apply: (s) =>
      replace(
        s,
        '  const mergedInputs: Record<string, unknown> = { ...defaults, ...inputs };',
        '  const mergedInputs: Record<string, unknown> = inputs; // 变异：值模式拿不到默认值',
      ),
  },
  {
    name: 'M148 卡片侧：输入声明要带 **default**（卡片才能自己预填 ✓ —— 独立评审 40 的 I-3 ✓）',
    file: 'src/main/workflows/service.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/workflows/service.test.ts'],
    expect: '带 default',
    apply: (s) =>
      replace(
        s,
        '              ...(def.default === undefined ? {} : { default: def.default }),',
        '              // 变异：不给卡片 default',
      ),
  },
  {
    name: 'M74 假设备：超时只落在快组（慢组的读数不该被带走）',
    file: 'src/main/hal/fake/connection.ts',
    check: ['npx', 'vitest', 'run', 'tests/unit/fake-device.test.ts'],
    expect: '超时只落在快组上',
    apply: (s) =>
      replace(s, '    if (isFast) {', '    if (true) { // 变异：每一组都算快组'),
  },

  {
    name: 'M75 外壳：「已在主区」按实例键判（不是 cardId）',
    file: 'src/renderer/shell/nav.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-nav.test.ts'],
    expect: '摆进主区的那张卡',
    apply: (s) =>
      replace(
        s,
        '    const key = slotKey(card.cardId, card.connectionId);',
        '    const key = card.cardId; // 变异：按 cardId 判',
      ),
  },
  {
    name: 'M76 外壳：会话行要有关闭按钮（串口与 SSH 的连接是独占的）',
    file: 'src/renderer/shell/nav.ts',
    check: ['npx', 'vitest', 'run', 'tests/web/shell-nav.test.ts'],
    expect: '会话行有关闭按钮',
    apply: (s) =>
      replace(
        s,
        '    onClose: () => ctx.onCloseSession(session.sessionId),\n',
        '    // 变异：没有关闭路径\n',
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
