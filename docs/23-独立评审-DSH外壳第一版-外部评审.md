# 独立评审 · DSH 外壳第一版（外部评审）

> **日期**：2026-11-14
> **评审对象**：`6b40199..009aebb`（DSH 的 5 个提交）
> **评审人**：Claude（core 轨）· **方式**：新上下文评审 + 真机/真测复核
> **与 [DSH 自评（`22-独立评审-DSH外壳第一版.md`）](22-独立评审-DSH外壳第一版.md) 的关系**：
> 两条评审**独立进行**，结论**部分重合**。
> 自评已认的四条（旧壳残骸 / M61 空守卫 / wiring 越界 / 视图切换缺判据）**本文不重复**；
> 本文补的是**自评没有发现**的六条，其中**两条是 Critical**。

---

## 〇、结论

**修完可以合并。**

**四条最硬的线一条没破**（我逐条核过源码，不是看提交信息）：

| 线 | 核法 | 结果 |
|---|---|---|
| **卡片 iframe 的沙箱** | `src/renderer/shell/CardShell.tsx:94` 渲染的是**旧的 `<UserCard>`**（`src/renderer/cards/user-card.tsx:37` 仍是 `sandbox="allow-scripts"`、`:38` 仍是 `src={info.url}`） | ✅ 没破 |
| **卡片私有端口 + 认人两次** | `src/renderer/cards/broker.ts` **零改动**；新壳只换了它在页面上的位置（`Shell.tsx:111` 建 broker、`:164` 监听 message） | ✅ 没破 |
| **权限过滤只在 main** | `src/main/cards/{permissions,tags-service}.ts` 零改动；renderer 里没有任何过滤（`Inspector.tsx:137-151` 明写「权限判定在 main，本页不猜」） | ✅ 没破 |
| **token 三层没被绕过** | `shell.css` 里 **0 个十六进制色值**（grep 过），全部 `var(--cockpit-*)` 经 `color-mix` 派生；`src/renderer/shell/theme.ts` 只**消费**别名 | ✅ 没破 |

**跨进程形状同步也做对了**：`48e5a36` 一次提交同时改 `shared/layout.ts` + `main/cards/layout.ts` + `wiring.ts`（施工图 §4.3 第 2 条 ✓）。
v1 旧文件读得出来 ✓（有单测）；落盘原子 ✓；坏文件不抛 ✓。

**但有两条 Critical**：一条让本轮交付的 `tagFilter` 功能**在常见场景下不可用**，
一条让施工图 §8.2 明确要求「加测试守住」的**视觉判据实际上没被守住**。

---

## 一、Critical

### C1 · 读数过滤输入框会被后台刷新清空 → **这个功能在常见场景下根本用不了**

| 位置 | 代码 |
|---|---|
| `src/renderer/shell/Shell.tsx:243` | `const tagFilter = viewConfig.tagFilter ?? [];` |
| `src/renderer/shell/Toolbar.tsx:42-44` | `useEffect(() => { setFilterText(tagFilter.join(', ')); }, [tagFilter]);` |

**为什么必然发生**：`normalizeViewConfig`（`shared/layout.ts:235-236`）只在 `tagFilter.length > 0` 时才写这个字段
→ **没配过滤时 `tagFilter` 是每次渲染新建的 `[]`** → 引用每帧都变 →
Toolbar 那个 effect 的依赖正是它 → **每来一条读数就重跑一次**，把输入框里的字抹成 `''`。

而 Shell 每来一条读数就重渲染（`Shell.tsx:115` `setReadings` + `:125` `setHistoryVersion`），
采样器是**秒级**轮询 → **用户第一次想输 `cpu.*` 时，打进去的每个字符在几百毫秒内就没了**。

`4eaebf4` 交付的三个视图内容项（hidden / density / **tagFilter**）里，**tagFilter 这一项实际不可用**。

**怎么改**（二选一）：
- (a) `Shell.tsx:243` → `const tagFilter = useMemo(() => viewConfig.tagFilter ?? [], [viewConfig]);`
- (b) Toolbar 的 effect 依赖改成**字符串**：`[tagFilter.join(',')]`

**怎么验证**：加一条 `tests/web` 用例——渲染 `<Toolbar tagFilter={[]} …/>`，
`rerender` 一个**新的** `[]`，在输入框里敲 `cpu`，断言 `input.value === 'cpu'`。现在这条会红。

