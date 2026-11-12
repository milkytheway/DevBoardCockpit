# DevBoard Cockpit（开发板驾驶舱）

> **前身工程**：`D:\3588\02、RK3588开发平台\DevBoardConsole`（Python + PySide6，已冻结，不删不改）。
> 本工程于 2026-11-12 新建：**UI 层整体推倒重来**，代码栈改为 Electron + React + TypeScript。
> **契约层**（tag 词汇表、板型包格式、卡片 manifest、MCP 工具集）自前身工程迁入，已是权威。

## 这是什么

面向嵌入式 Linux 开发者和玩家的 **Windows 桌面工作台**：
把板子的能力标准化成**语义位号**，把可视化与操控标准化成**卡片**，把扩展标准化成 **MCP**，
然后让一个不知疲倦的 AI 照着手册，替你批量制造仪表和开关。

> 板子即数据源，GUI 即座舱——既是仪表盘（看状态），更是驾驶舱（改行为）。

产品有两重身份：

1. **统一工作台**：终端、文件互传、状态监控、显示输出，一个 GUI 全搞定。
2. **AI 可扩展的能力宿主**：功能不写死。宿主机上的 AI 编程 agent（Claude Code / Codex）
   通过 MCP 读取 GUI 内部状态、直接编写卡片，改完热插拔即生效。

本质上，这是给嵌入式板子做的**组态软件（SCADA / HMI）**：
位号 = 数据源，画面元件 = 卡片，组态 = 布局——只不过组态工程师是 AI。

## 当前状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 契约层 | ✅ 已迁入并追认 | `docs/spec/` 五份 + `data/tag-vocabulary.yaml` + 板型包 |
| 资产迁移 | ✅ 已完成 | 设备事实清单、真机样本、连接 profile |
| 架构设计 | 🟡 待用户逐节确认 | `docs/04-架构设计.md` |
| 评审 | ✅ 契约层两轮 + 设计两份 | `docs/07`、`docs/08`（契约层）· `docs/10`×2（独立设计） |
| 实现层评审 | ✅ 一轮 57 条 | `docs/11-计划1评审报告.md`（含真机实测） |
| 契约核对 | 🔵 部分已定 | `docs/06-契约核对.md`（C1–C7 共 7 条；C1/C2/C3/C6/C7 已定，C4/C5 待拍板） |
| 实施计划 | ✅ 计划 1 已写 | `docs/superpowers/plans/2026-11-12-plan1-*.md` |
| 代码实现 | 🟡 计划 1 已实现 | 工程骨架 + 终端三通道 + 文件互传，见 `src/`；**真机验收前不算完成** |
| 真机验收 | 🔵 待做 | 需在 Windows 宿主机上跑 `docs/superpowers/plans/2026-11-12-plan1-真机验收清单.md` |

**代码在 `src/`，148 条测试。** 但**计划 1 还不算完成**——
两份实现层评审查出 5 条 P0（应用起不来、错误到不了眼前、ADB 终端不通、串口 exec 永久超时、文件互传两条路都不通），
已全部修掉；**剩下的缺口是「没在真机上跑过」**，清单在
`docs/superpowers/plans/2026-11-12-plan1-真机验收清单.md`。

## 文档地图（按这个顺序读）

| 文档 | 讲什么 | 作者 |
|---|---|---|
| `docs/09-总设计.md` | **总纲**：架构全貌 + 为什么这么设计 + 还差什么（**先读这个**） | k3.1 pro |
| `docs/10-独立架构设计-GLM5.3Flash.md` | 第三份独立设计（契约的一种落地方式） | GLM 5.3 Flash |
| `docs/10-独立设计-deepseek-v4.1-flash.md` | 第四份独立设计（与契约有多处冲突，取舍见 09 §4.4） | deepseek-v4.1-flash |
| `docs/00-项目愿景.md` | 用户定稿的产品愿景（上位约束） | 用户 |
| **`docs/spec/00-overview.md`** | **契约总览：两条对称的总线** | 迁移（契约层） |
| **`docs/spec/01-tag-contract.md`** | **语义 tag 契约：词汇表、五态、刷新模型** | 迁移（契约层） |
| **`docs/spec/02-board-pack.md`** | **板型包格式：reader kind、绑定、动作、校验规则** | 迁移（契约层） |
| **`docs/spec/03-card-manifest.md`** | **卡片 manifest：读侧绑定、写侧绑定、权限模型** | 迁移（契约层） |
| **`docs/spec/04-mcp-tools.md`** | **MCP 工具集：AI 的眼睛和手** | 迁移（契约层） |
| **`docs/spec/data/tag-vocabulary.yaml`** | **核心词表的机器可读权威**（`01` 的表格由它生成） | 本轮评审新增 |
| `docs/01-旧工程现状.md` | 前身工程盘点：什么已建成、什么要丢弃 | Codex |
| `docs/02-设备事实清单.md` | **踩过的坑与实测值**（全库最不能丢的一篇） | 迁移 + 复核 |
| `docs/03-迁移对照表.md` | 旧模块 → 新模块：保留 / 改写 / 丢弃及理由 | Codex |
| `docs/04-架构设计.md` | **外壳与实现层的设计**（进程模型、卡片运行时、MCP 落地、里程碑） | Codex |
| `docs/05-决策记录.md` | ADR：已冻结的决策与被否掉的选项 | Codex |
| `docs/06-契约核对.md` | **契约草案 ↔ 真板实测的差异清单（C1–C7）** | Codex |
| `docs/07-评审报告.md` | **第一轮评审报告**（P0×5 / P1×29 / P2×24 / P3×20） | Claude |
| `docs/08-独立评审-k3.1pro.md` | **第二轮独立评审**（P0×4 / P1×16 / P2×17 / P3×13，含与 07 的对照） | k3.1 pro |
| `docs/10-独立架构设计-GLM5.3Flash.md` | **独立架构设计**（与 docs/04 平行的落地提案，供对照融合；未读 04/07/08/09 独立写成） | GLM 5.3 Flash |
| `docs/legacy/` | 旧工程的架构说明与加板指南（原样保留） | 旧工程 |

