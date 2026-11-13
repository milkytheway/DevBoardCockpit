# 12 · 计划 1 复评报告（Renderer / UI-UX / 可访问性）

> **基线**：`docs/11-计划1评审报告.md`（评审 HEAD `75b6ac1`）
> **本轮 HEAD**：`f8315cf`（Claude Desktop 重写 renderer）
> **范围**：`src/renderer/**`、`src/preload/**`、`src/shared/{ipc-contract,errors}.ts`，
> 以及与 UI 直接耦合的 `src/main/{index.ts,files/,terminal/,hal/}`。
> **日期**：2026-11-13

---

## 〇、一页结论

这一轮**修得很实**：上一轮 57 条里，与 renderer 直接相关的 14 条中 **9 条真修好了、2 条只修了一半、3 条没动**。
尤其 R-03（错误到不了眼前）、R-04（传错文件）、R-05（下载必挂）、R-06（切标签丢历史）
这四条 P0/P1 **都真的修好了，而且我逐条追到了字节级**。

但**这一轮也引入了三条新的用户可见缺陷**，其中一条我认为是 P1：

| # | 新缺陷 | 严重度 |
|---|---|---|
| **N-1** | pipe 模式画的提示符**画在命令输出之前** → 每条命令的输出都落在「下一个提示符」后面，屏幕读起来是乱的 | **P1** |
| **N-2** | 上传的远端目标**恒为 `/`** → SSH 与本机传输必挂 | **P1** |
| **N-5** | 切标签会把**后台标签的终端 resize 成极小尺寸**，并把这个尺寸报给远端（SSH `setWindow` / 本机 `pty.resize`） | **P2** |

另有一条**上一轮判过的「已修复」其实是漏测**：R-24（对比度）在 `--cockpit-bg-elevated` 上仍然不达标，
而新加的 `tests/unit/contrast.test.ts` **只测 `--cockpit-bg`** → 恰好漏掉了真正渲染它的那块背景。

**一句话**：功能面这一轮是真修好了（错误、传文件、切标签、焦点都在），
但**提示符画早了**、**上传目标写死**、**对比度测错背景**这三件事，
让「ADB 终端」和「文件上传」这两条主路径在屏幕上仍然是坏的。

---

## 一、本轮我实际跑了什么（可复现）

| 命令 | 结果 |
|---|---|
| `$env:PREBUILDS_ONLY="1"; node node_modules/vitest/vitest.mjs run` | **27 files / 178 tests 全绿** |
| `node node_modules/eslint/bin/eslint.js .` | **通过**，0 问题（exit 0） |
| `node node_modules/tsx/dist/cli.mjs <scratch>` | 用**真实的 `TerminalManager` + `PipeInput`** 复现提示符时序（§四） |
| scratch vitest（`.scratch-review/`，跑完已删，`git status` 干净） | 复现关闭按钮键盘无效、远端树不能进、标签条无 ARIA |
| `node <scratch>`（对比度脚本，$TEMP\dbc-contrast.mjs） | 重算全部 token 对（§三） |

> **环境备注**：`node_modules` 是 Linux 装的，本机必须带 `PREBUILDS_ONLY=1` 才跑得起来；
> `electron` 的二进制**不在本机**（`node_modules/electron/dist/electron.exe` 不存在），
> 所以凡是「必须在真浏览器里量」的地方，我在报告里**明确标注了推断与确定度**。

---

## 二、上一轮 renderer 相关问题的逐条判定

### 2.1 判定总表

| # | 原问题 | 判定 | 关键证据 |
|---|---|---|---|
| **R-03** | 错误跨 IPC 退化 → `[object Object]` | ✅ **已修复** | `shared/errors.ts:33-59` 改成 `AppError extends Error`；`main/index.ts:89-97` 主进程**不抛**，返回 `{ok:false,error}`；`preload/index.ts:21-25` 还原成实例再抛；`App.tsx:141` 显示 `err.message` |
| **R-04** | 上传传 basename | ✅ **已修复** | `preload/index.ts:49` `webUtils.getPathForFile`；`App.tsx:183` `const localPath = api.getPathForFile(file)` |
| **R-05** | 下载传空串 | ✅ **已修复** | `main/index.ts:148-159` → `files/download-target.ts:44`；`App.tsx:204` 把落盘路径显示出来 |
| **R-06** | 切标签销毁 xterm + 丢后台输出 | ✅ **已修复**（但引出 N-5） | `App.tsx:211-230` 所有标签都挂载、用 `hidden` 切换；`App.tsx:44-46,92-108` 全局订阅 + `pending` 缓冲 |
| **R-09** | 远端自己退出不上报 | ✅ **已修复** | `hal/ssh.ts:417`、`hal/adb.ts:351` 的 `onExit` → `terminal/manager.ts:139` |
| **R-10** | 多标签共用 profile → 关一个另一个废 | ✅ **已修复** | `main/index.ts:51,62-63` 连接表**按 sessionId 建索引** |
| **R-11** | 本机在 Windows 上列不出目录 | ✅ **已修复** | `hal/local.ts:75-114` 改用 `fs.readdir`，并把 `/` 映射到 `process.cwd()` |
| **R-12** | 符号链接解析成 `lib64 -> lib` | ✅ **已修复** | 新增 `src/main/util/ls-output.ts` |
| **R-13** | `capabilities.ts` 是死代码 | ✅ **已修复** | `hal/registry.ts:5,24` 改成 `export { capabilitiesFor }`，`profile.options.pty` 现在真的生效 |
| **R-16** | 终端从不获得焦点 | ✅ **已修复** | `TerminalView.tsx:82` `term.focus();` |
| **R-20** | push/pull 没有 `.catch` | ✅ **已修复** | `App.tsx:188-191,202-205` + `reportTransfer` |
| **R-21** | `.cockpit-error` 没有 CSS 规则 | ✅ **已修复** | `tokens.css:159-166` |
| **R-23** | `onTerminalExit` 丢弃 exitCode | ✅ **已修复** | `App.tsx:67,74-76` |
| **R-27** | 关活动标签主区变空白 | ✅ **已修复** | `App.tsx:151` 回落 |
| **R-28** | 退出处理不碰 `active` | ✅ **已修复** | `App.tsx:69-73` |
| **R-29** | `terminalClose` fire-and-forget | ✅ **已修复** | `preload/index.ts:31` 改 `invoke`；`main/index.ts:115` 走 `handle`；`App.tsx:155-157` `.catch` |
| **R-24** | 两个 token 对比度不达标 | ⚠️ **部分修复** | `--cockpit-bg` 上达标；**`--cockpit-bg-elevated` 上 `--cockpit-unavailable` 仍只有 4.19:1**（见 §三） |
| **R-26** | `transport`/`boardPack` 拉了不用 | ⚠️ **部分修复** | `App.tsx:239` 展示了 `transport`；`boardPack` 仍未展示，也没有「这条连接活着吗」的指示 |
| **R-36** | `options.commands` 无人消费 | ⚠️ **仅加注释** | `profiles/schema.ts:40-43` 注明「已登记但尚未消费」；实现仍是零 |
| **R-15** | 关闭按钮键盘不可用 | ❌ **未修复** | `App.tsx:253-262` 结构原样（见 §五 P1-1） |
| **R-25** | `connectionsList` 只拉一次 | ❌ **未修复** | `App.tsx:53`，仍是 mount 时一次 |
| **R-19** | 「双树浏览」不成立 | ❌ **未修复** | `FileBrowser.tsx` **整个文件没被改过**（不在 `75b6ac1..f8315cf` 的 diff 里） |
| **R-22** | `stripMarkers` 生产零调用 | ❌ **未修复** | 全仓 grep 仍只有 `tests/unit/marker.test.ts` 引用 |
| **R-35** | `capabilities` 两套词表 | ❌ 未修复（属 O10） | — |
| **R-37** | `docs/04 §10` 与实现不同步 | ❌ 未修复 | — |

