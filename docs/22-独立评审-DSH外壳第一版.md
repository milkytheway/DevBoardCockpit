# 独立评审 · DSH 外壳第一版

> **日期**：2026-11-14
> **作者**：Codex
> **被审对象**：`feat/plan2-tag-runtime` 分支 `c681e15..009aebb`（DSH 的外壳第一版）
> **依据**：`docs/UI设计/05-外壳施工图.md`（边界 / 授权 / 判据）
> **性质**：独立评审。**不改代码、不改契约。**

---

## 〇、结论

**可以往下走。**

边界守住了、判据落成了测试、基线的欠账补齐了。**没有阻塞项。**
四条待处理都不影响下一步开工，但其中两条应该在继续之前顺手做掉（见 §三）。

| 维度 | 结果 |
|---|---|
| **边界遵守** | ✅ 极干净 —— `preload` / `broker` / `ipc-contract` / `docs/spec` **一个字节没动** |
| **判据落地** | ✅ 施工图 §8.2 三条视觉判据**逐条落成了测试** |
| **基线修复** | ✅ 6 条红测试 → 0；3 条空守卫重对准；变异不再弄脏工作树；内置卡提交 |
| **架构质量** | ✅ 七态、布局 v2 形状、壳/功能的切分都对 |
| **待处理** | ⚠️ 4 条：旧壳退场差一步、M61 守卫仍空、一处轻微越界、一处判据缺口 |

---

## 一、我怎么验的

| 命令 / 动作 | 结果 |
|---|---|
| `npm run lint` / `typecheck` | ✅ |
| `npm test` | ✅ **751 通过 / 74 文件 / 0 失败**（上轮 711，6 条红已修） |
| `npm run mutation:check` | ✅ **63 守住 / 1 失效**（上轮 58 守住 / 4 失效） |
| `npm run gen:theme:check` | ✅ 主题 CSS 与种子一致 |
| `npm run validate:profiles` | ✅ 0 错 0 警 |
| `npm run test:cards` | ✅ **10 条 e2e 全绿**（上轮 9 条，新增「拖动后位置被记住」） |
| 逐文件读新壳 | 24 个新文件 + `shared/layout.ts` v2 + `main/cards/layout.ts` |
| 边界自查 | `git diff --name-status` 逐条核对 |

---

## 二、做得好的（逐条带证据）

### 2.1 边界遵守得极干净

```
动过 src/preload        ：无
动过 renderer/cards/broker.ts：无
动过 src/shared/ipc-contract.ts：无
动过 docs/spec          ：无
动过 src/shared/theme/seed.ts：1 个色值（设计权在 DSH，允许，且 gen:theme:check 绿）
动过 src/main（除 cards/layout.ts）：src/main/cards/wiring.ts
动过 src/shared/layout.ts：形状升 v2（授权范围）
```

**唯一需要商榷的是 `main/cards/wiring.ts`**（见 §三.3）。

### 2.2 施工图 §8.2 的三条视觉判据**逐条落成了测试**

`tests/web/shell-consistency.test.ts`：

| 施工图要求 | 实现 |
|---|---|
| §8.2 第 9 条：正文与语义色 ≥ 4.5:1 | ✅「正文与语义色对面板底 ≥ 4.5:1」，两套皮肤都测 |
| §8.2 第 10 条：控件边框 ≥ 3:1 | ✅「卡片内可聚焦控件的边框对卡面 ≥ 3:1」 |
| §8.2 第 11 条：四处颜色一致 | ✅「xterm 的背景/正文/强调/语义色直接取自别名层」+「两套皮肤的终端主题不一样」 |

### 2.3 我点名的边框不达标，**改了**

`seed.ts`：`border-strong` `#5F6C7A` → `#65727F`

| 底色 | 旧值 | 新值 |
|---|---|---|
| 卡内控件 `#1E242C` | **2.91:1** ❌ | **3.17:1** ✅ |
| 卡片面 `#151A20` | 3.26 | 3.55 |
| 画布 `#0A0C0F` | 3.65 | 3.98 |

