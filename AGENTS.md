# AGENTS.md —— 给进入这个工程的 agent 的说明

> 你正在处理 `D:\3588\02、RK3588开发平台\DevBoardCockpit`。
> 这是「开发板驾驶舱」新工程（Electron + React + TypeScript）。
> 前身是同级目录的 `DevBoardConsole`（Python + PySide6，已冻结，只读参考）。

---

## 1. 先建立心智模型

这是一个**产品工程**。产品形态一句话：

> 面向嵌入式 Linux 开发者的 Windows 桌面工作台。
> 板子的能力 = 语义位号（tag），可视化与操控 = 卡片，扩展 = MCP。
> 组态工程师是 AI。

工程分**两层**，别搞混：

| 层 | 在哪 | 地位 |
|---|---|---|
| **契约层** | `docs/spec/` 五份文档 + `docs/spec/data/tag-vocabulary.yaml` | **权威**。tag 词汇表、板型包格式、卡片 manifest、MCP 工具集都在这里 |
| **设计层** | `docs/04-架构设计.md` | 契约怎么落到这套栈上。**待用户逐节确认** |
| **实现层** | `src/` | Electron 外壳、卡片运行时、路线图。**计划 1 已落地**（工程骨架 + 终端三通道 + 文件互传） |

> ⚠️ **契约层已由用户追认**（`docs/05` ADR-D15），`writing-plans` 已排出计划 1 并开始实现。
> **实现层的规矩**：
> - **计划外的新功能不许写。** 计划在 `docs/superpowers/plans/`，每一步都有验收判据；
>   要加东西先改计划。
> - **先写测试再看它失败**（TDD）。本仓库的规矩是「纯函数必须有单测；
>   真机样本做黄金向量」。
> - **契约层仍然冻结**：改 `docs/spec/` 要升 `apiVersion` 并走评审（ADR-D15）。
> - 契约与实测的差异记进 `docs/06`，**不擅自改包**。
>
> **已实现**（计划 1）：工程骨架、连接 profile 的封闭 schema、
> 串口 / ADB / SSH / 本机四个传输、终端会话与 pty/pipe 双模式、文件互传。
> **尚未实现**（计划 2–4）：tag 位号层、板型包运行时、卡片运行时与沙箱、MCP server。
>
> **真机验收**要在 Windows 宿主机上做，清单见
> `docs/superpowers/plans/2026-11-12-plan1-真机验收清单.md`。

三条不可动摇的主线：

1. **契约优先**：契约已冻结在 `docs/spec/`，实现必须**逐条对齐**，不得另立一套命名或状态语义。
2. **AI 可造卡**：卡片是文件，agent 写完即生效，改一行热插拔。
3. **驾驶舱而非遥控器**：控制动作必须**回读**，UI 以板子真实状态为准。

## 2. 阅读顺序

```
README.md
  └─ docs/09-总设计.md                总纲：架构全貌 + 为什么 + 还差什么（**先读这个**）
  └─ docs/spec/00-overview.md        两条对称的总线 + 契约逐节来源表
  └─ docs/spec/01-tag-contract.md     tag 词汇表与五态
  └─ docs/spec/data/tag-vocabulary.yaml  核心词表的机器可读权威（01 的表格由它生成）
  └─ docs/spec/02-board-pack.md       板型包与 reader kind
  └─ docs/spec/03-card-manifest.md    卡片与权限
  └─ docs/spec/04-mcp-tools.md        MCP 工具集
  └─ docs/02-设备事实清单.md          实测事实与踩坑（写代码前必读）
  └─ docs/04-架构设计.md              落地方式（Codex 撰写，待确认）
  └─ docs/05-决策记录.md              已冻结的决策（ADR-D1~D19）
  └─ docs/06-契约核对.md              契约与实测的差异（C1–C7）
  └─ docs/07-评审报告.md              第一轮评审
  └─ docs/08-独立评审-k3.1pro.md      第二轮独立评审 + 与 07 的对照
```

## 3. 硬规矩