### 2.2 值得单独说的三条

#### R-03 —— 修得对，而且**测试也换对了**

上一轮这条最要命的地方是「测试编码的是**结论**而不是**行为**」。
这一轮两个测试都换成了**真实形状**：

`tests/web/app-error.test.tsx:74-92`
```tsx
  it('打开连接失败时把原因显示出来', async () => {
    // 宿主说「串口 COM3 被占用」。
    // **抛的是 makeError 造的对象**——这才是真实代码路径抛的形状。
    installHost({
      terminalOpen: async () => {
        throw makeError('PORT_BUSY', '串口 COM3 被占用');
      },
    });
    ...
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('COM3');
    });
  });
```

`tests/unit/preload.test.ts:61-71` 另外守住了「跨 IPC 不退化」这一段：
```tsx
    const err = await api.terminalOpen('board-serial').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('串口 COM3 被占用');
    expect(String(err)).not.toContain('[object Object]');
```

**端到端我追了一遍，链路是闭合的**：

```
hal 抛 makeError('PORT_BUSY','串口 COM3 被占用')        // AppError 实例
  → main/index.ts:89-97  handle()  catch → toAppErrorPayload
      → { ok:false, error:{ code:'PORT_BUSY', message:'串口 COM3 被占用', retryable:false } }
  → preload/index.ts:22-24  invoke() → appErrorToException(payload)
      → new AppError('PORT_BUSY','串口 COM3 被占用')   // 仍是 Error 实例
  → App.tsx:141  setError(err instanceof Error ? err.message : String(err))
  → App.tsx:268  <p className="cockpit-error" role="alert">{error}</p>
```

**「串口 COM3 被占用」这句话到得了用户眼前。R-03 真的修好了。**

> ⚠️ 但根因那一段仍然没测 → 见 **P2-4（N-7）**。

#### R-06 —— 修得比我预期的干净

`App.tsx:211-230`：
```tsx
  const panels = useMemo(
    () =>
      tabs.map((tab) => (
        <div key={tab.sessionId} className="cockpit-tabpanel" hidden={tab.sessionId !== active}>
          <TerminalView sessionId={tab.sessionId} subscribe={getSubscribe(tab.sessionId)} ... />
        </div>
      )),
    [tabs, active, getSubscribe],
  );
```
- `key={tab.sessionId}` 在**外层 div** 上 → React 按 key 对齐 → `TerminalView` 实例**不重建** →
  `TerminalView.tsx:109` 的 `useEffect(..., [sessionId])` 不重跑 → **xterm 不被 dispose**。
- 全部标签都挂着 → 每个会话都注册了 writer → **后台标签的输出不再丢**。
- `App.tsx:55-65` 还有一个 `pending` 缓冲兜住「会话开了但组件还没挂载」这段窗口（SSH 欢迎语、ADB banner）。

**这条我确认是真修好了。**（但它引出 N-5，见 §五。）

#### R-04 / R-05 —— 修得对

`App.tsx:174-194`：
```tsx
      // **必须是宿主的绝对路径**：传 `file.name`（只有 basename）的话，
      // 宿主会在**自己的 CWD** 里找同名文件——要么失败，
      // 要么**传走另一个文件**（数据安全问题）。
      const localPath = api.getPathForFile(file);
      if (!localPath) {
        setError('拿不到这个文件的本地路径（可能不是从磁盘选的文件）');
        return;
      }
```
`preload/index.ts:49`：
```ts
  getPathForFile: (file) => webUtils.getPathForFile(file),
```
Electron 34.5.8（`package.json:42`）支持 `webUtils.getPathForFile`（Electron 32+），这是官方推荐的 contextBridge 代理写法。