## 两层分工（别搞混）

```
契约层  docs/spec/*        —— 权威定义，改动要升 apiVersion
实现层  docs/04 + src/     —— Electron 外壳、卡片运行时、路线图（计划 1 已落地）
```

> **契约层已由用户追认为当前基线**（`docs/05` ADR-D15），
> 逐节来源见 `docs/spec/00-overview.md` §一之二。
> 核心词表的**机器可读权威**是 `docs/spec/data/tag-vocabulary.yaml`，
> `docs/spec/01` 里的表格是它的渲染结果。

> ⚠️ **契约层已由用户追认**（`docs/05` ADR-D15），实现层从「计划 1」开始建。
> **计划 1**（工程骨架 + 终端三通道 + 文件互传）已实现并通过自动化测试；
> **真机验收**（串口 / ADB / SSH / 日志 / 超时码）要在 Windows 宿主机上做，
> 清单见 `docs/superpowers/plans/2026-11-12-plan1-真机验收清单.md`。

## 跑起来

```powershell
npm install     # 会触发 electron-rebuild，把 node-pty / serialport 重编译到 Electron 的 ABI
npm run dev     # 起工作台：串口 / ADB / SSH / 本机 四个终端
```

三道检查必须全绿：

```powershell
npm run lint
npm run typecheck
npm test
```

另外两个跟「不漂移」有关的：

```powershell
npm run gen:vocabulary:check   # 词表三份一致：YAML = 文档表格 = 代码词表
npm run mutation:check               # 变异测试：证明回归测试真的在守
```

**宿主的 adb 路径在 `profiles/settings.json` 的 `hostTools.adb`**——
这台机器上 adb 不在 PATH（`where adb` 查不到），机器专属路径不进代码（`AGENTS.md` §3）。

会话日志在 `%LOCALAPPDATA%\DevBoardCockpit\logs\<日期>\`，
格式是 `[HH:mm:ss.SSS] 行`，与黄金样本 `fixtures/session-log/serial-session.log` 同构。

## 已冻结的决策

| # | 决策 | 详见 |
|---|---|---|
| D1 | 技术栈 = Electron + React + TypeScript，**不做双层混合** | `docs/05-决策记录.md` |
| D2 | **MCP server 必须与 GUI 同进程**（放 Electron main） | 同上 |
| D3 | 布局模型 = **网格单元**（react-grid-layout） | 同上 |
| D4 | 卡片视图 = **免构建 ES Module**，改文件即生效 | 同上 |
| D5 | 连接 profile 与板型包 **拆成两个正交概念** | 同上（= 契约 spec/00 的 D5） |
| D6 | 卡片跑在 **sandbox iframe + 白名单** 里；**断网靠宿主注入的 CSP**，存储靠 `cockpit.storage.*` | `docs/05` ADR-D6 / D16 |
| D7 | 动作**两档**分级（`reversible` / `destructive`，字段 `danger`，声明在板型包）+ dry-run + **回读闭环** + 参数域 `guard` | `docs/05` ADR-D7 / D17 |
| D12 | **契约层沿用迁入的 spec 草案，不另起炉灶** | 同上 |
| D15 | **契约基线：追认当前 HEAD + 补逐节来源表** | 同上 |
| D19 | **MCP 走 HTTP 回环 + 发现文件 + bearer token** | 同上 |

## 目录结构（当前）

```
DevBoardCockpit/
├─ src/
│  ├─ main/                 ★ 唯一持有设备 I/O 的地方（hal / terminal / files / util / logging）
│  ├─ preload/              contextBridge 白名单（唯一出口）
│  ├─ renderer/             只画界面（terminal / files / theme）
│  └─ shared/               IPC 契约、错误形状、词表（生成物）
├─ tests/                   unit / integration / web 三组
├─ scripts/                 词表生成器、构建产物自检、变异测试
├─ docs/
│  ├─ spec/                 ★ 权威契约（五份 + data/ 词表）
│  ├─ legacy/               旧工程原始文档
│  ├─ superpowers/plans/    实现计划与真机验收清单
│  └─ 00~11                 愿景 / 现状 / 事实 / 迁移 / 设计 / ADR / 核对 / 评审 / 总纲 / 独立设计×2 / 实现层评审
├─ profiles/
│  ├─ boards/rk3588-atk/    板型包（board.yaml）
│  ├─ targets/              连接实例 profile（怎么连上）
│  └─ settings.json         宿主工具路径等全局设置
├─ fixtures/                真机样本（黄金测试向量）
├─ electron.vite.config.ts  main/preload/renderer 三段构建
├─ package.json
└─ AGENTS.md / README.md / LICENSE
```

## 事实标注规矩

| 标记 | 含义 |
|---|---|
| 🟢 已核实 | 本机实测确认过，能指出证据来源 |
| 🟡 用户陈述 | 用户说的，尚未独立验证 |
| 🔵 待验证 | 附了验证命令，等着跑 |

**不要把 🟡 或 🔵 写成 🟢。** 冲突时以 `docs/02-设备事实清单.md` 为准。

## 许可

MIT（继承自前身工程）。