> **同源附带一条**（自评也没提）：`Toolbar.tsx:122` 的提交只挂在 `onBlur` 与 Enter 上；
> 而 `Toolbar.tsx:49-54` 的「点击外部关闭」会先 `setSettingsOpen(false)` 把输入框**卸载**
> → **已输入的内容不会落盘**。commit 应挪到 `onChange`（防抖）或关闭前先 commit。

### C2 · 对比度测试量的是**不存在的底色** → 施工图 §8.2 的视觉判据**实际上没被守住**

| 位置 | 代码 | 真实值 |
|---|---|---|
| `tests/web/shell-consistency.test.ts:55` | `cardSurface = { dark: '#1E242C', light: '#FFFFFF' }` | `#1E242C` **在整个工程里不存在**（它只是施工图正文里抄来的数） |
| `tests/web/shell-consistency.test.ts:67` | `surface = { dark: '#12151A', … }` | 裸 token，不是卡片实际渐变面 |
| `src/renderer/shell/shell.css:36` | `--shell-card-a: color-mix(in srgb, var(--cockpit-surface) 84%, white 16%)` | = **#383A3F** |
| `src/renderer/shell/shell.css:38` | `--shell-raise: color-mix(in srgb, var(--cockpit-bg-elevated) 88%, white 12%)` | = **#32353B** |

**我实算了一遍（sRGB）**：

| 前景 | 真卡面 #383A3F | 真面板 #32353B | **测试量的 #1E242C** | 判据 |
|---|---|---|---|---|
| `--cockpit-text-faint` #8B95A5 | **3.76:1** ❌ | 4.06:1 ❌ | 5.16:1 ✅ | ≥4.5:1 |
| `--cockpit-danger` #F85149 | **3.40:1** ❌ | 3.67:1 ❌ | 4.66:1 ✅ | ≥4.5:1 |
| `--cockpit-unavailable` #8B95A5 | **3.76:1** ❌ | 4.06:1 ❌ | 5.16:1 ✅ | ≥4.5:1 |

**而这三个失败的色，恰恰就是五态字形自己**（`shell.css:111 .glyph--danger`、`:300 .tone-danger`、`:114 .glyph--unknown`、`:303 .tone-unknown`）。

控件边框（施工图 §8.2 第 10 条 ≥3:1）同样不达标：
`shell.css:195` `.btn { border: 1px solid var(--shell-hairline) }`（= `--cockpit-border` #262D37）
对它自己的底 ≈ **1.34:1**；hover 时的 `--cockpit-border-strong` #65727F 对 `--shell-raise` #32353B 也只有 **2.50:1**。

**为什么重要**：施工图 §8.2 把「正文与语义色 ≥4.5:1」「控件边框 ≥3:1」写成**验收判据**并要求「加一条测试」。
测试加上了 ✓，但它**守的是一个虚构的底色** → 判据**实际上没被守住**——
这正是本工程反复吃过的亏（「测试通过」≠「测试能抓住 bug」）。

> **注意**：自评 §2.3 说「我点名的边框不达标，**改了**」——
> 改的是 `#5F6C7A → #65727F`（`seed.ts:35`），**对 `--cockpit-bg` 达标了** ✓，
> 但**对卡片实际面（#383A3F）仍然不达标** ✓ → 修的是另一个面。

**怎么改**：
- (a) 让测试从**同一份映射**算出真实底色——把 `--shell-card-a` / `--shell-raise` 的 color-mix 派生提到
  `src/shared/theme/` 里可被测试导入的地方，**测试与 CSS 共用同一份值**；
- (b) 把深色面上的 `--cockpit-text-faint` / `--cockpit-unavailable` / `--cockpit-danger` 提到 ≥4.5:1，
  `.btn` 的边框改用 `--cockpit-border-strong` 或另给一个 ≥3:1 的控件边框 token。

**怎么验证**：把测试里的 `cardSurface.dark` 换成真实派生值（#383A3F）后重跑 —— **现在会红**；改完再绿。

---

## 二、Important（自评没提的）

### I1 · `refreshCards` 用磁盘快照整份覆盖内存布局 → 拖完可能跳回旧位置
`Shell.tsx:85-99`：`layoutRef.current = loaded; setLayout(loaded);` **无条件覆盖**。
请求发出到响应回来之间发生的任何布局改动（拖拽）会被回滚；下一次拖拽就把回滚后的旧位置写回磁盘 → **丢位置**。
触发路径：`Shell.tsx:157-161` 的 `onCardsChanged`（卡片目录一变就来一次）、工具栏「刷新卡片」、命令面板「重新扫描卡片目录」。
**怎么改**：给布局加本地 revision 计数；`refreshCards` 回来时若 revision 变了，只补 `cards` / 只合并缺失的 unit。
**怎么验证**：单测——`layoutGet()` → 本地改 unit → 触发 `refreshCards` → 断言 x/y 没被回滚。