下载侧 `main/index.ts:148-159`：
```ts
handle(IPC.filesPull, (connectionId, remotePath, localPath) => {
  // **本地落盘位置由宿主定**。
  const target = localPath
    ? String(localPath)
    : defaultDownloadPath(app.getPath('downloads'), String(remotePath));
  return transfer.pull(String(connectionId), String(remotePath), target).then(() => ({ localPath: target }));
});
```
`files/download-target.ts:28-46` 还做了文件名净化（Windows 非法字符、保留设备名、结尾的点与空格、路径穿越）。**这一段写得比我预期的认真。**

---

## 三、R-24 对比度：重算每一个真正在屏幕上出现的组合

`tokens.css` 这一轮把两个 token 调亮了：

```css
  --cockpit-text-faint: #7d879a;      /* tokens.css:26，原 #667080 */
  --cockpit-unavailable: #78828f;      /* tokens.css:40，原 #6e7681 */
```

我把**所有实际渲染出来的前景/背景对**都算了一遍（脚本 `$TEMP\dbc-contrast.mjs`）：

| 前景 | 背景 | 实测 | 判据 | 结论 |
|---|---|---|---|---|
| `--cockpit-text` `#dfe4ec` | `--cockpit-bg` | **14.07:1** | 4.5 | ✅ |
| `--cockpit-text` | `--cockpit-bg-elevated` | **12.80:1** | 4.5 | ✅ |
| `--cockpit-text-dim` | `--cockpit-bg` | **7.12:1** | 4.5 | ✅ |
| `--cockpit-text-dim` | `--cockpit-bg-elevated` | **6.48:1** | 4.5 | ✅ |
| `--cockpit-text-faint` | `--cockpit-bg` | **4.96:1** | 4.5 | ✅ |
| `--cockpit-text-faint` | `--cockpit-bg-elevated` | **4.52:1** | 4.5 | ✅（贴线） |
| `--cockpit-accent` | `--cockpit-bg` / `-elevated` | **7.11 / 6.47:1** | 4.5 | ✅ |
| `--cockpit-ok` / `--cockpit-warn` | `--cockpit-bg` | **11.69 / 9.23:1** | 4.5 | ✅ |
| `--cockpit-danger` | `--cockpit-bg` | **5.36:1** | 4.5 | ✅ |
| `--cockpit-danger` | `.cockpit-error` 底色 `#2f1e21` | **4.72:1** | 4.5 | ✅ |
| `--cockpit-danger` | `--cockpit-bg-elevated` | **4.87:1** | 4.5 | ✅ |
| **`--cockpit-unavailable` `#78828f`** | **`--cockpit-bg-elevated` `#1c2027`** | **4.19:1** | 4.5 | ❌ **不达标** |
| `--cockpit-unavailable` | `--cockpit-bg` | 4.61:1 | 4.5 | ✅（贴线） |
| `--cockpit-text-faint`（文件图标方块） | `--cockpit-bg-elevated` | 4.52:1 | 3:1 | ✅ |
| `--cockpit-accent`（目录图标方块） | `--cockpit-bg-elevated` | 6.47:1 | 3:1 | ✅ |
| `--cockpit-border` | `--cockpit-bg` / `-elevated` | 1.37 / 1.25:1 | 3:1 | ⚠️ 见 P3-6 |

### 3.1 ❌ 唯一不达标的一对，恰好是新测试漏掉的那一对

```css
/* tokens.css:211-215 */
.cockpit-files {
  border-top: 1px solid var(--cockpit-border);
  padding: 10px 12px;
  background: var(--cockpit-bg-elevated);     /* ← 这里是 elevated */
}

/* tokens.css:225-228 */
.cockpit-files__disabled {
  color: var(--cockpit-unavailable);          /* ← 4.19:1 */
  margin: 0;
}
```

`FileBrowser.tsx:90-98` 正是把这句话渲染在 `.cockpit-files` 里：

```tsx
        <p className="cockpit-files__disabled" data-testid="file-push-disabled">
          这个连接不能传文件（串口没有文件通道）
        </p>
```

→ **「这个连接不能传文件」这句话，用户在真实渲染位置上是 4.19:1，低于 WCAG AA 的 4.5:1。**

**为什么新测试没抓到** —— `tests/unit/contrast.test.ts:50-75` 全程只用一个背景：

```ts
describe('主题 token 的对比度', () => {
  const bg = token('cockpit-bg');            // ← 只有这一个

  it('弱化文字 ≥ 4.5:1 —— 空状态提示是给低视力用户看的', () => {
    expect(contrast(token('cockpit-text-faint'), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('「不可用」语义色 ≥ 4.5:1 —— 它承载的是「这块板不提供这个能力」', () => {
    expect(contrast(token('cockpit-unavailable'), bg)).toBeGreaterThanOrEqual(4.5);
  });
```

**这个测试测的是「token 对 token」，不是「token 对它真正渲染的那块背景」。**
`--cockpit-unavailable` 对 `--cockpit-bg` 是 4.61 ✅，对 `--cockpit-bg-elevated` 是 4.19 ❌——
测试只验了前者，于是**恰好放过了唯一不达标的那一处**。
`.cockpit-text-faint` 同理：4.52 vs 4.96，都贴线，但都过。

**修法（一行）**：`--cockpit-unavailable` 提到 `#828d9b` 左右即可让 elevated 底下过 4.5；
**更稳的修法**是让测试**按「谁渲染在谁上面」枚举组合**，而不是只测一个 bg。

> **顺带**：`--cockpit-text-faint` 在 elevated 上只有 **4.52:1**，离 4.5 只差 0.02。
> 换任何一个背景或浏览器取色误差都可能翻车。**建议一起提到 4.8 以上**，别卡在及格线上。