（我自己复算过。）

### 2.4 七态做对了 —— 形状 + 文字 + 颜色三重编码

`format.ts` 的 `readingMeta` 逐态：

| 状态 | 形状 | 文字 | 显示值 |
|---|---|---|---|
| ok | `●` | 实时 | ✅ |
| stale | `◐` | 已过时 | ✅ **保留旧值** |
| pending | `◌` | 等待首个采样 | ❌ 不显示 ✅ |
| unavailable | `⊘` | 不可用 | ❌ **绝不显示值** ✅ |
| error | `✕` | 读取失败 | 仅当有旧值 ✅ |

`tests/web/shell-format.test.ts` **逐态断言**，其中一条叫
「没有『可用的颜色但不可读的值』：每个状态要么 showValue=true 有值，否则值不渲染」
—— 这正是契约 `unavailable ≠ 0` 的 UI 侧兑现，**而且被钉死了**。

### 2.5 布局 v2 的形状做得很扎实

- **v1 兼容**：旧文件 `{units, updatedAt}` 由 `normalizeLayout` 落到「总览」视图，**读得出来**
- **收形状不抛**：`normalizeLayout` 对任何坏字段都回默认，不影响其它视图
- **用户能碰的文件 → 收形状**：字符串数组去空、去重、封顶（`hidden` 500 / `tagFilter` 64）
- **两端同步**：`LayoutStore.get()` 已改成走 `normalizeLayout`，`layoutSet` 里 `shared/layout.ts` 与 `main/cards/layout.ts` **同一次提交**改的 ✅（符合施工图 §四.3 的规矩）
- **`units` 兼容字段**与 `views[activeViewId]` 镜像同步

我逐行看过 `layoutSet` 的合并逻辑（`kept` + `next` 不重不漏、卸载的卡位置保留、显式空 config 能清空）—— **没有找到缺陷**。

### 2.6 「壳不要、功能要留」做对了

`Dock.tsx` **复用了** `TerminalView` 与 `FileBrowser` —— 终端与文件互传这两块真能力没被删掉，
只是被收进了 dock。这正是施工图 §七.1 要求的。

### 2.7 基线的欠账补齐了

| 上轮的缺口 | 现在 |
|---|---|
| 6 条红测试 | ✅ 0（3 条夹具改成真路径、3 条软链改用 **junction**，Windows 上也能守住 M49） |
| M40/M42/M48 空守卫 | ✅ 重对准代码，现在都守住了 |
| `mutation:check` 弄脏工作树 | ✅ 跑完工作树干净 |
| 内置卡在 `fixtures/`（HEAD 是坏的） | ✅ 已提交到 `cards/cpu-usage/` |
| playwright 是空壳 | ✅ 已装（`npm run test:cards` 能跑） |

### 2.8 e2e 改成「不认 class 名」—— 这是好工程做法

`c681e15` 把 e2e 从「认 CSS 类名」改成「认语义」。
**这让外壳可以自由重画而不破测试**，也正是施工图 §一.2 说的「退场要一次做完」的技术前提。

---

## 三、四条待处理

### 3.1 旧壳退场差最后一步（新壳已上线，旧壳的残骸还在）

| 残骸 | 状态 |
|---|---|
| `src/renderer/App.tsx`（306 行） | **不再挂载**（`main.tsx` 只渲染 `<Shell />`），但**被 `tests/web/app-error.test.tsx` import** |
| `src/renderer/theme/app.css`（417 行） | ⚠️ **`main.tsx` 还在 import** —— 与新的 `shell.css`（1853 行）**同时加载** |
| `src/renderer/tags/ReadingsPanel.tsx` + 它的测试 | 死代码（有测试） |
| `app.css` 里的 `.cockpit-toolbar/.cockpit-tabs/.cockpit-main` | 全是死规则 |

**两个具体问题**：

