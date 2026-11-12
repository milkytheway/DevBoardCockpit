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
import { readFileSync, writeFileSync } from 'node:fs';
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
    file: 'src/renderer/App.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/app-error.test.tsx'],
    expect: '把原因显示出来',
    apply: (s) =>
      replace(
        s,
        `      {error ? (
        <p className="cockpit-error" role="alert">
          {error}
        </p>
      ) : null}`,
        '      {null}',
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
      replace(s, '          toRemote += `${this.line}\\n`;', '          toRemote += this.line;'),
  },
  {
    name: 'M10 上传要传绝对路径',
    file: 'src/renderer/App.tsx',
    check: ['npx', 'vitest', 'run', 'tests/web/app-error.test.tsx'],
    expect: '绝对路径',
    apply: (s) => replace(s, 'const localPath = api.getPathForFile(file);', 'const localPath = file.name;'),
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

console.log('=== 变异测试：验证回归测试真的在守 ===');
console.log();

for (const m of MUTATIONS) {
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

  let result;
  try {
    result = run(m.check[0], m.check.slice(1));
  } finally {
    // 还原——不管验成什么样，文件必须回到原样
    writeFileSync(path, original, 'utf8');
  }

  if (result.rc === 0) {
    console.log(`✗ ${m.name}：改坏之后测试**仍然全绿** —— 这个测试形同虚设`);
    fail += 1;
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

console.log();
console.log(`=== 结果：守住 ${pass} 项，形同虚设 ${fail} 项 ===`);
process.exit(fail > 0 ? 1 : 0);