---

## 四、专题：commit `7d44367`「管道模式画提示符」

> `7d44367 fix: 管道模式画提示符、终端拿焦点，及一批 P2 —— 外加变异脚本自己的坑`

### 4.1 谁画的、画在哪、画几次

| 环节 | 位置 | 行为 |
|---|---|---|
| **第一条提示符** | `terminal/manager.ts:151-154` | 会话开起来时，`if (!pty && prompt.length > 0)` → `for (const cb of this.dataCbs) cb(id, prompt);` |
| **每行之后的提示符** | `terminal/line-editor.ts:386-392` | 收到 `\r`/`\n` 时 `echo += '\r\n' + this.prompt;` |
| **提示符来源** | `terminal/manager.ts:144` | `profile.options['prompt']`，即 `profiles/targets/board-adb.json` 的 `"root@ATK-DLRK3588"` |

- **画一次还是每个 chunk 一次？** → **开一次 + 每提交一行一次**。不是每 chunk。✅
- **会不会和板子自己的提示符重复？** → 不会。pipe 模式（`adb shell` 无 PTY）远端**根本不打印 PS1**；
  而 `pty: true` 的串口/SSH/本机**根本不画**（`manager.ts:152` 的 `!pty` 闸门 + `manager.ts:161-166` 走「只转发」分支）。✅
- **会不会污染会话日志？** → **不会**。两条路径都**绕开了 `log.write`**：
  - `manager.ts:153` 直接 `this.dataCbs`（`log.write` 只在 `manager.ts:133` 的 `session.onData` 里）；
  - `manager.ts:174` 也是直接 `this.dataCbs`。

  日志里只有：**提交的命令**（`AdbSession.write` → `this.record(data)`）与**远端输出**。
  → **提示符不在日志里**。✅（副作用：日志与屏幕不再完全同构，但这是可接受的取舍。）

### 4.2 ❌ 但它**画早了** —— 这是本轮最实在的一条新缺陷

用**真实的 `TerminalManager` + 真实的 `PipeInput`** 跑一遍（`$TEMP\dbc-prompt.mts`，假会话在 5 ms 后回一段输出，模拟 adb 的往返）：

```
=== 到达 renderer 的 chunk 序列（按时间顺序）===
0: "root@ATK-DLRK3588"
1: "\u001b[Kls"
2: "\r\nroot@ATK-DLRK3588"     ← 提示符在远端输出之前就到了
3: "file1\nfile2\n"           ← 命令输出

=== 用户看到的屏幕 ===
root@ATK-DLRK3588ls
root@ATK-DLRK3588file1
file2
```

**用户看到的是：命令输出接在「下一个提示符」后面**，像是在提示符处被敲进去的。

根因在 `terminal/manager.ts:168-175`：

```ts
    // pipe 模式：远端没有行规程——宿主做行编辑并回显。
    const edit = live.editor.input(data);
    if (edit.toRemote.length > 0) live.session.write(edit.toRemote);
    if (edit.echo.length > 0) {
      for (const cb of this.dataCbs) cb(sessionId, edit.echo);   // ← 立刻广播，含下一个提示符
    }
```

回显（含新提示符）在**命令发出去的同时**就广播了，而远端输出要走一次真实往返才回来。
`line-editor.ts:389` 画提示符时**并不知道远端还有输出要回来**。

**为什么前身工程没这个问题** —— `docs/legacy/旧工程架构说明-PySide6.md:129`：

> A pipe -- ``adb shell`` without a PTY -- gives none of that, so the console
> provides it: **an input line under the terminal**, with the prompt, a caret, the
> usual editing keys and a command history.

前身把提示符放在**终端输出区下面的独立输入行**里，两者物理分开，所以交错不了。
这一轮把提示符**画进了输出流**，于是交错了。

**修法方向**（择一）：
1. **延迟画**：提示符不随回车立刻画，而是「远端输出静默 150 ms 后」或「用户下一次按键时」再画；
2. **回退到前身形态**：提示符放独立的输入行 widget，不混进输出流；
3. 至少：画下一个提示符前，**等远端这一条命令的输出到齐**（串口有 marker，ADB 没有——这是难点）。

**测试覆盖**：`tests/unit/line-editor.test.ts:171-180` 只断言「`r.echo` 里含提示符」，
**不关心提示符与远端输出的先后** → 这条缺陷逃过了测试。
需要一条**顺序**断言：

```ts
it('提示符画在远端输出之后', () => { /* 断言 chunk 序列 */ });
```

---

## 五、仍然存在 / 本轮新发现的问题

> 每条都给了：文件 + 行号 + 原文 + 用户可见症状 + 严重度 + 测试覆盖。

### P1-1 ❌ 标签页的关闭按钮仍然不能键盘操作（R-15 未修）

**位置**：`src/renderer/App.tsx:244-265`

```tsx
      <nav className="cockpit-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.sessionId}
            type="button"
            className={tab.sessionId === active ? 'is-active' : undefined}
            onClick={() => setActive(tab.sessionId)}
          >
            {tab.profileId}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.sessionId);
              }}
            >
              ×
            </span>
          </button>
        ))}
      </nav>
```

**与上一轮逐字相同**：`role="button"` 嵌在 `<button>` 里（无效 HTML），
**没有 `onKeyDown`**（Enter/Space 无默认激活行为）、**没有 `aria-label`**。

**实测**（scratch vitest，`render(<App/>)` → 开标签 → 对 `×` 发 Enter/Space）：

```
CLOSE_TAG=SPAN role=button tabIndex=0 ariaLabel=null
PARENT=BUTTON parentRole=null
AFTER_KEYS stillTerminal=true
BUTTONS_BEFORE=6 AFTER=6
```

→ **纯键盘 / 读屏用户依然关不掉标签。**