### I2 · 终端订阅函数每次渲染都是新的 → `TerminalView` 的订阅 effect 每次渲染都重跑
`Dock.tsx:178` `subscribe={terminalSubscribe(activeSession.sessionId)}` —— 这一行在 JSX 里**每次渲染都造一个新函数**。
旧壳**专门防过这个坑**（`App.tsx:120-138` 用 `subscribeRef` 缓存，注释原文：
「**每次渲染都造一个新函数的话，effect 每渲染一次就重跑一次：先取消旧的监听、再装新的，中间到达的输出就丢了**」）。
新壳把这层去掉了 → Shell 每来一条读数就重渲染 → Dock 重渲染 → `TerminalView.tsx:118-123` 的 effect 重跑。
**怎么改**：照抄旧壳的 `subscribeRef` 缓存（或用 `useRef(Map)` 按 sessionId 缓存）。

### I3 · 终端从「多标签同时挂着」改成「只渲染当前会话」→ 切标签 / 换主题丢 scrollback
`Dock.tsx:172-179`：只渲染 `activeSession`，且 `key={activeSession.sessionId + xtermTheme.background}`。
旧壳（`App.tsx:220-240`）把**所有**终端面板都挂着、用 `hidden` 切换，注释写明「**切标签不该销毁它**」。
→ 用户在 A 会话滚上去看日志，切到 B 再切回来，**A 的屏幕没了**；
`key` 里带主题色还意味着**换一次主题就重建所有终端**。
**怎么改**：渲染全部会话的终端、非激活的用 CSS 隐藏；主题切换不要用 key 重建，改为把 palette 传给 TerminalView。

### I4 · xterm 的 16 色调色板**根本没接上**；接上的那个槽位还**映射错了**
`theme.ts:54-72` 造了完整 `XtermTheme`，但 `Dock.tsx:174` 只用了 `xtermTheme.background` 当 React key；
`TerminalView.tsx` **没有 theme prop**（`:68-73` 只设 background/foreground/cursor/selectionBackground 四个）
→ **终端的 ANSI 16 色还是 xterm 默认色，跟 token 无关**。
更糟：`theme.ts:67` `cyan: v('--cockpit-series-3', '#39C5CF')` ——
`--cockpit-series-3` 在 `seed.ts:38` 是 **#D29922（琥珀）**，而 fallback 写的是 **#39C5CF（青）**：
**硬编码色值与 token 已经漂移**（正是施工图 §六.1 说的那类破相）。
**怎么改**：给 `TerminalView` 加可选 `theme?: XtermTheme` 并把 palette 传进去；
`cyan` 改用 `--cockpit-series-5`（#39C5BB，青），**fallback 从 `aliasVars` 取，不写字面量**。

### I5 · `error` 态会显示上一次的旧值，而且**没说那是旧值**
`format.ts:57-64`：`case 'error': showValue: reading.value !== null`，
而 `src/main/tags/store.ts:75-77` 明确：error 从 ok/stale 进入时**保留旧值**。
→ UI 在「✕ 读取失败」下面显示一个可能很久以前的数字，**且没有** `stale` 那种「已过时」提示。
契约 `spec/01 §2.1` 对 error 的要求是「显示错误」；stale 之所以写「显示值 + 已过时标记」，
正是因为那个值可能不是现在的。**这与 `unavailable ≠ 0` 是同一条底线。**
**怎么改**：error 且有值时，值后面加「（上一次的值）」，或 `showValue` 设成 false。

### I6 · 变异守卫现在守的是**已经死掉的代码**，新壳的等价行为无人看守
`src/renderer/App.tsx` **已无任何生产引用**（`main.tsx` 指向 `Shell`；grep 为空），
而 M1（`scripts/mutation-check.mjs:176`）与 M10 的变异目标就是它
→ **`mutation:check` 依然报「全守住」，但守的是死代码**；
新壳里的等价逻辑（`Shell.tsx:580-587` 的 `role="alert"` 错误条、`Shell.tsx:379` 的 `getPathForFile`）**一条守卫都没有**。
而且新壳**丢了旧壳的空路径保护**：旧 `App.tsx:194-197` 有
`if (!localPath) { setError('拿不到这个文件的本地路径…'); return; }`，
新 `Shell.tsx:378-384` 直接把可能是空串的 localPath 递下去
（main 会以「没有本地源路径」挡下来，**所以不是安全问题**，但错误信息退化 + 少一道防线）。
**怎么改**：M1 / M10 的变异目标改到 `src/renderer/shell/Shell.tsx`（并在 Shell 里补回 `if (!localPath)` 早退）；
顺带把 `src/renderer/App.tsx` 删掉（自评 §3.1 也认了这条）——否则变异会直接打不上而报「变异没打上」。

