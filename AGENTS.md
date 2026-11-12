# AGENTS.md —— 给进入这个工程的 agent 的说明

> 你正在处理 `D:\3588\02、RK3588开发平台\DevBoardCockpit`。
> 这是「开发板驾驶舱」新工程（Electron + React + TypeScript），
> 前身是同级目录的 `DevBoardConsole`（Python + PySide6，已冻结，只读参考）。

---

## 1. 先建立心智模型

这是一个**产品工程**，不是练习仓库。产品形态一句话：

> 面向嵌入式 Linux 开发者的 Windows 桌面工作台。
> 板子的能力 = 语义位号（tag），可视化与操控 = 卡片，扩展 = MCP。
> 组态工程师是 AI。

三条不可动摇的主线，任何设计都要为它们服务：

1. **契约优先**：tag 契约、卡片 manifest schema、MCP 工具集 —— 这三份是全工程的地基。
2. **AI 可造卡**：卡片是文件，agent 写完即生效，改一行热插拔。
3. **驾驶舱而非遥控器**：控制动作必须**回读**，UI 以板子真实状态为准。

## 2. 阅读顺序

```
README.md
  └─ docs/00-项目愿景.md      用户的定稿愿景
  └─ docs/02-设备事实清单.md  实测事实与踩坑（写代码前必读）
  └─ docs/04-架构设计.md      本工程的设计（Codex 撰写，待逐节确认）
  └─ docs/05-决策记录.md      已冻结的决策；想改决策先看这里
```

## 3. 硬规矩

| 规矩 | 说明 |
|---|---|
| **设计未确认不写实现** | `docs/04-架构设计.md` 逐节被用户确认之前，只允许写文档、契约、测试向量 |
| **事实要标状态** | 🟢 已核实 / 🟡 用户陈述 / 🔵 待验证。**不要把 🟡 写成 🟢** |
| **路径写绝对路径** | Windows 宿主用 `C:\...`；板端路径用 POSIX 绝对路径 |
| **别拷大文件进仓库** | SDK、固件、PDF 原书一律只记路径 |
| **旧工程只读** | `DevBoardConsole` 保留事实与理由，**不删不改**；要移植先看 `docs/03-迁移对照表.md` |
| **改决策要写 ADR** | 动 `docs/05-决策记录.md`，别在代码里默默改架构 |
| **提交前跑测试** | `npm run lint && npm run typecheck && npm test` 全绿才提交 |

## 4. 事实从哪来

- `docs/02-设备事实清单.md` —— **唯一事实源**，板子的路径、命令、坑都在那。
- 想知道「为什么这么做」，去 `docs/legacy/` 翻旧工程的设计说明。
- 用户在学习工作区（`C:\Users\Administrator\Desktop\嵌入式Linux学习`）的实测记录
  （`04-环境/环境实况.md`）是**上游来源**，但以本工程 `docs/02` 为准。

## 5. 代码规范（实现阶段生效）

| 项 | 约定 |
|---|---|
| 语言 | TypeScript `strict: true`，禁止 `any`（确需时 `unknown` + 收窄） |
| 主/渲染边界 | 设备 I/O、tag 层、action 层、卡片注册表、**MCP server** 全部在 main 进程；renderer 只画 |
| 卡片 | 跑在 sandbox iframe 里，只能通过 `postMessage` 白名单 API 触达宿主 |
| 进程/子进程 | Windows 下子进程一律 `windowsHide: true`（否则每条命令闪黑窗） |
| 测试 | vitest；纯函数（解析器、schema 校验、分级判定）必须有单测 |
| 黄金向量 | `fixtures/` 里是真机样本，解析器改动必须让向量测试保持绿 |

## 6. 别做的事

- ❌ 在实现阶段临时改 tag 契约的命名规则 → 先改 ADR 和 `docs/04`
- ❌ 让 renderer 直接碰设备（绕过 tag / action 层）
- ❌ 给卡片开后门（同源、任意 `postMessage`、直接 fs）
- ❌ 把「读取板子状态」写成一次性大脚本再解析（见事实清单：会污染 `/proc/stat`）

## 7. 常用命令（实现阶段）

```powershell
npm run dev          # electron-vite 开发模式
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run build        # 打包
```

---

*创建于 2026-11-12，由 Codex 按用户定稿愿景初始化。*