**测试覆盖**：无。`tests/web/` 里没有任何关于标签关闭按钮的用例。

---

### P1-2 🆕 pipe 模式提示符画在输出之前 → 屏幕顺序错乱

见 §四。**P1**。测试覆盖：只有「含提示符」的断言，无顺序断言。

---

### P1-3 🆕 上传的远端目标恒为 `/` → SSH 与本机传输必挂

**位置**：`src/renderer/files/FileBrowser.tsx:100-103`

```tsx
  const push = (): void => {
    if (!selectedLocal) return;
    onPush(selectedLocal, remotePath);      // ← remotePath 永远是 '/'
  };
```

`remotePath` 的唯一来源是 `FileBrowser.tsx:53` 的默认值 `remotePath = '/'`，
而 `App.tsx:285-293` **从来不传这个 prop**：

```tsx
              <FileBrowser
                connectionId={current.sessionId}
                capabilities={currentInfo.capabilities}
                onPush={(file, remoteDir) => onPush(current.sessionId, file, remoteDir)}
                onPull={onPull}
                listRemote={...}
              />
```

→ 上传目标恒为 `/`。而 `/` 不是一个合法的**文件**目标：

| 传输 | 实现 | 结果 |
|---|---|---|
| **SSH** | `hal/ssh.ts:273-292` `sftp.fastPut(localPath, remotePath)` | **`remotePath` 必须是文件的完整路径** → 写 `/` 失败。**必挂** |
| **本机** | `hal/local.ts:128-135` `copyFile(localPath, remotePath)` | Windows 上 `'/'` 不是有效路径 → `ENOENT`/`EISDIR`。**必挂** |
| **ADB** | `hal/adb.ts:209-216` `adb push <local> /` | adb 把目录当目标时会把 basename 拼上去 → 落在远端 `/<name>`。能通，但用户**无法选择目录** |

**用户可见**：选好文件 → 点「↑」 → 弹「上传失败：C:\Users\me\build.log」。
SSH 与本机这两条线**上传功能整体不可用**。

**测试覆盖**：`tests/web/file-browser.test.tsx:88-109` 断言的正是这个坏行为：
```tsx
    expect(remoteDir).toBe('/');
```
——**测试把 bug 锁住了。**

**修法**：远端树能进目录（见 P2-2），上传目标 = **当前远端目录 + 文件名**，
即 `onPush(file, `${remotePath}/${file.name}`)`；本机传输另议（它的「远端」是宿主文件系统）。

---

### P2-1 🆕 切标签会把后台标签的终端 resize 成极小尺寸，并把这个尺寸报给远端

**位置**：`src/renderer/terminal/TerminalView.tsx:92-96`

```tsx
    const observer = new ResizeObserver(() => {
      fit.fit();
      report();
    });
    observer.observe(host);
```

**机制（可从代码确定的部分）**：

1. `App.tsx:216-217` 给面板加了 `hidden` → `tokens.css:199-201` `.cockpit-tabpanel[hidden] { display: none; }`
   → **面板一隐藏，它的 host 就是 `display:none`，内容盒变成 0×0**；
2. `display:none` 会让 **ResizeObserver 立刻回调一次**（内容盒 0×0）；
3. 回调里 **`fit.fit()` 与 `report()` 都没有「现在可见吗」的判断**；
4. `addon-fit@0.10.0` 的 `proposeDimensions()` 用
   `parseInt(getComputedStyle(parentElement).height/width)` —— 对 `display:none` 的子树，
   Chromium 给的是 **0px**（或 `'auto'`）；两种情况下算出来的行列都**不是真实尺寸**：
   - 若为 `0px` → `rows = Math.max(1, …) = 1`、`cols = Math.max(2, …) = 2` → **`resize(2, 1)`**；
   - 若为 `'auto'` → `parseInt('auto') = NaN` → `fit()` 提前返回，尺寸不变但 `report()` 仍会跑。
5. `report()` 把 `term.cols/term.rows` **报给远端**：
   ```tsx
     const report = (): void => {
       onResizeRef.current?.(term.cols, term.rows);
     };
   ```
   → `App.tsx:223-225` → `api.terminalResize(sessionId, cols, rows)` → `main` → `terminal.resize` →
   - SSH：`hal/ssh.ts:407-408` `this.channel.setWindow(rows, cols, 0, 0)` → **远端 pty 变成 2×1**，
     远端 shell 收到 SIGWINCH，**按 2 列重新折行**；
   - 本机 pty：`terminal/pty.ts:85-87` `this.proc.resize(cols, rows)` → **本机 powershell 变成 2×1**；
   - ADB pipe / 串口：no-op。

**用户可见**：**每切一次标签，后台那条会话的远端终端就被改成 2 列 × 1 行**。
SSH 上切走再切回来，远端的输出已经按 2 列折过一遍，屏幕上是一堆碎字；
本机终端的提示符会被重新绘制成极窄的一条。
切回来时再 resize 回 80×24 —— **远端已经折过的行不会还原**。

**修法**（一行级别）：
```tsx
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;  // 隐藏时不 fit、不报
      fit.fit();
      report();
    });
```
或者用 `host.offsetParent === null` 判断可见性。

**测试覆盖**：无。happy-dom 无布局，测不出来；**需要真浏览器或真机**。

> **确定度说明**：第 1–5 步（回调触发、无可见性判断、把尺寸报给远端）是**代码层面确定**的；
> 「隐藏时具体算成几列几行」取决于 Chromium 对 `display:none` 元素的 `getComputedStyle` 返回值，
> 本机没有 Electron 二进制，**我没能实测这个数**（见 §一环境备注）。
> 但**无论是 2×1 还是别的值，都不是真实尺寸**，结论不变。

---