### I7 · 这一轮风险最高的新代码（布局 v2 跨进程形状）**一条变异守卫都没有**
`src/shared/layout.ts` 从 33 行变成 238 行（`normalizeLayout` / `withViewUnits` / `withViewConfig` /
`viewConfigFor` / `normalizeViewConfig`），`wiring.ts` 的 `layoutSet` 改成逐视图合并。
`scripts/mutation-check.mjs` 里**没有一个变异指向 `src/shared/layout.ts`**；
指向 `main/cards/layout.ts` 的只有 M63（不落盘）。
**为什么重要**：v1→v2 迁移、每视图隔离、`units` 镜像同步——这三条正是用户会「丢布局」的地方。
**怎么改**：至少加三条——「v1 文件必须落到总览」「`units` 镜像必须等于 `views[activeViewId].units`」
「`layoutSet` 不得动别的视图的格子」。**怎么验证**：守住项数 +3。

### I8 · 命令面板显示了「G 1 / G 2 / G 3 / G 4」四个快捷键，但**没有任何代码实现**
`Shell.tsx:441-444` 给四条「切换视图」命令标了 `shortcut: 'G 1'…`，
`CommandPalette.tsx:103` 会把它渲染成**可见的 `<kbd>`**；
而键盘处理（`Shell.tsx:207-227`）只认 Ctrl/Cmd+K、Ctrl/Cmd+`、Esc → **用户按了就是没反应**。
（`SettingsPage.tsx:193` 另有一套诚实的说法「Ctrl + 1..4 切换视图（预留）」——**两处自相矛盾**。）
**怎么改**：实现（记一个「g 前缀」状态机）或把 shortcut 去掉 / 标「预留」。

### I9 · 新写的形状文件注释是中文，与「新代码注释一律英文」不符
`src/renderer/shell/**` 全英文 ✓，但 `src/shared/layout.ts`（几乎整份重写）、
`src/main/cards/layout.ts` 新增段落、`src/main/cards/wiring.ts` 新增的两段注释都是中文；
wiring.ts 里还**中英混排**（`每个视图分别合并…` / `Display config travels with the view…`）。
**这条本身需要拍板**：`src/shared/layout.ts` 是**契约面**文件，既有契约层代码全是中文，
而任务书只说「**你新写的这套**用英文」——「这套」指新外壳还是本轮所有新代码，**措辞有歧义**。
**怎么改**：拍板后统一；若判定 shared 层跟既有契约层一致用中文，
就把任务书那条改成「**renderer 新壳用英文，shared/main 跟随所在层既有语言**」。

---

## 三、Minor

- **M1** · 旧壳没退场：`src/renderer/App.tsx`、`src/renderer/tags/ReadingsPanel.tsx`、
  `src/renderer/cards/panel.tsx`、`src/renderer/cards/board.tsx` 现在**都没有生产引用**（只有测试还 import 前两个）；
  `app.css` 的 `.cockpit-*` 大半是死规则，但 `main.tsx` 仍在 import 它。
  **尤其 `panel.tsx`（一个完全没人引用的文件）在本轮被修改了**却没删。
  → 删掉这四个文件（连同它们的测试与 I6 里指向 App.tsx 的两条变异），`app.css` 只留还在用的规则。
- **M2** · 视图清单有两份真源：`shared/layout.ts:25 LAYOUT_VIEW_IDS` / `:30 LAYOUT_VIEW_NAMES` 是权威，
  但 `src/renderer/shell/types.ts:227-232` 又硬写了一份 `VIEWS`（同样 4 个 id + 中文名），
  而 `LAYOUT_VIEW_NAMES` **反而没人用**。加一个视图要改两处，忘了就静默不同步。
  → `shell/types.ts` 的 id 列表从 shared 派生（名字/提示语可留 UI 层）。
- **M3** · `UserGrid` 按 cardId 建索引，多连接下会张冠李戴：
  `UserGrid.tsx:65` `new Map(cards.map(c => [c.cardId, c]))` + `:82` `byCard.get(card.cardId) ?? card`。
  契约 §7.8 允许一张卡在多条连接上各有一个实例；一旦成立，两个格子拿到**同一个实例**
  （第二个 iframe 加载第一个的 URL，`broker.registered` 也会被覆盖）。
  其余地方（`slotKey`、hidden 键）都正确用了 `(cardId, connectionId)`，**只有这里不是**。→ 按 slotKey 建索引。
- **M4** · `LibraryPage` 的 `selectedCardId` prop 不同步进内部状态：
  `LibraryPage.tsx:22` `useState(selectedCardId)` 只在挂载时取一次；
  在工作台选了卡再进卡片库，看到的还是列表第一张。→ 加 effect 同步或改成受控。
- **M5** · 路径软链夹具把「文件软链」换成了「目录 junction」，**覆盖面变窄**：
  `tests/unit/cards/paths.test.ts:74-108` 现在三条都是**目录**链接，原来有一条是**文件**软链。
  `resolveInsideCard` 对两者走同一条 `realpathSync` 分支（`paths.ts:56-60`），风险不大，
  但「文件软链」这个形状现在**在任何平台都没有测试**。
  另外 `it.skipIf(!LINK_OK)` 保留着：万一建不了 junction，三条会**静默跳过**而套件仍全绿
  ——原注释里那句「**别把跳过当通过**」的告诫在改写时被删掉了。→ 加回文件软链用例，并让 skip 可见。
- **M6** · `xtermThemeFromVars` 的 fallback 是硬编码色值且已与 token 漂移（见 I4）。→ fallback 从 `aliasVars` 取。
- **M7** · `shell.css` 自造了一层 `--shell-*` 变量（`:36-42`、`:54-60`）。
  它们**全部**由 `var(--cockpit-*)` 经 color-mix 派生，没有引入新色值，主题切换仍整体生效，
  **不违反**施工图 §六.1 ✓。但确实多了一层；将来改色要先改种子再核派生链。→ 记一笔，不必现在动。
- **M8** · Inspector「数据」页的文案不准确：`Inspector.tsx:107` 写
  「这里显示的是这个实例能看到的读数样本」，但它显示的是 `readings` 全量（`Shell.tsx:637`），
  **没有**按这个实例的权限过滤（renderer 不该判权限、main 也没暴露按实例过滤的通道）。
  → 改文案为「宿主给页面的全部读数；按卡片权限过滤后的结果由卡自己取得」。
- **M9** · 卡片库「放到工作台」按钮只做 `setPage('workbench')`，并不真的把这张卡放进工作区
  （卡片本来就在工作区）。按钮名与行为不符。→ 改成「回到工作台」。

---

## 四、我**没验**的（合并前的硬门槛）

| # | 事 | 为什么 | 谁跑 |
|---|---|---|---|
| 1 | **`npm run test:cards`（10 条 e2e）** | 沙箱的 `/tmp` 被清空（Linux 版 Electron 没了）→ **沙箱里跑不了 e2e**；新壳**还没被这 10 条验过** | **宿主**（Windows） |
| 2 | 全量 `npm run mutation:check`（64 项） | 一次跑不完（沙箱里 > 3 分钟会被砍） | 宿主 |

> **第 1 条是合并前的硬门槛**：新壳换了卡片区的 DOM，虽然**稳定钩子还在**
> （`CardShell.tsx:37-39` 的 `data-cockpit-drag-handle` + `data-card-id` ✓），
> 但「布局那条」（拖 → 重启 → 位置还在）与「内置卡自动出现」两条**依赖 DOM 结构**，
> 必须真跑一次才算数。

---

## 五、建议的顺序

1. **先修 C1**（一行改动 + 一条新测试）——它是「功能写了但用不了」，最伤。
2. **再修 C2**（把测试的底色换成真实派生值 + 调色），并把「真实底色」做成**测试与 CSS 共用的一份值**，
   否则下一次换肤还会重演。
3. **I6 / I7 一起做**：删旧壳 → 把 M1/M10 两条变异迁到 `Shell.tsx` → 给 `src/shared/layout.ts` 补三条变异。
   这三件事是同一件事：**别让「全绿」守着一堆死代码**。
4. **I2 / I3 / I4 一起做**（终端这一块的三处倒退），一次补齐。
5. I1 / I5 / I8 放下一个提交；**I9 需要拍板**注释语言的范围。

---

*本评审只读，未改动 DSH 的任何文件；所有数字都标注了出处（文件:行号或实算过程）。*