| 规矩 | 说明 |
|---|---|
| **契约是权威** | 想改 tag 名、单位、状态语义、板型包字段 → 先改 `docs/spec/`，再同步改实现层。**两处同改**，否则对拍测试会红 |
| **词表只有一个源头** | 核心词表的机器可读权威是 `docs/spec/data/tag-vocabulary.yaml`；`docs/spec/01` 的表格是它的渲染结果。改词表改 YAML，**不许另写一份** |
| **编号分几套** | `ADR-D*`（`docs/05` 实现层决策）/ `SPEC-D*`（`docs/spec/00` 契约层决策）/ `C*`（`docs/06` 核对条目）/ `O*`（跨文档待决）/ `Q*`（`docs/04` 设计层待决）。**引用时写全前缀**——历史上两套都叫「D7」，导致「见 D7」有二义 |
| **对拍是硬判据** | TS 实现必须跑通与契约同源的黄金样本断言（样本在 `fixtures/`，同样本同结果） |
| **设计未确认不写实现** | `docs/04-架构设计.md` 逐节被用户确认之前，只允许写文档、契约、测试向量 |
| **事实要标状态** | 🟢 已核实 / 🟡 用户陈述 / 🔵 待验证。**不要把 🟡 写成 🟢** |
| **路径写绝对路径** | Windows 宿主用 `C:\...`；板端路径用 POSIX 绝对路径 |
| **别拷大文件进仓库** | SDK、固件、PDF 原书一律只记路径 |
| **旧工程只读** | `DevBoardConsole` 保留事实与理由，**不删不改**；移植先看 `docs/03-迁移对照表.md` |
| **改决策要写 ADR** | 动 `docs/05-决策记录.md`，别在代码里默默改架构 |
| **提交前跑测试** | `npm run lint && npm run typecheck && npm test` 全绿才提交 |
| **修完 bug 要验测试真的在守** | 把修复**改回去**，确认对应测试**变红**，再还原确认变绿。<br>「测试通过」不等于「测试能抓住这个 bug」——只有变异能区分。<br>跑 `npm run mutation:check` 看当前这批修复是否都还守着 |
| **替身按行为建模，不按结论建模** | 假实现要模拟**真实行为**（回显每一行、执行命令、异步回调），<br>不能直接返回「契约期待的那个答案」——那样会把协议形状的 bug 盖住 |
| **词表只有一个源头** | 改词表改 `docs/spec/data/tag-vocabulary.yaml`，然后 `npm run gen:vocabulary`。<br>跑 `npm run gen:vocabulary:check` 确认「YAML = 文档表格 = 代码词表」三份一致 |

## 4. 事实从哪来

- `docs/02-设备事实清单.md` —— **唯一事实源**，板子的路径、命令、坑都在那。
- `docs/06-契约核对.md` —— 契约与实测对不上的地方（**先看这里再改包**）。
- 想知道「为什么这么做」，去 `docs/legacy/` 和 `docs/spec/` 翻前身工程的设计说明。
- 用户在学习工作区（`C:\Users\Administrator\Desktop\嵌入式Linux学习`）的实测记录
  （`04-环境/环境实况.md`）是**上游来源**，但以本工程 `docs/02` 为准。

## 5. 代码规范（实现阶段生效）

| 项 | 约定 |
|---|---|
| 语言 | TypeScript `strict: true`，禁止 `any`（确需时 `unknown` + 收窄） |
| 主/渲染边界 | 设备 I/O、tag 层、action 层、卡片注册表、**MCP server** 全部在 main；renderer 只画 |
| 卡片 | 跑在 sandbox iframe 里，只能通过白名单 API 触达宿主（契约 spec/03） |
| 进程/子进程 | Windows 下子进程一律 `windowsHide: true`（否则每条命令闪黑窗） |
| 测试 | vitest；纯函数必须有单测；真机样本做黄金向量（`fixtures/`） |
| 样本 | `fixtures/` 里的样本**只增不改** |

## 6. 别做的事

- ❌ 私自改 tag 命名或状态语义（先改契约文档）
- ❌ **在契约评审通过前写任何实现代码**（TS 源码、校验器、参考实现、测试脚手架都不行）
- ❌ 让 renderer 直接碰设备（绕过 tag / action 层）
- ❌ 给卡片开后门（同源、任意 `postMessage`、直接 fs）
- ❌ 把「读取板子状态」写成逐文件多次往返（会污染 `/proc/stat`，见事实 A5/A6）
- ❌ 同一个连接上让采样与动作并发往返（串口只有一根线，会串台，见 `spec/02` §1.2.1）
- ❌ 把参数原样拼进命令（字符串参数要按类型编码，见 `spec/02` §4.6）
- ❌ 只靠 iframe 的 `sandbox` 断网（必须由宿主注入 CSP，见 `spec/03` §6.1）
- ❌ 把 `unavailable` 当成 `0` 处理
- ❌ 在实现阶段把契约文档「顺手改一改」
- ❌ **在沙箱里直接 `npm install`**（会剪掉宿主要的 win32 平台包，见 §6.1）

### 6.1 加依赖（**沙箱与宿主共享同一个 node_modules**）