### P2-2 ❌ 远端树仍然进不去目录；本地侧仍然不是树（R-19 未修）

**`FileBrowser.tsx` 在 `75b6ac1..f8315cf` 的 diff 里根本不存在 —— 这个文件一行都没改。**

**远端侧**：`FileBrowser.tsx:174-186`
```tsx
            {remote.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={selectedRemote?.path === entry.path ? 'is-selected' : undefined}
                  onClick={() => setSelectedRemote(entry)}        // ← 只选中，不进入
                >
```
点目录**只是选中**。`remotePath` 这个 prop 的唯一来源是 `FileBrowser.tsx:53` 的默认值 `'/'`，
`App.tsx` 从不传它 → **远端侧永远只能看到根目录**。

**实测**（scratch vitest）：点目录、再双击目录之后——
```
listRemote calls after click+dblclick dir = [["c1","/"]]
```
→ **一次都没有用子目录路径去问宿主。**

**本地侧**：`FileBrowser.tsx:116-129`
```tsx
          <label className="cockpit-files__label" onDragOver={...} onDrop={handleDrop} data-testid="file-drop">
            选文件（可拖进来）
            <input ref={inputRef} type="file" data-testid="file-input" onChange={handleChange} />
          </label>
```
实测属性：`multiple=false`、`webkitdirectory=undefined`
→ **不能选目录、不能多选、只有一个 `<input type="file">`。**

**用户可见**：所谓「双树浏览」目前是「一个文件选择框 + 一个固定根目录的列表」。
**M2 的判据「双树浏览」仍然不成立。**

**测试覆盖**：`tests/web/file-browser.test.tsx` 的 6 条用例**全部绕开了导航**，
且第 108 行 `expect(remoteDir).toBe('/')` **把「永远传到根」锁成了预期**。

---

### P2-3 🆕 目录也能点「↓ 下载」→ 行为不可预期

`FileBrowser.tsx:148-154` 的下载按钮只看「有没有选中」，不看选中的是不是目录：
```tsx
          <button
            type="button"
            data-testid="pull-button"
            onClick={pull}
            disabled={!selectedRemote}      // ← 目录也允许
            title="从远端下载"
          >
```
`pull()` → `onPull(connectionId, selectedRemote.path)` → 宿主 `defaultDownloadPath` 取 `basename` →
- SSH：`hal/ssh.ts:252-270` `sftp.fastGet(目录, 目标)` → 报错「不是普通文件」；
- 本机：`hal/local.ts:117-126` `copyFile(目录, 目标)` → `EISDIR`；
- ADB：`adb pull 目录 目标` → 递归拉下来，落点还套一层，路径很怪。

**用户可见**：在远端树里点中一个目录 → 按 ↓ → 弹「下载失败：/root/sub」，或者落盘成一个看不懂的目录。

**修法**：目录时禁用 ↓（`disabled={!selectedRemote || selectedRemote.isDirectory}`），
或者对目录改成「进入」而不是「选中」。

---

### P2-4 🆕 R-03 的**根因那一段**仍然没有测试

`shared/errors.ts:75-88` 的 `toAppErrorPayload`（主进程把异常拍平成可跨 IPC 的载荷）
**全仓零测试**：

```
$ grep -rn "toAppErrorPayload" tests/
（空）
```

**这意味着 R-03 可以悄悄回归**：如果有人把 `main/index.ts:89-97` 的 `handle()`
改回「直接抛」，`preload.test.ts` **照样绿**（它 mock 了 `ipcRenderer.invoke` 的返回值），
`app-error.test.tsx` **也照样绿**（它 mock 了 preload 层的抛出）。
**两处测试都跳过了真正出问题的那一段。**

**修法**：给 `shared/errors.ts` 补一条单测（这是纯函数，最容易测）：
```ts
expect(toAppErrorPayload(makeError('PORT_BUSY','串口 COM3 被占用'))).toEqual({
  code:'PORT_BUSY', message:'串口 COM3 被占用', retryable:false });
expect(toAppErrorPayload(new Error('boom')).message).toBe('boom');
expect(appErrorToException(toAppErrorPayload(e)).message).toBe(e.message);
```
再补一条**从 main 的 `handle` 出发**的集成测试（`handle` 目前是模块内私有函数，需要导出或抽到 `shared/`）。

---

### P2-5 ❌ `--cockpit-unavailable` 在真实渲染位置上仍不达标（R-24 半修）

见 §三。**4.19:1 < 4.5:1**，位置 `tokens.css:225-228` + `tokens.css:214`。
新加的 `tests/unit/contrast.test.ts` **只测 `--cockpit-bg`** → 漏掉了这一处。
**测试覆盖：有测试，但测错了背景。**

---

### P2-6 ❌ 没有 focus-visible 样式

`tokens.css` 里 `focus` / `outline` / `prefers-reduced-motion` **零命中**
（`grep -n "focus\|outline\|prefers-reduced-motion" src/renderer/theme/tokens.css` → 0 行）。

键盘用户只能靠浏览器默认焦点环——而它没被主题化，和 `--cockpit-*` 这套色板不搭。
`docs/04 §6.5` 把 `--cockpit-*` 定成**卡片唯一能用的颜色契约**，
卡片是 sandbox iframe，**用不了宿主的 UA 默认样式** → 这个缺口现在补最便宜。

**修法**：加 `--cockpit-focus: var(--cockpit-accent);` + 一条
`:focus-visible { outline: 2px solid var(--cockpit-focus); outline-offset: 2px; }`。

**测试覆盖**：无。

---

### P2-7 ❌ 标签条对辅助技术完全不可读

实测（scratch vitest）：
```
TABS role=tablist? false
TABS role=tab? false
aria-selected count=0
aria-current count=0
activeBtn aria-current=null
```

