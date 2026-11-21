# DevBoard Cockpit

**给嵌入式板子做的组态软件**（SCADA / HMI）—— 位号是数据源，画面元件是卡片，组态工程师是 AI。

面向嵌入式 Linux 开发板的 Windows 桌面工作台：把板子的能力标准化成**位号**，
把可视化和操控标准化成**卡片**，把扩展标准化为 **MCP**，让宿主上的 AI agent
按需制造仪表与开关。

看着板子的实时读数、把读数和开关摆成画面、一次跑完一整件事、换一块板子不用改代码 ——
都在一个窗口里。

[English](README.en.md)

---

## 它能做什么

| 你想做的事 | 它怎么帮你 |
|---|---|
| **随时看着板子** | 板子的能力被标准化成**位号**（tag）：CPU、内存、温度、频率、NPU……不管板子是什么型号，界面上都是同一套名字 |
| **把读数和开关摆成画面** | **卡片**是一段 HTML + JavaScript：它声明自己要哪些位号、哪些权限，宿主负责取数、绘制、执行 |
| **一次做完一整件事** | **流程包**把多步操作写成一条流水线（编译 → 烧录 → 跑起来 → 看结果），可以跨机器执行 |
| **让 AI 自己长出新仪表** | **MCP**：宿主把位号、动作、卡片、流程全部开放给 agent。你说"给我一个看 NPU 负载的面板"，它就写一张卡片装上 |
| **换一块板子** | **板型包**描述这个型号有什么、从哪读、哪些动作危险。换板子不用改代码 |
| **手上没有板子** | **假板子**随安装包一起发布。没有硬件也能先把界面跑起来看，界面上会标明那是合成数据 |

## 界面

左边是**板子选择**和这块板子的连接，中间是**卡片工作台**，右边是详情与参数。
换一块板子只换左边那一个选择 —— 中间的卡片不用动。

---
## 下载安装