npm 的 `optionalDependencies` 是**按平台安装**的（`@esbuild/win32-x64` vs
`@esbuild/linux-x64`、`@rollup/rollup-win32-*` vs `-linux-*`…）。
→ **在 Linux 上跑一次 `npm install`，npm 会把宿主那一半当成多余的剪掉**，
宿主上 `vitest` / `tsx` 就起不来（反过来一样）。

**规矩**：

| 谁加依赖 | 怎么做 |
|---|---|
| **沙箱（Linux）** | `bash scripts/acceptance/add-dep.sh <pkg>[@version]` —— 隔离前缀装 → 只把缺的包拷进共享树 → 改 `package.json` → `npm install --package-lock-only` 更新 lock。**共享树一个字节都不碰** |
| **宿主（Windows）** | `npm install` → 然后**在沙箱里**跑 `bash scripts/acceptance/linux-natives.sh restore`（把 Linux 的平台包补回来；那个脚本在 Windows 上不能跑，它会动 `node-pty/build/`） |

> **改 lock 用 `npm install --package-lock-only`** —— 它**只改 lock 文件，不碰 node_modules** ✓
> （lock 里两边的平台包都记着 ✓ → 不会把对方的剪掉）。
> 另外：`package.json` 与 `package-lock.json` **必须同步** ——
> 漏了的话 `npm ci`（CI / 干净机器）会装不全（这个工程已经栽过一次：
> `react-grid-layout` 与 `@playwright/test` 都在 package.json 里却不在 lock 里）。

### 6.2 调 UI 用的**假设备**（没有板子也能调外壳）

```bash
COCKPIT_FAKE=1 npm run dev      # 假板子排第一（真板子还在列表里）
COCKPIT_FAKE=only npm run dev   # 只有假板子
```

**它是什么**：一块**只吐原始文本**的假板子（`src/main/hal/fake/`），
跑在 **HAL 边界**上——真包 + 真 kind + 真 store + 真采样器都在跑，
只有「跟板子说话」那一层被换掉了。

**三条规矩**：

| 规矩 | 为什么 |
|---|---|
| **假设备只吐原始文本**（jiffies / kB / `@Hz` / 毫度），**不造百分比、不造五态** | 五态是**契约**（`docs/spec/01` §2.1）。假设备自己造 = **把契约抄了第二份**，迟早漂移 |
| **假设备的 profile 不落盘** | `profiles/targets/` 要保持干净 |
| **生产包不许有它** | `scripts/check-build.ts` 会扫 `out/main/**`，标记串出现就判红（已实测两个方向） |

**为什么值得做**：板子不插电、adb 没起、串口被占的时候，外壳**只能对着空气调**——
而一个从没见过 `unavailable` 与 `error` 的界面，等板子真掉线时**第一次见到它们**。
（详见 `docs/05` ADR-D30。）

## 7. 常用命令（实现阶段才有意义）

```powershell
npm run dev                # electron-vite 开发模式
npm run build              # 三段构建 + 构建产物自检（preload 文件真的在吗）
npm run lint               # ESLint
npm run typecheck          # tsc --noEmit
npm test                   # vitest
# 板型包 + 卡片 manifest 校验 —— **计划 2（M3/M4）起才有**
# 对着真板跑 reader，核对输出 —— **计划 2（M3/M4）起才有**
npm run gen:vocabulary     # 从 YAML 生成词表（文档表格 + 代码词表）
npm run gen:vocabulary:check        # 校验三份一致，不一致就退出码 1
npm run mutation:check     # 变异测试：证明回归测试真的在守着（77 项）
npm run test:cards         # Playwright（Electron 模式）的 e2e —— **真 Electron**
# 调 UI 用的假设备（不需要真板子）—— 见 §6.2
COCKPIT_FAKE=1 npm run dev # 假板子排第一（合成数据）
COCKPIT_FAKE=only npm run dev  # 只有假板子
```


> **上面 8 条命令现在都有**（`package.json` 里就是这 8 条）。
> `validate:profiles` 与 `probe:board` **属于计划 2（M3/M4）**，现在还不存在——
> 文档里引用它们的地方已标注「计划 2 起可用」，别照抄一个不存在的命令。
>
> **`npm run gen:vocabulary:check` 不要写成 `npm run gen:vocabulary -- --check`。**
> PowerShell 下的 `npm.ps1` 会把 `--` 之后的内容吃掉——
> 于是「校验」静默退化成「生成」，**而生成会改写契约文档**。
> 独立的脚本条目不经这层转发，跨平台都对。

---

*创建于 2026-11-12，由 Codex 按用户定稿愿景初始化；
契约层自前身工程迁入。前身工程的 Python 参考实现已在契约评审前移除（评审通过后按契约重写）。*