`App.tsx:244-265` 的 `<nav className="cockpit-tabs">` 里是一排普通 `<button>`，
活动状态**只靠 CSS class `is-active`**（`tokens.css:134-138`，即颜色 + 边框）。

**用户可见**：读屏用户听到的是一串无差别的按钮，**不知道自己在看哪个会话**。
最小修法是给活动标签加 `aria-current="true"`（一行）。

**测试覆盖**：无。

---

### P2-8 ❌ renderer 外壳仍然没有 CSP

`src/renderer/index.html`（全文 12 行）**没有 `<meta http-equiv="Content-Security-Policy">`**，
`src/main/index.ts:161-195` 的 `createWindow()` **也没有设 CSP 头**
（`webPreferences` 只有 `preload / contextIsolation / nodeIntegration / sandbox`）。

`docs/04 §6.2` 把 CSP 立成**卡片沙箱的执行机制**（ADR-D16），
现在**主壳自己也没有** —— 任何渲染侧注入都能直接摸到完整的 preload API
（对任意 session `terminalWrite`、对任意连接 `filesPush`）。

这一轮在**卡片运行时（M5）之前**不算事故，但**越晚补越贵**：卡片 iframe 一进来就要靠 CSP 断网，
到时候外壳和卡片两套 CSP 规则叠在一起，很容易写出互相打架的策略。

**测试覆盖**：无。

---

### P2-9 ❌ 拖放仍然只在那个小 label 上，且落点不对（RF-4 未达成）

`FileBrowser.tsx:116-129` 的 `onDrop` 只挂在 `<label>` 上。
**把文件拖到窗口别处**（终端上、工具栏上）→ `main/index.ts:188-191` 的 `will-navigate` 拦住了导航
（窗口不会崩），**但用户什么反馈都没有**。

计划 `docs/superpowers/plans/2026-11-12-plan1-…md:59` 写的是：

> | **RF-4** | **用户把文件拖进窗口 / 粘贴一段多行文本** | 有明确反馈（拒绝或接受并提示），不静默忽略 | Task 9 |

另外计划 `:1557` 写的验收证据是 `expect(onPush).toHaveBeenCalled()` ——
但**现在 `handleDrop` 只 `setSelectedLocal`，不调用 `onPush`**（`FileBrowser.tsx:81-88`），
**这条验收证据已经与实现对不上**，而对应的测试用例也不存在（`tests/web/` 里 `drop|dragOver` 零命中）。

**用户可见**：拖进来 → 什么也没发生（除了下面那个文件名），也不知道成没成功。

**测试覆盖**：无。

---

### P2-10 ❌ `connectionsList` 仍然只在 mount 时拉一次（R-25 未修）

`App.tsx:48-53`
```tsx
  useEffect(() => {
    apiRef.current = window.cockpit ?? null;
    if (!apiRef.current) return;

    // 连接与能力位都问宿主要——UI 不该自己猜哪个传输能干什么
    void apiRef.current.connectionsList().then(setConnections);
```

**没有刷新按钮、没有文件监听、没有重新拉取的时机。**
用户改了 `profiles/targets/*.json`（加一块板、换端口）→ 界面不变 → **必须重启应用**。
`main/profiles/loader.ts` 已经支持内置目录 + 用户目录合并，能力是有的，**renderer 只是不再问**。

**用户可见**：加了新板子，工具栏里没有 —— 用户以为没生效。

**顺带**：这一行**也没有 `.catch`**（见 P3-1）。

**测试覆盖**：无。

---

### P2-11 🆕 窗口变矮时终端会被压到 0 高

`tokens.css:140-145` / `186-190` / `211-215`：
```css
.cockpit-main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cockpit-terminals { flex: 1; min-height: 0; position: relative; }
.cockpit-files { border-top: 1px solid var(--cockpit-border); padding: 10px 12px; background: var(--cockpit-bg-elevated); }
```

`.cockpit-files` **没有 `flex-shrink: 0`**，而 `.cockpit-terminals` 的 `flex-basis` 是 0。
窗口一矮 → 主区高度 < 文件面板的自然高度（约 280px：两棵树 + 220px 的列表上限）
→ flex 收缩**全部落在文件面板身上** → **终端拿到 0 高度**。

**用户可见**：把窗口拖矮 → 终端消失，只剩文件面板。

**修法**：`.cockpit-files { flex-shrink: 0; }` + `.cockpit-terminals { min-height: 120px; }`。

**测试覆盖**：无（happy-dom 无布局）。

---

### P2-12 🆕 下载同名文件静默覆盖

`files/download-target.ts:44-46`
```ts
export function defaultDownloadPath(downloadsDir: string, remotePath: string): string {
  return join(downloadsDir, sanitizeFileName(basename(remotePath)));
}
```

**没有冲突处理**：连点两次「↓」下载同一个 `/root/a.txt` → 第二次**直接覆盖** `Downloads\a.txt`；
如果用户 `Downloads` 里本来就有这个文件，**也会被无声覆盖**。

**用户可见**：第一次下载的版本没了，界面上还提示「已保存到 …\a.txt」，看不出被覆盖了。

**修法**：落盘前 `fs.existsSync` 检查，撞名就加 `(1)`、`(2)` 后缀（与浏览器下载行为一致）。

**测试覆盖**：`files/download-target.ts` **整份文件零测试**（`grep -rn "download-target\|defaultDownloadPath\|sanitizeFileName" tests/` → 空）。

---

### P3-1 · `connectionsList()` 没有 `.catch`

`App.tsx:53`：`void apiRef.current.connectionsList().then(setConnections);`
→ 万一失败就是 unhandled rejection，而且**工具栏会静悄悄地空着**，
用户看到的是「一个连接都没有」，而不是「连接列表加载失败」。

**测试覆盖**：无。

### P3-2 · 关掉标签后状态栏永远写着「会话已结束」

