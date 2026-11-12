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
| **契约层** | `docs/spec/` 五份文档 | **权威**。tag 词汇表、板型包格式、卡片 manifest、MCP 工具集都在这里 |
| **实现层** | `docs/04-架构设计.md` + `src/` | Electron 外壳、卡片运行时、路线图。**尚未开始** |

> ⚠️ **本工程目前只有契约层，没有实现层。**
> 契约尚未经用户逐节评审通过，因此**不得写任何实现代码**——
> 包括 TS 源码、校验器、参考实现、测试脚手架。
> 允许写的只有：文档、契约、板型包数据、真机样本。
> 评审通过后才进 `writing-plans` 排实现顺序。

三条不可动摇的主线：

1. **契约优先**：契约已冻结在 `docs/spec/`，实现必须**逐条对齐**，不得另立一套命名或状态语义。
2. **AI 可造卡**：卡片是文件，agent 写完即生效，改一行热插拔。
3. **驾驶舱而非遥控器**：控制动作必须**回读**，UI 以板子真实状态为准。

## 2. 阅读顺序

```
README.md
  └─ docs/spec/00-overview.md        两条对称的总线（先看这个建立全局）
  └─ docs/spec/01-tag-contract.md     tag 词汇表与五态
  └─ docs/spec/02-board-pack.md       板型包与 reader kind
  └─ docs/spec/03-card-manifest.md    卡片与权限
  └─ docs/spec/04-mcp-tools.md        MCP 工具集
  └─ docs/02-设备事实清单.md          实测事实与踩坑（写代码前必读）
  └─ docs/04-架构设计.md              落地方式（Codex 撰写，待确认）
  └─ docs/05-决策记录.md              已冻结的决策
  └─ docs/06-契约核对.md              契约与实测的差异（待用户拍板）
```

## 3. 硬规矩

| 规矩 | 说明 |
|---|---|
| **契约是权威** | 想改 tag 名、单位、状态语义、板型包字段 → 先改 `docs/spec/`，再同步改实现层。**两处同改**，否则对拍测试会红 |
| **对拍是硬判据** | TS 实现必须跑通与契约同源的黄金样本断言（样本在 `fixtures/`，同样本同结果） |
| **设计未确认不写实现** | `docs/04-架构设计.md` 逐节被用户确认之前，只允许写文档、契约、测试向量 |
| **事实要标状态** | 🟢 已核实 / 🟡 用户陈述 / 🔵 待验证。**不要把 🟡 写成 🟢** |
| **路径写绝对路径** | Windows 宿主用 `C:\...`；板端路径用 POSIX 绝对路径 |
| **别拷大文件进仓库** | SDK、固件、PDF 原书一律只记路径 |
| **旧工程只读** | `DevBoardConsole` 保留事实与理由，**不删不改**；移植先看 `docs/03-迁移对照表.md` |
| **改决策要写 ADR** | 动 `docs/05-决策记录.md`，别在代码里默默改架构 |
| **提交前跑测试** | `npm run lint && npm run typecheck && npm test` 全绿才提交 |

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
- ❌ 把 `unavailable` 当成 `0` 处理
- ❌ 在实现阶段把契约文档「顺手改一改」

## 7. 常用命令（实现阶段才有意义）

```powershell
npm run dev                # electron-vite 开发模式
npm run lint               # ESLint
npm run typecheck          # tsc --noEmit
npm test                   # vitest
npm run validate:profiles  # 板型包 + 卡片 manifest 校验
npm run probe:board        # 对着真板跑 reader，核对输出
```

> 这些命令**现在还不存在**——`package.json` 与 `src/` 都要等契约评审通过后才建。

---

*创建于 2026-11-12，由 Codex 按用户定稿愿景初始化；
契约层自前身工程迁入。前身工程的 Python 参考实现已在契约评审前移除（评审通过后按契约重写）。*