**只想用这个软件的人不需要装开发环境** ✓ —— 到
[Releases](https://github.com/milkytheway/DevBoardCockpit/releases) 页面下载
`DevBoardCockpit-<版本>-setup.exe` ✓（Windows x64 ✓）→ 双击安装 ✓
（可以自己选安装目录 ✓ · 会建桌面快捷方式 ✓）。

| 事项 | 说明 |
|---|---|
| **没有代码签名** ✓ | Windows SmartScreen 会拦一下 ✓ → "更多信息" → "仍要运行" ✓ |
| 校验 | 旁边有 `SHA256SUMS.txt` ✓ → 下载后可以核对 ✓ |
| 装好之后 | 第一次打开要**填板子的地址、串口** ✓（或者用向导 ✓）→ 填的值存在 `%LOCALAPPDATA%\DevBoardCockpit\` ✓（卸载不会删它 ✓） |
| 假板子 | 安装包里带着**假板子** ✓ —— 没有硬件也能先看看界面 ✓（界面里会标明那是合成数据 ✓） |

## 快速开始

前置条件：Node.js 20.19 或更高版本；Windows。**不需要编译工具** ✓ —— `node-pty` 与 `serialport` 都是 NAPI 模块 ✓，包自带的预编译二进制跨 Node / Electron 版本通用 ✓。
只有当预编译的二进制与本机对不上时 ✓，安装脚本才会去编译 ✓ —— 那时才需要 Visual Studio 生成工具（"Desktop development with C++" 工作负载 ✓）。

```bash
git clone <repository-url>
cd DevBoardCockpit
npm install
npm run dev
```

> 安装时 Electron 的二进制从 GitHub releases 下载。**下载不到时安装会直接失败并说明原因** ✓（否则要等到启动应用时报 "Electron failed to install correctly" ✗）。在墙后面时设置 `ELECTRON_MIRROR` ✓ 再 `npm rebuild electron` ✓。

构建安装包：

```bash
npm run dist
```

产物为 `release/DevBoardCockpit-0.1.0-setup.exe`。

## 连接一块板

三种传输方式各自独立配置，连接 profile 位于 `profiles/targets/`：

| 传输 | 用途 | 必填项 |
|---|---|---|
| ADB | 调试、传文件 | `serial`（板子序列号） |
| 串口 | 调试控制台 | `port`、`baudrate` |
| SSH | 远程登录 | `host`、`username`、凭据 |

`profiles/settings.json` 中的 `hostTools.adb` 指向本机的 adb 可执行文件。若未设置，应用按 `PATH` 与常见安装位置查找。

板子的默认波特率为 1500000。

应用提供**接板向导**：选择传输方式与串口参数后，向导用通用板型包（`profiles/boards/generic-linux/`）逐项探测该板，生成对应的板型包并写入用户数据目录。详见[教程](docs/tutorial/01-build-a-board-pack.zh-Hans.md)。

## 扩展

三种扩展方式，均无需修改主进程：

**卡片**是 HTML、JavaScript 与样式组成的目录，声明自己需要的位号与流程。放入用户卡片目录后热插拔生效。写卡片时遵循[卡片设计规范](docs/tutorial/03-card-design-rules.md)：一张卡一个主张，色彩只表达状态，趋势与明细归宿主详情面板。

**板型包**是 YAML 文件，声明该型号的位号来源、动作与自动识别规则。

**流程包**是 YAML 文件，声明一次多步操作如何完成，可跨机器执行。

宿主的 AI agent 通过 MCP 访问全部能力，共 20 个工具，覆盖位号读取、动作执行、卡片与流程管理。MCP 服务在应用启动时监听本地端口，端口与令牌写入用户数据目录下的 `mcp.json`，agent 读取该文件即可接入。

## 它是怎么搭的

### 构成

| 层 | 内容 | 位置 |
|---|---|---|
| 契约 | 位号词表、板型包格式、卡片清单、流程包格式、MCP 工具集 | `docs/spec/` |
| 设备事实 | ATK-DLRK3588 的实测路径与行为约束 | `docs/02-device-facts.md` |
| 实现 | Electron 主进程、卡片宿主、运行时、流程执行器、MCP 服务 | `src/` |
| 资产 | 内置卡片、板型包、流程包、连接 profile | `cards/` `profiles/` |

主进程持有全部设备 I/O、位号采集、动作执行与权限判定；渲染进程只负责绘制。卡片运行在独立 iframe 中，只能访问白名单 API。

### 仓库结构

```
docs/spec/               契约：位号词表、板型包、卡片清单、MCP 工具集、流程包
docs/tutorial/           方法论教程
docs/02-device-facts.md  实测事实
src/main/                设备 I/O、位号运行时、动作执行、卡片宿主、MCP 服务
src/renderer/            界面
src/shared/              主进程与渲染进程共用的类型与主题
cards/                   内置卡片
profiles/                板型包、流程包、连接 profile
fixtures/                真机样本（黄金测试向量，只增不改）
scripts/                 构建、校验、生成与探测工具
tests/                   单元、集成与端到端测试
```

## 开发

```bash
npm run lint          # ESLint
npm run typecheck     # TypeScript
npm test              # Vitest
npm run test:cards    # Playwright，真 Electron
npm run validate:profiles   # 校验板型包
npm run check:package       # 校验打包产物
```

测试不依赖硬件。涉及真机的路径由 `npm run probe:board -- --profile <profile>` 单独覆盖。

### 发一个版本

```bash
npm version patch        # 或者 minor / major —— 改的是 package.json 的 version
git tag v0.1.0           # 标签的版本必须和 package.json 的一样（CI 会查）
git push --follow-tags   # 推上去之后 CI 构建安装包并挂到 Releases
```

CI 会做三件事 ✓：核对标签和版本 ✓ → 构建 NSIS 安装包 ✓ → 校验产物完整（卡片、连接
profile、流程包、原生模块都在 asar 里 ✓）→ 把 `setup.exe` 和 `SHA256SUMS.txt` 挂到
那个版本的 Release 上 ✓。

本地也可以直接构建 ✓：`npm run dist` ✓ → `release/` ✓。

## 硬件依赖

部分功能需要真实硬件：

- 位号采集需要板子在线
- 串口需要独占端口，其他程序占用该端口时采集会超时
- 文件传输需要 ADB 或 SSH，串口不支持文件传输
- 部分动作会改变板子状态，包括重启

危险动作在设置中逐条开关，默认关闭。

## 文档

| 文档 | 内容 |
|---|---|
| [契约总览](docs/spec/00-overview.md) | 两条主线与各文档职责 |
| [位号契约](docs/spec/01-tag-contract.md) | 词表、命名空间、五态 |
| [板型包格式](docs/spec/02-board-pack.md) | 数据源、动作、校验规则 |
| [卡片清单](docs/spec/03-card-manifest.md) | 清单结构、权限、沙箱 |
| [MCP 工具集](docs/spec/04-mcp-tools.md) | 工具定义与返回形状 |
| [流程包格式](docs/spec/05-workflow-pack.md) | 步骤类型、角色、取消语义 |
| [设备事实](docs/02-device-facts.md) | 实测路径与行为约束 |
| [教程](docs/tutorial/01-build-a-board-pack.zh-Hans.md) | 为一块陌生的板子建立板型包 |
| [卡片设计规范](docs/tutorial/03-card-design-rules.md) | 信息预算、色彩纪律、七条硬规矩与自查表 |

## 许可

[MIT](LICENSE)