`App.tsx:67-77` 的 `onTerminalExit` 回调**不分「用户主动关」与「远端自己退出」**：
```tsx
      setStatus(
        exitCode === null ? '会话已结束' : `会话已结束（退出码 ${exitCode}）`,
      );
```
而 `closeTab`（`App.tsx:145-158`）主动关标签 → 宿主也会发 `terminal:exit` → 状态栏被写成「会话已结束」。

**用户可见**：手动关一个标签，界面告诉你「会话已结束」——像是出了什么事故。

**测试覆盖**：无。

### P3-3 · 切回标签不会把焦点还给终端

`TerminalView.tsx:78-82` 的 `term.focus()` **只在挂载时调一次**。
切到别的标签再切回来 → 焦点还留在原来那个位置（比如工具栏按钮上），
**用户直接打字又进不去终端**，而且因为焦点在 button 上，**回车会再开一个标签**——
这正是 R-16 的原始症状，在「切标签」这条路径上又活过来了。

**修法**：活动标签变化时 `useEffect(() => { if (isActive) term.focus(); }, [isActive])`。

**测试覆盖**：无。

### P3-4 · `subscribeRef` / `pendingRef` 永不清理

`App.tsx:46` 的 `pendingRef` 与 `App.tsx:117` 的 `subscribeRef`
按 sessionId 累积，**标签关掉后条目不删**。关掉的会话若还有残留输出，
会一直堆在 `pendingRef` 里（没人认领，也没人清）。

**测试覆盖**：无。

### P3-5 · 死代码与重复定义

| 位置 | 问题 |
|---|---|
| `tokens.css:230-233` | `.cockpit-files__pending` —— **`.tsx` 里零引用**（grep 空） |
| `FileBrowser.tsx:60,124` | `inputRef` —— 赋了 `ref` 但**从未读取** |
| `FileBrowser.tsx:26-32` | `RemoteEntry` 与 `shared/ipc-contract.ts:99-105` 的 `FileEntry` **同形重复** |
| `FileBrowser.tsx:44` | `remotePath` prop —— `App.tsx` **从不传**，生产环境恒为默认值 `'/'` |
| `App.tsx:222,225` | `onWrite` / `onResize` 每渲染造新闭包（`TerminalView` 用 ref 兜住了，**不算 bug**，但每次渲染都变） |

### P3-6 · `--cockpit-border` 对比度 1.25–1.37:1

`--cockpit-border: #2b313a` 对两个背景都只有 ~1.3:1，低于 WCAG 1.4.11 的 3:1。
严格说，只有当**边框是识别组件的唯一手段**时才必须达到 3:1；
这里按钮/树都有文字标签兜底，所以**不构成违规**，但树框与分隔线在暗色底上**几乎看不见**。
**建议**把 `--cockpit-border` 提到 `#3b4350` 上下（能过 3:1 的 UI 组件门槛）。

---

## 六、复核建议（按性价比排序）

1. **P1-2（提示符画早）** —— 这是本轮最伤的一条：**ADB 终端的每一次输出都排在提示符后面**。
   建议改回前身那种「提示符在独立输入行」的形态，或做延迟绘制。
   顺手补一条**顺序**断言的测试。
2. **P1-3 + P2-2 + P2-3（远端目标恒为 `/`）** —— 一并解决：
   远端树能进目录 → 上传目标 = 当前目录 + 文件名 → 下载按钮对目录禁用。
   这三条其实是**同一个功能没做完**。
3. **P2-5（对比度）** —— `--cockpit-unavailable` 提亮；**并把 `contrast.test.ts` 改成按
   「谁渲染在谁上面」枚举组合**，否则下一次改色还会漏。
4. **P2-4（`toAppErrorPayload` 无测试）** —— R-03 的根因现在没有守门人。
5. **P1-1（关闭按钮）** —— 改成并排两个 `<button>`，或补 `onKeyDown` + `aria-label`。
6. **P2-6 / P2-7 / P2-8（focus-visible / aria-current / CSP）** —— 越晚补越贵：
   `--cockpit-*` 是**卡片唯一能用的颜色契约**，卡片又是 sandbox iframe，
   这些缺口现在补是一行，将来每个卡片都要自己发明一遍。
7. **P2-1（隐藏面板 resize）** —— 加一行可见性判断。

---

## 七、本轮「不是缺陷」的确认项（以示核查完整）

- **R-01（管道模式回车不执行）** —— 已由 `terminal/line-editor.ts` 修掉，本轮**没有回归**：
  `manager.ts:171` 把回车译成 `\n` 发给远端，`line-editor.ts:386` `toRemote += ${commit}\n`。✅
- **R-33（`quotePath` 不挡换行）** —— `util/shell-quote.ts:17-24` 已挡。✅
- **R-32（spawn 失败抛原生 Error）** —— `toAppErrorPayload` 会把原生 Error 归成 `INTERNAL` 且**保住 message**。✅
- **`windowsHide: true`** —— 仍在。✅
- **`--cockpit-text` / `--cockpit-text-dim` / `--cockpit-ok` / `--cockpit-warn` / `--cockpit-danger`** —— 全部达标。✅
- **提示符不污染会话日志** —— 两条路径都绕开 `log.write`，实测确认。✅
- **提示符不与板子自己的提示符重复** —— pipe 模式远端不打印 PS1；pty 模式宿主不画。✅
- **`connections` 按 sessionId 建索引** —— `main/index.ts:51,62-63`，`App.tsx:286` 传的也是 `current.sessionId`，**两端一致**。✅

---

*本报告只做评审，未改动 `src/` 与 `tests/` 任何文件；
scratch 文件写在 `$TEMP` 与一个临时目录 `.scratch-review/`（跑完已删除，`git status` 干净）。*