1. **两份 CSS 的全局规则完全重复**：`html,body,#root{height:100%;margin:0}`、
   `body{background/color/font-family/font-size}`、`*{box-sizing}` —— 两边一模一样。
   现在因为 `shell.css` 在后（`main.tsx` 的 import 顺序）而没坏，
   但**顺序一改就翻车**，而且 2270 行 CSS 里有一份是死的。

2. **覆盖回退**：旧壳的错误呈现有 **4 条测试**（`app-error.test.tsx`：打开连接失败 / 文件互传失败 / 上传绝对路径 / 下载提示），
   而**新壳的错误呈现一条测试都没有** —— 我查了，没有任何测试渲染 `Shell.tsx`。
   新壳确实有错误处理（`Shell.tsx` 的 `error` 状态 + `describeError()` + `.shell-error` 样式，
   `format.ts` 的 `runtimeStatusMeta` 还有「连接失败」），**但没有测试守住它**。

**建议**：删 `App.tsx` + `app.css` + `ReadingsPanel.tsx` + `readings-panel.test.tsx`，
把 `app-error.test.tsx` 那 4 条**改到新壳上**（渲染 `Shell` 或把它拆成可测的组件）。

### 3.2 M61 守卫仍然是空的（63 项里唯一的失效）

**根因不是测试没写对**。`watcher.test.ts:76` 那条
「**启动之后才装进来的卡，它的目录也要被监听**」写得是对的 ——
它装卡、等 400ms、再改卡里的 `card.js`，然后断言 `changed` 增加。

**但变异把 `ensureWatching()` 从防抖回调里删掉之后，这条测试照样绿。**
原因是：**在这台 Windows 上，写子目录里的文件也会触发父目录的 `fs.watch`**，
所以「根目录的 watcher 顺带报了」与「给子目录挂了 watcher」**测不出区别**。

**修法**：别断言 `changed` 增加了，**直接断言「`root/c1` 自己也挂了 watcher」** ——
比如 mock `fs.watch`，检查它被以 `root/c1` 为参数调过；或者检查内部 `watchers` map 的键。

### 3.3 一处轻微越界：`src/main/cards/wiring.ts`

按施工图 §三，我把 `main/cards/layout.ts` 划给了 DSH，**`wiring.ts` 是 Claude 的地界**。
DSH 为了实现多视图布局改了 `layoutGet` / `layoutSet` —— **动机合理**（形状升 v2，这两个实现必然要跟着改），
而且 Claude 当时已经把外壳交出去了，**实际不冲突**。

**建议**：把「`wiring.ts` 里与布局相关的部分」明确补进 DSH 的地界，
否则它下次改形状又要停下来问。

### 3.4 一处判据缺口：**视图切换没有端到端判据**

施工图 §8.1 第 8 条是「**换一个视图标签 → 工作区内容变**」。

现状：
- `shell-layout.test.ts` 覆盖了**视图过滤的纯逻辑**（隐藏卡、tagFilter 通配、密度）✅
- 但**没有任何 e2e 证明「点那个标签，工作区真的换了」** ❌

单测证明 `unitsForView` / `viewConfigFor` 算得对，**没证明交互链通**。
（`test:cards` 的 10 条里也没有。）

**建议**：加一条 e2e —— 点第二个视图标签 → 断言工作区内容变了 / 视图的 `activeViewId` 落盘了。

---

## 四、建议的顺序

| # | 事 | 什么时候 |
|---|---|---|
| 1 | **删旧壳残骸 + 把错误呈现的测试改到新壳上**（§三.1） | 继续之前 |
| 2 | **修 M61 守卫**（§三.2） | 继续之前 |
| 3 | 补「视图切换」的 e2e（§三.4） | 随时 |
| 4 | 把 `wiring.ts` 的布局部分补进 DSH 地界（§三.3） | 下一轮开工前 |

**然后**：M5b 继续（布局视图模型、卡片库、检查器的完整形态），再往 M6 走。

---

_本文件由 **Codex** 生成，2026-11-14；用于评审记录，不构成契约或实现产物。_