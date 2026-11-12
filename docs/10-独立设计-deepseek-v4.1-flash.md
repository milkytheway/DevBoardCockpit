# 独立设计：开发板驾驶舱（DevBoard Cockpit）

> **作者**：deepseek V4.1 flash
> **日期**：2026-11-12
> **依据**：用户提供的《项目简报：开发板驾驶舱》（蒸馏版）——四条核心需求 + 八条已定架构事实 + 已定技术栈 + 演进顺序。
> **独立性声明**：本文从上述简报独立推导。写作时只参考了仓库的目录结构与文档命名约定（用于确定本文落位与写作规范），未展开阅读既有的 `docs/04-架构设计.md`、`docs/09-总设计.md`、`docs/spec/` 正文。本文与既有设计如有差异，属于独立推导结果，供对照，不是对既有设计的修订意见。
> **本文边界**：这是架构与契约层设计。按简报约定，沙箱内部实现细节、MCP 工具全集、评审流程、历史决策编号、安全闸门的实现参数**不在本文展开**；但会给出它们的不变量与接口边界，保证实现层有据可依。文中 🟡 表示推荐做法（实现层可调），🔵 表示待验证/待拍板；表格中的 ✅/— 表示该字段必填/可选。

---

## 速览

### 一句话设计

**一个能力内核，两套同构门面，三个数据包扩展点。**

- **能力内核**（Electron main 进程，唯一可信域）：把"板子/本地设备能观测什么、能操控什么"统一抽象为**语义 tag（读）**与**动作（写）**，并保证读到的永远带状态、写过的永远要回读。
- **两套同构门面**：面向卡片的**卡片契约**（renderer 内）与面向 AI 的 **MCP 契约**（renderer 外），共享同一份能力注册表、同一套状态语义、同一套动作语义、同一个审计口——**结构对称，授权非对称**。
- **三个数据包扩展点**：板型=YAML 包（板子可替换）、卡片=目录+manifest（画面可替换）、数据源=Source 包（采集设备可替换）。三者都"加文件即可用"，核心代码不为某个具体板/卡/设备改一行。

### 全景图

```
┌─────────────────────────────── 宿主 Windows ────────────────────────────────┐
│  AI agent（Claude Code / Codex）                                             │
│      │  MCP 总线：感知软件状态 / 读写卡片 / 触发已声明动作（destructive 需人确认）│
│      ▼                                                                      │
│  ┌───────────────────── Electron 主进程（唯一可信域）────────────────────┐  │
│  │  能力内核                                                             │  │
│  │   观测侧：Source/Reader → 语义 tag → 五态读数（tag 总线）              │  │
│  │   控制侧：动作注册表 → 执行 → 回读校验 → 审计（action 总线）           │  │
│  │  连接层：SerialConn / AdbConn / SshConn / LocalMediaSource            │  │
│  │  其它：工作区/热重载/文件互传/日志/密钥/MCP server                    │  │
│  └───────────────┬──────────────────────────────────────────────────────┘  │
│                  │  卡片契约（IPC：订阅 tag / 调 action / storage / theme） │
│  ┌───────────────▼──────── 渲染进程（呈现域，无设备 I/O）────────────────┐  │
│  │  工作台外壳：网格布局 / 终端面板 / 文件互传面板 / 目标切换 / 确认对话框 │  │
│  │  卡片运行时：iframe 沙箱 × N（manifest 授权，只拿白名单 API）           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                    板子（串口/ADB/SSH）        本地设备（USB 采集卡等）
```

### 阅读地图

| 章 | 讲什么 | 谁该读 |
|---|---|---|
| §0 | 设计前提：需求翻译、八条事实、非目标、设计原则 | 所有人 |
| §1 | 总体架构、分层规则、**两条总线对称性的完整推导**、进程与信任边界 | 所有人 |
| §2 | 连接层：统一抽象、各传输的准确分工、单链路仲裁 | 做终端/连接的人 |
| §3 | 观测总线：tag 契约、五态、采样、降级 | 做 tag/监控卡的人 |
| §4 | 控制总线：动作声明、回读闭环、危险分级 | 做控制卡/安全的人 |
| §5 | 板型包：YAML 结构、校验、新板接入 | 做板型包的人 |
| §6 | 卡片层：manifest、沙箱白名单、热插拔 | 做卡片运行时/写卡的人 |
| §7 | MCP：传输、工具面、AI 写卡回路、安全地板 | 做 AI 协作的人 |
| §8–§11 | 横切、测试、演进路线、待拍板问题 | 排计划的人 |
| 附录 A–D | 需求追踪矩阵、不变量清单、术语表、边界说明 | 评审/验收用 |

---

## 0 设计前提

### 0.1 输入：四条核心需求翻译成设计目标

| # | 原始需求 | 设计目标（可验收的表述） |
|---|---|---|
| R1 | 统一工作台：串口/ADB 接板子、SSH 接 Ubuntu 的终端 + 文件互传 | 一个窗口内可同时开 1..N 个终端、看到连接状态、管理传输队列；终端与文件传输共用同一套连接抽象，不各写一套 |
| R2 | 可插拔卡片：资源可视化，即插即用 | 把卡片目录丢进工作区 → 自动发现、校验、出现；删/改立即生效；卡片崩溃不影响外壳 |
| R3 | 卡片双向：封装指令与配置，一键改变板子行为，UI 显示**回读后的真实状态** | 动作必须声明、参数必须类型化、执行后必须回读校验；UI 不持有"我点过了"的意图真值 |
| R4 | AI 协作：宿主机 AI 可读写卡片，改完立即热插拔生效 | 卡片是文件；MCP 让 AI 能感知 GUI 状态、写/校验卡片、触发已声明动作；形成"提需求→写卡→立即可见→迭代"的闭环 |

**由 R1–R4 直接推出的三条不可动底线**：

1. **状态诚实**：任何读数不允许在无依据时显示成数字（尤其 0）。
2. **控制闭环**：控制动作的结果 = 回读到的状态，不是命令退出码，更不是界面上的开关位置。
3. **AI 无逃生舱**：AI 能做的事 = 契约声明的事；没有任何"任意命令/任意文件"的旁路。

### 0.2 输入：八条已定架构事实 = 强制约束

| # | 架构事实 | 落到本文的约束 |
|---|---|---|
| A1 | 分层单向向下：连接层 → 能力层（观测源+控制面）→ 卡片层；下层不知道上层 | §1.1 依赖规则；每层接口不出现上层概念 |
| A2 | 两条契约总线：tag 契约（卡片↔板子）、MCP 契约（AI↔GUI） | §1.3 推导两者对称性；§3、§7 分别定义 |
| A3 | 板型差异=数据包：每板一份 YAML profile，声明 tag 怎么产生、接受哪些动作 | §5 板型包设计；核心代码不含板型分支 |
| A4 | 卡片即文件：目录=manifest+视图，免构建、热重载、iframe 沙箱 | §6 卡片运行时 |
| A5 | 读数永远带状态：ok/stale/unavailable/error/pending；断连≠0 | §3.2–§3.3 读数对象与五态 |
| A6 | 动作分级：reversible/destructive；destructive 二次确认+dry-run；AI 只能触发已声明动作 | §4.5 危险地板；§7.4 MCP 安全地板 |
| A7 | 数据源独立于连接：可来自板子连接，也可来自本机 USB 采集卡等 | §2.7 + §3.8：Source 抽象与流式 tag |
| A8 | 技术栈已定：Electron+React+TS、xterm.js+node-pty、serialport、ssh2、react-grid-layout、ECharts；node-pty 需 electron-rebuild，锁 Electron 版本 | §2.2 各传输的准确分工；§8.8 原生模块与构建 |

### 0.3 非目标（本期明确不做）

- 不做真正的多用户/远程共享：这是单机桌面工具，MCP 只绑回环。
- 不做通用远程桌面/串口代理/网络调试工具（不做"另一个 VSCode"）。
- 不做卡片市场/签名分发：v1 卡片来自用户与 AI 本地写文件。
- 不做板端常驻 agent：所有能力都由宿主侧发起，板端零安装（SSH/ADB 现成通道即可）。
- 不做动态插件式 JS 能力层：能力层只认数据包（YAML/JSON）+ 内置 reader/action 编译器。

### 0.4 设计原则

| # | 原则 | 含义与理由 |
|---|---|---|
| P1 | **契约稀缺，实现可换** | 跨层只走少数几个版本化契约（tag、action、card manifest、MCP、IPC）。契约少才能稳定；实现随时可重写 |
| P2 | **单一真源在能力层** | 板子/设备的真实状态只有一份（tag 存储）；UI、卡片、AI 看到的都是它的投影，不允许任何一层自建"我记得是……"的真值副本 |
| P3 | **状态显式化** | 值必须带质量、时间、来源。未知就是未知，缺失就是缺失，失败就是失败，三者不可合并成 0 |
| P4 | **声明式扩展** | 新板=包、新卡=目录、新设备=Source 包。核心只提供解释器，不提供分支 |
| P5 | **能力最小授予** | 卡片与 AI 拿到的能力都来自显式清单（manifest / profile）；未声明的能力不可达，不存在"内部 API" |
| P6 | **物理链路一致性优先于吞吐** | 一条半双工线（串口）上采样与动作必须事务化串行；宁可降采样率，不可串台 |
| P7 | **风险优先排期** | 演进顺序由"最可能推翻架构的风险"驱动，而不是由功能好看程度驱动 |
| P8 | **可审计、可复盘** | 每次动作有审计，每次采样有诊断，每次卡片更新有版本；出问题能回答"谁在什么时候让板子做了什么" |

---

## 1 总体架构

### 1.1 分层与依赖规则

```
┌─────────────────────────────────────────────────────────────┐
│ 卡片层  card runtime（iframe）+ shell UI                     │  只消费契约，不碰设备
├─────────────────────────────────────────────────────────────┤
│ 能力层  观测源族（Source/Reader/TagEngine）                   │  只通过连接层/本地设备取数
│         控制面族（ActionRegistry/Executor/Verifier/Audit）     │
├─────────────────────────────────────────────────────────────┤
│ 连接层  Connection/Session（serial、adb、ssh、local）         │  只做字节/通道/文件，不认识 tag
└─────────────────────────────────────────────────────────────┘
        依赖方向：卡片 → 能力 → 连接（向下单向，禁止反向 import）
```

**依赖规则（可 lint 的硬规则）**：

| 规则 | 说明 |
|---|---|
| L1 | 连接层代码不得出现 `tag`、`action`、`card`、`profile` 等能力/卡片概念；只提供"打开通道、读写字节/行、执行命令、传输文件、报告连接状态" |
| L2 | 能力层不得 import 任何渲染层/Electron 渲染 API 或卡片代码；只依赖连接层接口 + 纯解析器 + 板型包解释器 |
| L3 | 卡片层不得直接 import 连接层或能力层实现；只能通过宿主注入的白名单 API（§6.3） |
| L4 | MCP server 是能力层的**第二个门面**，与卡片门面平级；不得绕过能力层直接调连接层 |
| L5 | 板型差异只允许出现在"数据 + 内置解释器"里，禁止在核心代码里 `if (board === ...)` |

### 1.2 一个内核，两套同构门面（架构总纲）

能力内核对外只暴露一份**能力模型**：

```
CapabilityModel = {
  tags:    { id, 语义, 类型, 单位, 值域 }        // 我能量测什么
  actions: { id, 参数 schema, 危险级, 回读判据 }  // 我能操控什么
  readings: Reading<T> = { value, quality, ts, source }   // 量测结果
  acts:     ActionResult = { status, intent, observed, verify }  // 操控结果
}
```

它有两个门面：

| 门面 | 谁用 | 边界 | 权限来源 |
|---|---|---|---|
| **卡片契约** | iframe 里的卡片 | renderer ↔ main 的 IPC；卡片只拿白名单 API | 卡片 manifest 声明 |
| **MCP 契约** | 宿主 AI agent | 本地回环 HTTP + token；只能调工具面 | 板型包声明 + 危险地板 + 人工确认 |

两套门面**同构**（对称性见 §1.3），但**授权面不同**（卡片更窄，AI 在写卡方向更宽，在动作方向同样受"已声明 + destructive 人确认"约束）。

### 1.3 两条总线为什么必须对称（本文的核心推导）

> 简报里被砍掉的最可惜的一段是"两条总线对称"的推导。这里补全。这一段不是文风问题，它决定了 MCP 和卡片运行时能不能各写各的。

#### 1.3.1 起点：产品里只有两类"外部作者"

- **卡片**：GUI 内部的视图/控制元件，是数据与动作的**消费端**；它的作者是人和 AI。
- **AI agent**：GUI 外部的组态工程师，是卡片的**生产端**，同时需要感知 GUI 状态来做决策。

两者都不应该、也不允许直接碰设备。设备能力必须被**归一化成唯一一份能力模型**，然后投影给它们。于是"两条总线"不是两条传输管道，而是**同一份能力模型的两个投影**：

```
                     ┌──────────── 能力模型（唯一）────────────┐
                     │  tags / readings / actions / results    │
                     └───────┬───────────────────────┬─────────┘
            内向投影（卡片契约）│                       │外向投影（MCP 契约）
                     ┌───────▼────────┐      ┌───────▼────────────┐
                     │ iframe 卡片     │      │ 宿主 AI agent      │
                     │ 读：订阅 tag    │      │ 读：get_state 等   │
                     │ 写：调 action   │      │ 写：写卡片文件/动作 │
                     └────────────────┘      └────────────────────┘
```

#### 1.3.2 对称性要求（S1–S4）

| 要求 | 内容 | 如果破坏会发生什么（真实故障模式） |
|---|---|---|
| **S1 同一份能力注册表** | 卡片能订阅的 tag 集合、能调的动作集合，与 MCP `list_tags`/`list_actions` 返回的注册表来自同一个源（板型包解释后的能力层注册表） | AI 在 MCP 里看不到某个 tag，就无法诊断卡片为什么显示异常；AI 写卡时声明的 tag 与运行时实际存在的 tag 不一致，卡片上线即失败 |
| **S2 同一套状态语义** | 两边拿到的读数都是同一个 `Reading` 结构（含五态、ts、source），不是一边数字一边对象 | AI 按"数字 0"写卡片逻辑，用户看到断连时的假 0——正好违反 A5 与 R3。这是最隐蔽也最危险的不对称 |
| **S3 同一套动作语义** | 卡片调动作与 AI 触发动作走同一个 `ActionExecutor`：同一参数校验、同一危险分级、同一回读判据、同一审计 | 两套实现必然漂移：AI 路径漏掉 dry-run 或回读，或者卡片路径能绕过确认——安全承诺变成"看走哪条路" |
| **S4 同一套错误语义** | 同一个错误码族（`TAG_*`/`ACTION_*`/`CARD_*`/`MCP_*`…），MCP 不得吞错或改写错误 | AI 无法自我纠错（拿到的错误与真实原因不同），热插拔迭代回路退化成瞎猜 |

#### 1.3.3 关键区分：结构对称，授权不对称

对称不等于等同。两条总线必须共享**类型与语义**，但**授权面必须按角色收窄**：

| 维度 | 卡片 | AI（MCP） | 说明 |
|---|---|---|---|
| 读状态 | 只能读 manifest 声明的 tag | 可读全部已注册 tag 的读数（含诊断信息） | 卡片是局部视图，AI 需要全局感知 |
| 调动作 | 只能调 manifest 声明的动作 | 可调板上全部**已声明**动作，但 destructive 必须人确认 | 两者都不可执行任意命令 |
| 写卡片文件 | ❌（卡片不能改自己） | ✅（仅工作区卡片目录内） | 这是 AI 作为"作者"的特权，也是唯一的写入口 |
| 布局 | ❌（只能报告尺寸需求） | ✅（可摆放/调整） | AI 能布置自己写的卡 |
| destructive 确认 | 由用户在 GUI 上确认 | 由用户在 GUI 上确认（AI 只能发起） | 确认人永远是人 |

**一句话**：两条总线是同一张能力模型的正面和背面；正面给画面，背面给作者；翻面靠契约，不靠第二套实现。

#### 1.3.4 每条总线内部也有读写对称

tag 总线本身是一对：

- **读侧（tag 契约）**：声明式（板型包声明怎么产生）→ 订阅式（卡片只订语义 id）→ 推送式（快照+增量）→ 状态化（五态）。
- **写侧（action 契约）**：声明式（板型包声明接受什么动作）→ 调用式（参数类型化）→ 事务式（一条连接上独占）→ 回读式（用读侧的 tag 验证写的结果）。

**写侧的真值由读侧裁决**——这是"驾驶舱而非遥控器"的架构表达：动作引擎不维护"已执行"的状态，它只负责触发和验证，最终状态永远从 tag 引擎读回。UI 因此不需要、也不允许把"我点了"当状态。

### 1.4 进程模型与信任边界

| 进程/域 | 职责 | 信任级别 | 明确禁止 |
|---|---|---|---|
| **Electron main** | 全部设备 I/O、能力内核（tag/action）、板型包解释、卡片文件监控与校验、MCP server、文件传输、日志/审计、密钥 | **可信**（但输入不可信：设备输出、YAML、卡片文件、MCP 请求都要校验） | 不做 UI 渲染；不信任任何来自 renderer/设备/card 的字符串 |
| **renderer（工作台外壳）** | React UI：布局、终端显示、传输队列、对话框、卡片宿主 | **半可信**（本工程代码，但不直接碰设备） | 不直接开串口/SSH/ADB、不读写卡片源码文件（只经 main） |
| **preload** | 唯一 IPC 表面：类型化、白名单、单次转发 | 可信代码，最小面 | 不暴露 `ipcRenderer` 原始对象、不暴露 Node API |
| **卡片 iframe** | 卡片视图代码 | **不可信**（AI/用户可写任意 JS） | 无 Node、无 fs、无网络（CSP+沙箱）、无同源存储、只能白名单 API |
| **MCP client（AI agent）** | 读状态、写卡片、触发动作 | **半可信**（同机同用户进程；能力受工具面限制） | 无任意命令、无卡片目录外文件、destructive 需人工确认 |

**信任边界图（文字版）**：

```
设备（不可信输入） → 连接层（解析/超时/大小上限） → 能力层（schema 校验/纯函数解析）
                                                    ↘ 审计日志（append-only）
renderer（本工程） ⇄ preload（白名单） ⇄ main（唯一可信域） ⇄ MCP（token + 工具白名单）
card iframe（不可信） → postMessage（能力白名单） → renderer 宿主 → main
```

### 1.5 一次完整交互的时序（把机制串起来）

**场景：用户点一张"风扇转速"控制卡的开关。**

```
[卡片] api.actions.invoke("fan.set_speed", {speed: 800})
   → [renderer 宿主] 校验 manifest 是否声明该动作（否→拒绝并报 CARD_PERMISSION_DENIED）
   → [main IPC] ActionExecutor：
        1) 参数按板型包 schema 校验（类型/范围/枚举）
        2) 危险级 = reversible → 无需人工确认；dry-run 可选
        3) 连接层事务：独占该连接 → 生成命令（参数类型编码，非字符串拼接）→ 发送
        4) 读取侧：等 verify 声明的 tag 读数（如 fan.rpm）在稳定窗口内落在容差内
        5) 写审计日志
   ← ActionResult { status: "applied", intent: {speed:800}, observed: Reading(fan.rpm, ok, 812) }
[renderer 宿主] 把 result 广播给卡片
[卡片] 重绘：开关位置以 observed 为准；若 verify.mismatch → 显示"已下发但回读不符：期望 800，实际 812"并保持实际值
[tag 引擎] 后续 fan.rpm 采样继续推送 → 卡片持续跟随真实值（不是按钮自己的状态）
```

**反例（本设计明确禁止）**：点击开关 → 本地把开关打勾 → 发命令 → 不读回 → 显示"已开启"。这就是"遥控器"，不是"驾驶舱"。

## 2 连接层

### 2.1 统一抽象：Target / Connection / Channel

先把三个容易混淆的概念钉死：

| 概念 | 是什么 | 生命周期 | 存放 |
|---|---|---|---|
| **TargetProfile** | 怎么连一个目标的配置（传输类型、串口参数、主机地址、绑定哪份板型包、角色） | 持久化配置 | 用户配置目录（机器相关，不进 git） |
| **Connection** | 按 profile 建立的运行时连接：状态机、健康度、能力集 | connect → ready → … → close | 内存，main 进程 |
| **Channel** | 连接上的一种能力通道：`exec`（一次性命令）、`terminal`（双向字节流）、`file`（列目录/传输） | 随 Connection | 内存，main 进程 |

**统一接口（设计级 TypeScript 签名，实现可细化）**：

```ts
type TargetId = string;                      // 如 "board-serial" / "ubuntu-ssh" / "capture-usb"
type ConnectionState = 'disconnected' | 'connecting' | 'ready' | 'degraded' | 'error';

interface Connection {
  readonly id: TargetId;
  readonly role: 'board' | 'host' | 'local';
  state: ConnectionState;
  capabilities: ReadonlySet<'exec' | 'terminal' | 'file' | 'media'>;
  open(): Promise<void>;
  close(reason?: string): Promise<void>;
  onState(cb: (state: ConnectionState, reason?: string) => void): Unsubscribe;
}

interface ExecChannel {
  // argv 数组，不经 shell 拼接；timeout 必填；输出有大小上限
  exec(req: {
    argv: string[];
    timeoutMs: number;
    stdin?: Uint8Array;
    maxOutputBytes?: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
}

interface TerminalChannel {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: Uint8Array) => void): Unsubscribe;
}

interface FileChannel {
  list(remotePath: string): Promise<FileEntry[]>;
  download(remotePath: string, localPath: string, opts: TransferOpts): Promise<TransferResult>;
  upload(localPath: string, remotePath: string, opts: TransferOpts): Promise<TransferResult>;
}
```

**能力矩阵**：

| 传输 | terminal | exec | file | 备注 |
|---|---|---|---|---|
| 串口（serialport） | ✅ | ⚠️ 独占模式（默认关） | ❌ | 一根半双工线，终端与采样互斥（§2.4） |
| ADB（adb CLI） | ✅（`adb shell`） | ✅（`adb exec-out`） | ✅（`adb push/pull`） | 板子侧零安装，开发板标配 |
| SSH（ssh2） | ✅（shell channel） | ✅（exec channel） | ✅（SFTP） | Ubuntu 虚拟机；板子有网也可用 |
| 本地设备（LocalSource） | ❌ | ❌ | ❌ | 不是"连接"，走 Source 抽象（§2.7） |

**决定**：能力通道与终端通道是**逻辑上不同的会话**。SSH/ADB 上二者并发互不干扰；串口上共享物理线路，必须仲裁。

### 2.2 技术栈的准确分工（简报里没展开、但做错就返工的部分）

| 库 | **只**用于 | **不**用于 | 理由 |
|---|---|---|---|
| `serialport` | 串口裸字节流 + 波特率/数据位/校验/流控 | 不负责终端渲染、不解析板端 shell | 串口没有"通道"概念，只有字节 |
| `ssh2` | SSH 的 shell / exec / SFTP | 不用 node-pty 包 SSH | ssh2 自带通道与流控；node-pty 只能生成本地进程 |
| `adb` CLI（`child_process`，`windowsHide: true`） | ADB 的 shell/exec-out/push/pull | 不自研 ADB 协议 | 栈里没有 ADB 库；CLI 是稳定接口，`windowsHide` 防黑窗 |
| `node-pty` | **本地**宿主 shell（可选），以及需要一个真 TTY 才正常的本地命令（如包一层 `adb shell` 做交互终端） | 不用于 SSH/串口数据通路 | node-pty = 本地伪终端；远程/硬件流各归各库 |
| `xterm.js` | 所有终端会话的渲染与输入（本地/serial/adb/ssh 统一） | 不处理连接 | 渲染层与传输层解耦 |

**ADB 交互终端的两个实现选择**：

- 方案 A：`child_process.spawn('adb', ['-s', serial, 'shell'])`，stdin/stdout 直连 xterm。简单，但 Windows 下非 TTY，颜色/行编辑可能异常。
- 方案 B：`node-pty.spawn('adb', ['-s', serial, 'shell'])`，拿到 ConPTY，交互体验接近真终端。**推荐 B**（也正是简报点名的 node-pty 用途之一）。

**已知坑的工程化对策**（简报点名）：node-pty 必须按 Electron ABI 重新编译；锁定 Electron 版本并写入构建脚本；CI 加一条"启动即加载 node-pty/serialport 并握手"的冒烟测试，防止升级 Electron 时静默崩。

### 2.3 连接生命周期状态机

```
                    open()                 probe 通过
  disconnected ─────────────▶ connecting ─────────────▶ ready
       ▲                          │  失败                  │  ▲
       │                          ▼                        │  │ 恢复
       │                        error ◀─── 连续失败/超时 ── degraded
       │                          │                        │
       └──────── close() ─────────┴────────────────────────┘
```

| 状态 | 判定 | 对外表现 |
|---|---|---|
| `disconnected` | 未连接 / 已断开 | 终端不可用；tag 走降级（§3.6）；动作不可用 |
| `connecting` | 正在建链/认证 | 显示"连接中"；可取消 |
| `ready` | **最小能力探针通过**（exec 探针或终端 echo 成功），不是"TCP 已连上" | 能力可用 |
| `degraded` | 链路在但质量差：连续 N 次超时/错误、延迟超阈值 | 采样降频、动作仍可试、UI 明确标黄 |
| `error` | 认证失败/端口被占/设备未授权/主机不可达 | 显示可读原因 + 重试按钮；自动重连按退避 |

**规则**：

- `ready` 的判定必须做**能力探针**（一次轻量 exec，如 `true`/`echo ok`），避免"端口开了 = 能力可用"的假就绪。
- 自动重连：指数退避 1s→2s→…→30s（±20% 抖动）；用户手动重试立即触发；重连成功恢复采样。
- ADB 特有状态要原样呈现：`unauthorized`（设备未授权调试）、`offline`、`no devices`——引导用户去板子点授权，不显示成"未知错误"。
- 连接状态变化是 tag 质量传播和动作可用性的**唯一**驱动源（§3.6、§4.4）。

### 2.4 单链路事务仲裁（串口只有一根线）

**问题**：串口是半双工单链路。若采样命令、动作命令、用户终端输入交错写入，轻则回显串台，重则把板子 shell 搞坏。这不是"并发优化"问题，是正确性问题。

**设计：每个 Connection 一个 `LinkArbiter`，把对该物理链路的所有访问变成事务。**

```
事务队列（按优先级，同级 FIFO）：
  1. action-verify      动作执行+回读作为一个不可拆分事务
  2. manual-refresh     用户手动刷新 / MCP 显式 refresh
  3. card-sampling      卡片订阅驱动的周期采样（按 reader 合并批读）
  4. diagnostics        连接健康探针、后台诊断
```

- **动作事务**：执行命令 + 回读必须落在同一个独占窗口内，中间不允许插入采样命令——否则回读可能读到采样竞争导致的乱序输出。窗口内允许 executor 触发一次"单次读"，该读数照常写回 tag 引擎（UI 与 AI 看到的仍是同一条 tag 总线，不是旁路副本）。
- **终端独占**：用户在串口终端里活跃输入时，managed 采样暂停（相关 tag 变 `stale`，UI 明确显示"采样暂停：串口被终端占用"）；用户切走或空闲 N 秒后恢复。**串口默认仅终端**；只有板型包显式声明且用户开启"串口独占管理模式"时，才允许在该串口上采样/动作（此时终端不可用，二者互斥，UI 必须显著提示）。
- **并发上限**：SSH/ADB 的 exec 并发上限 2/连接（terminal 通道不占额度），串口 1。
- **超时与背压**：每事务必带 deadline（连接级默认 3s，板型包可覆盖）；排队等待超时返回 `CONN_BUSY`（可重试、结构化）；队列有上限，满则拒绝新采样请求并降级，不允许无界堆积。
- **禁止嵌套命令**：一条命令内不得包含需要交互/分页/需要 tty 的操作（如 `top`），reader 必须用一次性快照命令（如 `cat /proc/stat`）。

### 2.5 终端

| 维度 | 设计 |
|---|---|
| 会话类型 | 本地 shell（可选）、串口 console、ADB shell、SSH shell；统一 `TerminalSession` 接口 |
| 渲染 | 每个会话一个 xterm.js 实例；工作台里以标签页/停靠面板组织，不放进卡片网格（终端是特权面板，不是沙箱卡片） |
| 数据通路 | main 的通道 → IPC（二进制、按帧合并）→ renderer 的 xterm；**背压**：renderer 写队列超阈值时暂停源读取，绝不无界缓冲 |
| 输入 | xterm 键盘 → 通道 write；支持粘贴（用户手势触发）、resize（pty / SSH window-change） |
| 断线 | 显示"已断开 + 原因 + 重连按钮"；保留最近 N 行缓冲（只读）；**不自动重放用户输入** |
| 编码 | UTF-8；串口原始字节直通；非法序列以替换符显示，不崩 |
| 安全 | 终端输出视为不可信文本，禁止把 ANSI/OSC 序列解释为宿主动作（如 OSC 52 剪贴板写入默认关闭） |

### 2.6 文件互传

**任务模型**：

```ts
interface TransferTask {
  id: string;
  targetId: TargetId;
  direction: 'upload' | 'download';
  srcPath: string;             // Windows 侧或远端侧按 direction 解释
  dstPath: string;
  state: 'queued' | 'running' | 'verifying' | 'done' | 'failed' | 'cancelled';
  bytesTotal?: number;
  bytesDone: number;
  error?: AppError;
}
```

**通道映射**：SSH → SFTP（2 并发/目标）；ADB → `adb push/pull`（1 并发/目标，避免设备端 I/O 争抢）；串口 → 不支持文件（不做 xmodem/zmodem，本期）。Windows ↔ Ubuntu、Windows ↔ 板子两条主线都由"目标角色的 FileChannel"覆盖；未来板子 ↔ 虚拟机可由 main 侧中转（两通道对接），模型天然支持。

**规则**：

- 进度按 ~100ms 节流上报，不刷爆 IPC；速度/ETA 由 renderer 算。
- 取消：SFTP 关闭流；ADB 杀掉子进程并清理残留。取消后不留半文件（远端临时名→完成后 rename 的策略，实现层选型）。
- 冲突：默认询问（覆盖/跳过/重命名），可记住本次会话策略；不允许静默覆盖。
- 路径：Windows 长路径/盘符/UNC 统一走封装的文件系统工具；远端路径只做"用户显式给出"的绝对路径，不跟随符号链接越界（远端本来就是用户自己的设备，主要防手滑）。
- 校验：v1 校验大小 + 通道成功状态；哈希校验作为增强（远端不一定有 md5sum，不强依赖）。
- UI：双栏浏览 + 拖拽入队 + 队列面板；v1 不做完整文件管理器。

### 2.7 本地数据源（数据源独立于连接）

**决定**：`Source` 是能力层概念，不是连接层概念。Source 有三种：

| Source 类型 | 数据从哪来 | 例子 |
|---|---|---|
| `BoardSource` | 经由某个 board 角色的 Connection（exec/file） | RK3588 的 `/proc/stat`、`/sys/class/thermal/*` |
| `LocalSource` | Windows 本地设备/系统 API | USB HDMI 采集卡、本机摄像头、本机系统指标 |
| `ComputedSource`（预留） | 由其它 tag 计算/聚合 | 速率、差值、告警状态；v1 不做，但接口留好 |

- 三种 Source 对卡片完全等价：卡片只订阅 tag，不感知来源。`Reading.source` 只用于诊断面板。
- 本地 Source 的生命周期/健康/降级语义与板端一致：没有采集卡 = 其 tag 为 `unavailable`，不是 0。
- 媒体类来源不把帧塞进标量 tag（§3.8）：状态用普通 tag 表达，帧走媒体通道。

## 3 观测能力：tag 总线

### 3.1 语义位号（Tag）

**定义**：tag 是"板子/设备能观测什么"的**语义名**，稳定、与板型无关、与传输无关。卡片只订语义名，板型包负责把它映射到具体命令/文件/设备。

| 规则 | 内容 | 反例 |
|---|---|---|
| 命名 | 小写点分，`<域>.<名>`，全局唯一 | ❌ `boardA_cpu`、❌ `COM5.cpu`、❌ `rk3588.cpu` |
| 单位 | 归一化到词表规定的基准单位（百分比 0–100、字节、字节/秒、摄氏度、MHz、RPM…） | ❌ 一处 `KB` 一处 `bytes` |
| 类型 | `number` / `integer` / `boolean` / `enum` / `string` / `stream`（§3.8） | ❌ 用 `string` 传数字 |
| 值域 | 词表声明合法范围/枚举字面量；越界视为解析错误，不夹紧 | ❌ 温度读成 999 还照显示 |
| 稳定性 | tag 语义一旦发布不轻易改；改语义 = 新 tag + 词表升版本 | ❌ 让同一个 tag 在不同板上一会儿是 MHz 一会儿是 GHz |
| 扩展 | 核心词表之外，板型可加命名空间私有 tag（如 `x.vendor.fan.mode`），卡片需显式声明才可用 | ❌ 把私有语义混进 `cpu.*` |

**词表治理（单源）**：中央词表是一份机器可读的 YAML（含 id、类型、单位、值域、语义说明、默认 staleAfter）；板型包只能引用它或声明带命名空间的私有 tag。卡片 manifest 声明的 tag、MCP 返回的 tag、校验器检查的 tag，都以这一份为准。

**起步核心词表（示例，非最终）**：

| 组 | tag 示例 |
|---|---|
| CPU | `cpu.usage`（%）、`cpu.freq`（MHz）、`cpu.temp`（°C） |
| 内存 | `mem.used`（B）、`mem.total`（B）、`mem.usage`（%） |
| 磁盘/网络 | `disk.usage`（%，按挂载点扩展为 `disk.usage.root`）、`net.rx`/`net.tx`（B/s） |
| 热/电 | `thermal.soc`（°C）、`power.voltage`（V） |
| 视频/NPU | `video.pipeline`（enum：`idle`/`npu-attached`/`error`）、`npu.usage`（%）、`camera.capture.fps`（number）、`camera.capture.state`（enum） |
| 板级 | `board.uptime`（s）、`board.kernel`（string，展示用） |

### 3.2 读数对象（Reading）

**值 ≠ 数字。值是一个带状态的记录。** 这是全系统最重要的数据结构：

```ts
type Quality = 'ok' | 'stale' | 'unavailable' | 'error' | 'pending';

interface Reading<T = number | string | boolean> {
  targetId: TargetId;     // 哪个目标
  tag: TagId;             // 语义位号
  value: T | null;        // 非 ok 时可为 null；stale/error 可保留 last-known
  quality: Quality;
  ts: number;             // 宿主记录状态的时刻（单调时钟 + 墙上时间）
  valueTs?: number;       // 设备侧观测时刻（协议能提供就带，用于诊断）
  source: SourceId;       // 哪个 Source 产生（诊断用）
  reason?: string;        // 非 ok 的机器可读原因码（如 CONN_LOST / PARSE_ERROR / OUT_OF_DOMAIN）
  seq: number;            // 同一 tag 单调递增，用于去重与排序
}
```

**硬规则**：

- `ok` ⇒ `value !== null` 且落在词表值域内。
- `unavailable` ⇒ **必须** `value === null`（不允许携带"上次的值"混进去）。
- `stale` / `error` 可携带 last-known value，但卡片 API 上质量可见，UI 必须按质量降级渲染。
- 读数**不跨应用重启持久化**：启动即 `unavailable`，首读成功才 `ok`。宁可空白，不可拿上次会话的旧数字冒充现状。
- `ts` 与 `seq` 由 tag 引擎统一打，卡片/UI/AI 不得改写。
- 每个 tag 在同一 target 内只有一条当前读数（last-value 模型）；历史趋势由渲染层/卡片自己按需缓存，宿主不背历史库。

### 3.3 五态：定义、迁移、不变量

| 状态 | 含义 | value | 典型触发 | UI 应该怎么画 |
|---|---|---|---|---|
| `ok` | 新鲜且可信 | 有 | 采样成功且未超 TTL | 正常数值/图 |
| `pending` | 正在建立第一次读数（或刚重连后首读中） | 无 | 首次订阅、重连成功、目标刚 ready | 占位骨架/转圈，**不显示 0** |
| `stale` | 有历史值，但已超过新鲜期，原因不明/暂未失败 | 可留 last-known | 超 `staleAfter` 未更新；连接降级；串口被终端占用 | 灰显数值 + "已过期"标记；趋势图断线 |
| `error` | 明确读取失败 | 可留 last-known | 命令超时/非零退出、解析失败、值域越界、通道错误 | 错误标记 + 原因码；不得用正常样式显示数值 |
| `unavailable` | 没有可用的值/能力 | **无** | 未连接、板型不支持该 tag、源未接入、断开超过宽限、被禁用 | "不可用/未连接"占位；**绝不显示 0** |

**迁移图（事件驱动）**：

```
                         attach + 首次订阅
  unavailable ────────────────────────────▶ pending
       ▲                                       │ 首读成功
       │                                       ▼
       │                                   ok ──────────────┐
       │                                    │  │             │ 超 staleAfter 仍未更新
       │ 源断开/标记不支持/长时间不可恢复      │  │ 读失败      ▼
       ├────────────────────────────────────┘  └────────▶ error ──读成功──▶ ok
       │                                                    │
       │                                                    │ 连续失败超宽限/源断开
       └────────────────────────────────────────────────────┘（→ unavailable）
```

**迁移规则表**：

| 事件 | 从 | 到 | 备注 |
|---|---|---|---|
| 目标 ready + 首个订阅者 | unavailable | pending | 触发首读 |
| reader 成功且解析合法 | pending / error / stale | ok | 更新 value/ts/seq |
| reader 超时、非零退出、解析失败、值域越界 | ok / pending / stale | error | 保留 last-known，带 reason |
| 超过 `staleAfter` 无新值（无明确失败） | ok | stale | 如 push 型/事件型 tag、连接 pending 重连 |
| 连接断开 | 任意 | stale（宽限期 ≤3s）→ unavailable | 先灰显 last-known 让用户有上下文，宽限后清值 |
| 连接恢复 | unavailable | pending | 首读成功后回 ok |
| 板型包不提供该 tag | 任意 | unavailable（reason=`NOT_SUPPORTED`） | 卡片 manifest 校验期就会警告 |
| 目标/源被用户禁用 | 任意 | unavailable | — |

**不变量（实现必须测）**：

- **I1 非 ok 不得以正常数值样式呈现**：所有卡片应统一用宿主提供的质量占位组件；趋势图在非 ok 区间必须断线，不得插值造假。
- **I2 `unavailable` 不携带 value**；`ok` 必带 value；`stale`/`error` 带不带 last-known 由引擎决定，但质量必须能区分"有没有旧值"。
- **I3 质量只由 tag 引擎产生**，卡片/UI/MCP 不得改写。
- **I4 断开后必须离开 `ok`**：最迟一个 `staleAfter` 内；不允许"断连还在显示绿色 42%"。
- **I5 `0` 是合法值但只在 `ok` 下合法**：`unavailable` 被渲染成 0 属于 P0 缺陷。
- **I6 同一 tag 的 `seq` 单调递增**，渲染层可按 seq 丢弃乱序帧。

### 3.4 采样调度（Reader 级，不是 tag 级）

**数据结构**：采样单位是 **Reader**——一次板端往返，产出 1..N 个 tag。

```yaml
readers:
  - id: sys-cpu-mem
    kind: shell_snapshot          # 内置 reader 类型（见 §5.3）
    interval: 1000ms              # 期望周期
    timeout: 1500ms
    staleAfter: 4000ms            # ≥ 3 × interval
    cost: 1                       # 相对代价，用于预算
    parse: builtin/proc-snapshot@1  # 纯函数解析器
    produces: [cpu.usage, mem.used, mem.total, cpu.freq]
```

**调度规则**：

- **批读优先**：能一次命令/一次文件读产出的 tag 必须合并成一个 reader；禁止"一个 tag 一次往返"（对半双工串口是自杀，对 SSH 也是浪费）。
- **兴趣驱动**：只有被订阅（卡片/外壳面板/MCP 显式 refresh）的 tag 才驱动 reader；最后一个订阅者离开后停采（`resident: true` 的 reader 除外，比如连接健康探针）。卡片不可见时降频或暂停。
- **稳定节拍 + 抖动**：同一连接上的 reader 按到期时间排入主机事务队列（§2.4），相差 <50ms 的合并为一轮批处理；周期加 ±10% 抖动，避免多板同频共振。
- **不重入**：上一轮未完成不发起下一轮（跳过并累计 drift）；连续跳过会体现在 `stale`。
- **失败退避**：连续失败按 2^n × interval 退避，上限 30s；成功后恢复。连续失败达到阈值 → 连接进入 `degraded`。
- **预算**：连接级每分钟事务数上限（板型包可声明）；动作优先级高于采样，动作密集时采样降频——这是有意的取舍，质量状态会如实反映。
- **手动刷新**：用户点刷新 / MCP `read_tags(refresh:true)` 会插队一次，500ms 内的重复请求合并。
- **单次采样上限**：单 reader 输出大小有上限（默认 256KB），超限视为解析错误，防止板子输出失控把内存打爆。

### 3.5 订阅与分发

```
tag 引擎（main）
  ├─ 状态：Map<TagId, Reading>（每 target 一份）
  ├─ 订阅表：谁要哪些 tag（卡片实例 / 外壳面板 / MCP 按需）
  └─ 变更流：{tag, reading} 增量 → 16ms 合帧 → IPC → renderer → 按卡片白名单过滤 → iframe
```

- **快照 + 增量**：新订阅者先收全量快照（只含声明过的 tag），之后收增量。
- **合帧**：16ms 一批；同一 tag 一帧内只保留最新 reading，但**质量迁移事件不可被合掉**（同一帧内携带最终质量即可，不得让 UI 错过 ok→error）。
- **背压**：renderer 卡顿/iframe 忙 → 丢弃中间帧、保留最新状态与质量变化；不阻塞采样事务。
- **租约**：`subscribe()` 返回 unsubscribe；卡片卸载/iframe 销毁/被禁言时立即释放；宿主持有引用防泄漏。
- **频率合并**：多个卡片订阅同一 tag 不增加采样频率。
- **MCP 侧**：v1 采用**拉模式**（`get_state` / `read_tags` 返回当前快照），不做服务端推送——降低 MCP 传输复杂度；AI 需要"变化"时轮询即可，动作结果按 requestId 查询。

### 3.6 质量传播（降级矩阵）

| 触发事件 | 受影响 tag | 结果 |
|---|---|---|
| target profile 未绑定板型包 | 该 target 全部 | `unavailable`（reason=`NO_BOARD_PROFILE`） |
| 板型包不产生该 tag | 该 tag | `unavailable`（`NOT_SUPPORTED`），卡片加载时校验期就提示 |
| 连接断开 | 该 target 全部 | `stale`（宽限 ≤3s）→ `unavailable` |
| 连接 degraded | 该 target 全部 | `stale`（保留旧值灰显），恢复后回 `ok` |
| reader 命令超时/非零退出 | 该 reader 的 produces | `error`（`READ_FAILED`/`TIMEOUT`） |
| 解析失败/值域越界 | 该 reader 的 produces | `error`（`PARSE_ERROR`/`OUT_OF_DOMAIN`） |
| 超过 staleAfter 未更新 | 该 tag | `stale` |
| 首次订阅 / 重连 | 该 tag | `pending` |
| 卡片订阅未声明的 tag | — | 宿主拒绝订阅（`CARD_PERMISSION_DENIED`），质量状态不变 |
| 串口被终端占用 | 该串口 reader 的 tag | `stale`（reason=`LINK_BUSY_TERMINAL`） |

### 3.7 多目标命名空间（单板 v1，为多板留好）

- 内部 key：`${targetId}/${tag}`（如 `board-serial/cpu.usage`）。
- 卡片 API 默认在"活动目标"语境下用裸 tag id；manifest 可写 `"target": "active"`（默认）或显式 `"<targetId>"`。
- v1 同时可连接：1 块板（role=board）+ 1 台 Ubuntu（role=host）+ N 个本地 Source；板卡绑定默认跟随"活动板"。
- "多板管理"是演进第 7 步：届时同一 handler 可绑定多个 board target，UI 加目标选择器即可，契约不用改（因为 key 里已经有 targetId）。
- 目标角色（board/host/local）决定它能承载什么能力：board 才能绑板型包；host 只有终端+文件；local 只有 Source。

### 3.8 流式 tag（媒体）与状态分离

视频帧/HDMI 采集画面不塞进标量表：

| 层 | 表达 |
|---|---|
| 标量 tag | `camera.capture.state`（enum：`streaming`/`pending`/`error`/`unavailable`）、`camera.capture.fps`（number）、`camera.capture.resolution`（string）——**状态与元数据仍走五态** |
| 媒体通道 | 帧数据走独立 `MediaStream`：main 的 Source → renderer → 卡片句柄（ImageBitmap/帧消息），带 fps/尺寸协商与丢帧策略 |
| 卡片 API | `api.media.open(streamId, {fps, maxWidth})` → 句柄；`onFrame` 回调；`close()` |

**为什么分开**：五态回答"这个值新不新鲜、可不可信"；帧流回答"画面有没有在动"。混在一起会让语义失真（帧率抖动不等于数据不可信）。**但"画面不在动"必须能被状态 tag 表达**——卡片显示占位/错误，不允许拿黑帧冒充在线。

本地 HDMI 采集卡（A7）就是这套模型的第一个实例：Source 在 Windows 本地，帧走媒体通道，状态走普通 tag，卡片完全不感知"这不是板子来的数据"。

---

## 4 控制能力：action 总线

### 4.1 动作声明（在板型包里，不在卡片里）

动作是板子"接受哪些操控"的声明，字段设计（详见 §5.4）：

```yaml
actions:
  - id: fan.set_speed
    label: 风扇转速
    danger: reversible              # reversible | destructive（只有两档）
    params:
      speed: { type: integer, min: 0, max: 255, unit: rpm }
    command:
      argv: ["sh", "-c", "echo {speed} > /sys/class/hwmon/hwmon0/pwm1"]
      encodes: { speed: decimal }   # 参数按类型编码，不做字符串拼接
    verify:                         # 回读判据：用观测侧 tag 裁决
      tag: fan.rpm
      expect: { from: param, name: speed, tolerance: 0.10 }   # 800→[720,880]
      within: 3s                    # 稳定窗口
      samples: 2                    # 连续 2 个读数满足才算通过
    dryRun: { supported: true, argv: ["sh", "-c", "cat /sys/.../pwm1"] }
    idempotent: true
```

**规则**：

- 动作 id 稳定、语义化；卡片 manifest 只能引用动作 id，不能自带命令。
- 参数必须类型化（integer/number/boolean/enum/string），带范围/枚举约束；**命令构造只接受参数值，不接受命令片段**。
- 每个动作**必须**声明 `verify`（或显式声明 `verify: none` 并写明理由——仅限纯展示类动作，如点亮 LED；执行结果会标 `unverified`）。
- destructive 动作**必须**支持 dry-run（能预览将执行的命令与预期变化）。

### 4.2 动作调用协议

```ts
interface ActionRequest {
  requestId: string;              // 调用方生成，去重用
  targetId: TargetId;
  actionId: ActionId;
  params: Record<string, JsonValue>;
  dryRun?: boolean;               // destructive 默认要求先 dryRun
}

interface ActionResult {
  requestId: string;
  status: 'applied' | 'mismatch' | 'failed' | 'rejected' | 'timed_out'
        | 'approval_required' | 'dry_run';
  origin: 'ui' | 'card' | 'mcp';  // 审计与权限判定用
  intent: { actionId: ActionId; params: Record<string, JsonValue> };
  observed?: Reading[];           // 回读到的真实值
  verify?: { passed: boolean; expected?: unknown; actual?: unknown; reason?: string };
  approvalId?: string;            // destructive：人工确认凭据
  error?: AppError;
  startedAt: number;
  finishedAt: number;
}
```

- 调用是**异步+有 deadline** 的；UI 在 `pending` 状态显示"执行中"，不做乐观更新。
- 长动作（>30s）返回 `accepted` + `requestId`，之后可用 `getActionResult(requestId)` 查询（MCP 也走这条）。
- `requestId` 幂等：同一 requestId 重放返回同一结果，不重复执行。

### 4.3 回读闭环：intent ≠ truth

**这是"驾驶舱而非遥控器"的机制核心。**

```
参数校验 → 危险判定/确认 → 生成命令 → 独占事务执行
    → 回读（verify 声明的 tag，来自 tag 总线）→ 稳定窗口判定
    → 写审计 → 返回 {status, intent, observed, verify}
    → UI/卡片按 observed 显示；tag 引擎后续持续推送真实值
```

- **回读必须用观测总线**，不是命令退出码：`exitCode === 0` 只证明"命令被接受了"，不证明状态已变（板端脚本吞错、驱动假成功、命令被 shell 解释错，都会 exit 0）。
- **稳定窗口**：默认连续 2 个采样周期满足判据才算 `applied`；只满足一次就报成功会被抖动骗。
- **`mismatch` 不是失败**：命令可能部分生效。UI 必须展示"期望 vs 实际"并保留实际值，不能回滚界面状态假装没点过。允许用户据此再次调整。
- **UI 不持有真值副本**：控制卡的开关位置必须由 `observed` 驱动；执行期间只允许一个临时的 `pending` 视觉，不允许把开关先翻过去。
- 回读 tag 必须在同一 target 的观测侧存在且可见；若板型包声明了 verify 却没产生对应 tag，**校验器直接拒绝该板型包**（堵住"永远无法验证"的动作）。

### 4.4 动作生命周期

```
requested → validating → (destructive: dry_run → approval_required → 等待人工)
    → dispatched → executing → awaiting_verify → applied
                          │         │
                          │         ├─ verify 不符 → mismatch
                          │         ├─ 超时        → timed_out
                          │         └─ 通道错误     → failed
                          └─ 参数/权限错误 → rejected
```

| 状态 | UI 表现 |
|---|---|
| `pending`（调用中） | 控件禁用/转圈，显示"执行中" |
| `applied` | 控件落到回读值，提示"已生效（回读确认）" |
| `mismatch` | 显示实际值 + 期望值差异，黄色警示，允许再调 |
| `timed_out` / `failed` | 红色错误 + 原因码 + 重试按钮；界面回到回读值（不是"我点过"的状态） |
| `rejected` | 错误提示（参数/权限/危险未确认） |
| `approval_required` | 弹出确认对话框（destructive） |
| `dry_run` | 展示命令预览+预期变化，等待确认 |

### 4.5 安全分级与"危险地板"

**只有两档**（不引入更多级别，避免实现层各自解释）：

| 档 | 定义 | 例子 | 要求 |
|---|---|---|---|
| `reversible` | 执行后可通过再次执行撤销/恢复，且不会造成不可逆影响 | 风扇调速、采样率、LED 亮度、挂载/卸载 NPU 到视频链路（可卸） | 正常调用；建议但非必须 dry-run |
| `destructive` | 可能造成不可逆后果或中断关键功能 | 关服务、重启板子、删除文件、改分区/时钟/供电、把板子设成不可达 | **必须** support dry-run + **人工二次确认** + 审计 |

**危险地板（任何上层都不能绕过的硬不变量，由 main 强制执行）**：

1. **D1 无任意命令**：ActionExecutor 只执行从板型包模板生成、参数经类型编码的命令；不存在接收任意字符串命令的 API。
2. **D2 destructive 必须有人确认**：确认只能由用户在 GUI 点击产生（一次性 approval token，绑定 actionId+params+targetId+TTL）；card 和 MCP 都只能"发起"，不能"确认"。MCP 调用 destructive 返回 `approval_required` + 待确认提示，GUI 弹窗确认后执行。
3. **D3 dry-run 先行**：destructive 的第一次调用默认 dryRun（或强制调用方先 dryRun），审批界面必须展示 dry-run 结果；dry-run 不得产生副作用。
4. **D4 回读裁决**：动作成功与否不由调用方声明，只由 verify 回读裁决（I1–I6 同等严格）。
5. **D5 审计不可绕过**：每次动作（含 dry-run、失败、被拒、人工确认人/时间）写 append-only 审计日志；日志写入失败时动作仍执行但界面提示审计异常（或者：审计失败则拒绝 destructive——推荐后者，实现层定）。

**权限模型（三道闸门）**：

```
卡片调用   ：manifest 声明动作 → renderer 宿主校验 → main ActionExecutor 二次校验 → 危险地板
AI 调用    ：MCP 工具白名单 → 只允许 registry 内动作 → 危险地板（destructive 需人工确认）
用户直接调用：GUI 控件 → main → 危险地板（destructive 弹确认）
```

### 4.6 参数与命令构造

- 参数先按 schema 校验（类型、范围、枚举、字符串长度上限）。
- 命令模板由板型包提供，占位符只能出现在"值位置"；编码器按类型输出（数字十进制、布尔 0/1、枚举字面量白名单、字符串 shell-escape 且长度受限）。
- **禁止**把任何参数拼进命令的"结构位置"（如 ${cmd}、"$(...)"、路径拼接）；模板在加载时静态校验占位符语法。
- 参数值含空格/引号/控制字符 → 按类型编码；字符串型参数的域由板型包声明（如只允许 `^[a-zA-Z0-9_-]{1,32}$`）。
- 每个动作的参数快照进审计日志（敏感值如密码类参数由 schema 标记 `secret`，日志脱敏；板型包不应把密码作为动作参数）。

### 4.7 并发、幂等与取消

- 同一 target 上动作串行（尤其串口）；不同 target 可并行。
- `requestId` 幂等；重复请求返回缓存结果。
- 取消：执行前可取消（队列中）；执行中只支持"尽力取消"（把结果标为 `cancelled`，但必须回读确认最终状态；destructive 不允许取消语义）。
- 超时：连接级 deadline；超时后动作标记 `timed_out`，但**仍要尽量回读**并展示实际状态（避免"超时但已生效"的黑箱）。
- 动作与采样的冲突由 LinkArbiter（§2.4）处理；动作期间采样降频属于正常降级。

### 4.8 一张控制卡的完整走查（示例）

**需求**：卡片上有个"NPU 挂到视频链路"开关。

1. manifest 声明：`actions: ["video.attach_npu"]`；tag 订阅 `video.pipeline`、`npu.usage`。
2. 卡片读 `video.pipeline` 当前为 `idle`（ok）→ 开关显示"关"。
3. 用户点击 → `api.actions.invoke('video.attach_npu', {enable: true})`。
4. main：reversible → 参数校验 → LinkArbiter 抢占独占窗口 → 执行 `video-daemon attach --npu 0` → 回读 `video.pipeline`。
5. 回读在 2 个周期内为 `npu-attached` → `applied`；否则 `mismatch` 显示实际值（可能是 `error`，并带板端报错 tag 的 reason）。
6. 卡片重绘：开关跟随回读；`npu.usage` 开始出现数值；若 `npu.usage` 为 `unavailable`，卡片显示"NPU 未上报占用率"而不是 0。
7. 审计日志记录：谁（ui/card:xxx/mcp）、什么参数、执行结果、回读值、耗时。

## 5 板型包（Board Pack）

板型包是"支持一块新板"不产生核心代码变更的唯一扩展点。它是一份**声明式数据包**，回答两个问题：这块板观测什么、接受什么操控。它不包含可执行代码——这是安全红线（§5.7）。

### 5.1 两个正交维度：怎么连 vs 能做什么

| 维度 | 载体 | 回答 | 换掉它意味着 |
|---|---|---|---|
| 连接 | target profile（连接档案） | 怎么到那台机器：传输、地址、身份、认证、工作目录 | 换线/换网口/换虚拟机，能力不变 |
| 能力 | board profile（板型包） | 到了之后能观测什么、能操控什么 | 换板型，接入方式可复用 |

**正交性**：同一块 RK3588 可以走串口、ADB、SSH 三种连接，共用同一份 board profile；同一台 Ubuntu 可以只有 target 没有 board profile（只提供终端 + 文件）。目标角色 `board` 才允许绑定板型包，`host`（仅终端+文件）与 `local`（仅本地数据源）不需要。绑定关系写在一侧：target profile 里 `boardProfile: rk3588-atk@1.2.0`，可选；不绑定则退化为纯终端/文件工作台。

**包的分层**：内置包随应用发布（受信任、可随版本升级）；用户包放用户目录（用户显式安装、显式授权）。两者走同一套 schema 校验和同一套运行时，只有"来源"标记不同。

### 5.2 board.yaml 示例（完整但精简）

```yaml
apiVersion: devboard.dev/v1
kind: BoardProfile
metadata:
  id: rk3588-atk                 # 全局唯一
  version: 1.2.0                 # semver；升级=新版本
  displayName: "ATK RK3588 开发板"
  vendor: ALIENTEK
  description: "RK3588 开发板：CPU/内存/温度/风扇 + NPU 视频链路"
  requires: { appApi: "1.0" }    # 应用卡片/契约 API 版本

match:                            # 可选：自动识别（用于“发现板子”）
  compatible: ["rockchip,rk3588"]
  kernelRegex: "^5\\.10\\."
  probe: { command: "cat /proc/device-tree/compatible" }

tags:                             # 核心词表之外的私有扩展，必须带命名空间
  - id: x.atk.fan.mode
    type: enum
    values: [auto, manual]
    unit: none
    description: "风扇控制模式（ATK 私有）"

readers:
  - id: sys-snapshot
    kind: shell_snapshot
    interval: 1000ms
    timeout: 1500ms
    staleAfter: 4000ms
    cost: 1
    command: { argv: ["sh", "-lc", "cat /proc/stat; cat /proc/meminfo"] }
    parse: builtin/linux-system-snapshot@1
    produces: [cpu.usage, mem.used, mem.total]

  - id: freq-temp
    kind: sysfs_read
    interval: 2000ms
    timeout: 1000ms
    staleAfter: 6000ms
    cost: 1
    command:
      argv: ["sh", "-lc", "cat /sys/class/thermal/thermal_zone0/temp; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"]
    parse: builtin/thermal-cpufreq@1
    produces: [thermal.soc, cpu.freq]

  - id: fan-tach
    kind: sysfs_read
    interval: 1000ms
    timeout: 1000ms
    staleAfter: 4000ms
    command: { argv: ["sh", "-lc", "cat /sys/class/hwmon/hwmon0/pwm1; cat /sys/class/hwmon/hwmon0/fan1_input"] }
    parse: builtin/hwmon@1
    produces: [fan.rpm, x.atk.fan.mode]

actions:
  - id: fan.set_speed
    label: 风扇转速
    danger: reversible
    params:
      speed: { type: integer, min: 0, max: 255, unit: pwm, default: 128 }
    command:
      argv: ["sh", "-lc", "echo {speed} > /sys/class/hwmon/hwmon0/pwm1"]
      encodes: { speed: decimal }
    verify:
      tag: fan.rpm
      expect: { from_param: speed, curve: linear, tolerance: 0.15 }
      within: 3s
      samples: 2
    dryRun: { supported: true, command: { argv: ["cat", "/sys/class/hwmon/hwmon0/pwm1"] } }
    idempotent: true
    rateLimit: { max: 5, per: 10s }

  - id: video.attach_npu
    label: NPU 接入视频链路
    danger: reversible
    params:
      enable: { type: boolean }
    command:
      argv: ["video-daemon", "attach", "--npu", "0"]     # enable=false 时由模板变体或参数编码体现
      encodes: { enable: flag }
    verify:
      tag: video.pipeline
      expect: { from_param: enable, mapping: { true: npu-attached, false: idle } }
      within: 5s
      samples: 2
    dryRun: { supported: true, command: { argv: ["video-daemon", "status"] } }

  - id: system.reboot
    label: 重启板子
    danger: destructive
    params: {}
    command: { argv: ["sh", "-lc", "sleep 1; reboot"] }
    verify: { tag: board.uptime, expect: { behavior: reset }, within: 60s, samples: 2, disconnectAllowed: true }
    dryRun: { supported: true, command: { argv: ["sh", "-lc", "echo reboot pending"] } }
```

> 示意而已：真实包里 `system.reboot` 的 verify 需要"接受期间断连、重连后 uptime 归零"的专门语义，`behavior: reset` 就是为此预留的判据类型，需在实现时定稿（列入 §11 待拍板）。

### 5.3 reader kind：能力是原语组合，不是脚本

**kind 是内置的传输/读取原语**，板型包只能选，不能造：

| kind | 用途 | 典型产出 |
|---|---|---|
| `shell_snapshot` | 一次命令读一批值 | CPU/内存/uptime |
| `procfs_read` | 一次读多个 `/proc` 文件（可 `cat` 合并，避免多次往返污染 `stat`） | `/proc/stat`、`/proc/meminfo` |
| `sysfs_read` | 读 `/sys` 类文件 | 温度、频率、PWM |
| `command_once` | 一次性命令 + 结构化输出 | 版本、状态查询 |
| `command_stream` | 长驻命令逐行输出（push 型） | dmesg 跟随、日志、自定义守护进程状态 |
| `http_json` | 板端既有 HTTP 服务 | 厂商工具链暴露的指标 |
| `local_capture` | Windows 本地设备（HDMI 采集卡、USB 串口传感器） | 帧流 + 状态 tag |

**parse 只有两种形态**：

1. **声明式提取器**：`json_path` / `regex`（具名分组）/ `csv_columns` / `key_value`，覆盖绝大多数 `/proc`、`sysfs`、命令行输出；
2. **内置纯函数解析器引用**：`builtin/<name>@<ver>`，随应用发布、有黄金样本、可单测。板型包只引用 id 和版本，不能内嵌实现。

**边界（诚实声明）**：如果一块板需要全新协议，需要在核心新增一个 kind 或 parser——这是一次通用能力升级，通常很小，之后同族板全部受益。板型包覆盖的是"用已有原语能表达的一切"；A3 的"不改核心代码"应理解为**不为单块板写专有逻辑**，而不是"核心永不需要新增原语"。这条边界必须写进接入文档，避免过度承诺。

**复用与派生**：允许包声明 `extends: <profileId>` 继承 reader/action 再覆盖；用于同系列板（同一 SoC 不同外设）。合并规则：同 id 覆盖、不同 id 追加、校验在合并后统一执行。

### 5.4 action 声明：字段全集

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 稳定语义 id，`<域>.<动作>`；卡片/MCP 都只引用它 |
| `label` / `description` | ✅/— | UI 展示名与说明 |
| `danger` | ✅ | `reversible` / `destructive`（仅两档） |
| `params` | — | 参数表：`type`（integer/number/boolean/enum/string）、`min`/`max`、`values`、`pattern`、`unit`、`default`、`secret` |
| `command.argv` | ✅ | argv 数组，占位符只允许 `{param}`，禁止 `$()`、管道、重定向以外的 shell 结构拼装 |
| `encodes` | ✅ | 每个占位参数的编码器：`decimal`/`flag`/`onoff`/`enum`/`shell_escape`/`path_safe` |
| `verify` | ✅（或显式 `none`） | 回读判据：`tag` + `expect`（`eq`/`from_param`/`range`/`enum`/`behavior`）+ `tolerance` + `within` + `samples` |
| `dryRun` | destructive 必填 | `supported` + 预览命令（必为只读命令） |
| `idempotent` | — | 重复调用是否安全，影响重试策略 |
| `rateLimit` | — | 频率限制，防脚本/卡片刷爆板子 |
| `deprecated` | — | 弃用标记与替代动作，用于平滑迁移 |

`verify: none` 只允许纯展示类动作（如点亮 LED），结果标 `unverified`，且必须写明理由——校验器会把"有副作用却无回读"的动作判为**错误**。

### 5.5 加载与校验：坏包不能污染系统

板型包进入运行时要过三道关：

1. **静态 schema 校验**（开发期 + 安装期 + 加载期）：未知字段**拒绝**而非忽略（防"字段拼错静默不生效"）；类型/枚举/必填全部严格。
2. **契约交叉校验**：
   - 引用的 tag 必须存在（核心词表或本包 `tags`）；
   - `reader.produces` 的每个 tag 都有类型/单位/值域声明；
   - `action.verify.tag` 必须是可观测的（出现在某个 reader 的 produces 中，或核心 resident 探针），否则拒绝该包——从机制上堵死"永远无法验证的动作"；
   - `danger: destructive` 必须带 `dryRun.supported: true`；
   - `staleAfter ≥ 3 × interval`、`timeout < interval` 等时间关系做合理性检查，违反给警告（板型包作者常见错误）；
   - 命令模板静态解析：占位符只能出现在"值位置"，引用未声明参数直接拒绝。
3. **运行期激活校验**：绑定 target 后执行 `match.probe`，识别不符则包不激活，UI 显示"板型不匹配（期望/实际）"；不影响其他包/目标。

**失败隔离**：任何一个包加载失败，应用照常启动；该 target 的相关 tag 呈现 `unavailable`（reason=`PROFILE_INVALID`），终端/文件能力不受影响；错误详情进诊断面板与 MCP `diagnostics`。多版本并存时按 match 精确度选择（更具体的 vendor 匹配优先，其次版本较新者）。

### 5.6 接一块新板的可验收流程

1. 建 target，确认终端可达（串口/ADB/SSH 至少一条路通）。
2. 在板端跑探针命令，把事实（路径、单位、坑）记录进事实清单——**事实必须可复现**，不是"我记得是这样"。
3. 写 reader + 选 parse，用真机输出做黄金样本（fixtures），断言解析结果。
4. 起第一张监控卡（**不改卡片代码**，换 target 即用）跑通实时曲线与五态。
5. 声明一个 `reversible` 动作，验证 dry-run 与回读闭环。
6. 故意制造失败（改错 expect、断开连接）确认 `mismatch`/`stale` 如实呈现。
7. 标注危险动作（destructive），走确认流程。
8. 提交包：schema/交叉校验全绿 + fixtures 对拍 + 卡片零改动验收。**验收判据：除新增 kind/parser 外，核心 TS 代码零改动。**

### 5.7 装包 = 授权（信任模型）

板型包虽不含代码，但它能声明"对板子执行什么命令"——等价于一份**受限的代码执行权**。因此：

- 安装用户包时，UI 必须展示：来源、readers 会执行哪些命令、actions 清单及危险等级、涉及的 tag 与设备路径；用户显式确认后才激活。
- 包来源分级：`builtin`（随应用）/ `user`（用户导入）；运行时只对 `user` 包在 destructive 首次执行时额外提示。
- 升级包若**新增 destructive 动作**或扩大命令权限，需要重新确认（不能借升级静默扩权）。
- 用户包目录里的文件不由 AI 通过 MCP 写入：v1 把"改板子权限"保留给人类（§11 待拍板 Q11）。

---

## 6 卡片层（Card）

卡片是**唯一的用户可见层**，也是 AI 的创作产物。它运行在沙箱 iframe 中，通过白名单 API 触达宿主，不直接接触设备。

### 6.1 卡片即目录

```
workspace/cards/cpu-monitor/
  manifest.json      # 声明：我是谁、订阅什么、能调什么
  index.html         # 入口视图
  card.js            # 逻辑（可拆多文件，原生 ESM）
  icon.svg
  vendor/echarts.min.js   # 可选：自带依赖（免构建，运行期不联网）
```

**manifest.json 字段**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `apiVersion` | ✅ | 卡片契约版本（如 `"1"`） |
| `id` | ✅ | 全局唯一；与目录名一致（校验器检查） |
| `name` / `description` | ✅/— | 展示信息 |
| `entry` | ✅ | 入口 HTML（相对路径，禁止越出卡片目录） |
| `icon` | — | 图标 |
| `size` | ✅ | `{ w, h, minW, minH }`，网格单位 |
| `target` | — | `"active"`（默认，跟随活动板）或显式 targetId |
| `tags` | ✅ | 订阅声明：`[{ id, label?, format?, chart? }]`；只允许声明后订阅 |
| `actions` | — | 可调用动作 id 列表；只允许声明后调用 |
| `media` | — | 需要的媒体流声明（如 `camera.capture`） |
| `permissions` | — | `{ storage: true }` 等；默认最小 |
| `requires` | — | `{ cardApi: "1" }` |

**免构建的含义**：卡片就是"一个能跑的网页"，浏览器直接加载，不做打包步骤。官方样板卡用原生 DOM + 宿主注入的小工具（格式化、图表封装、质量占位组件）编写；需要框架的卡片自己把依赖文件放进目录（构建发生在作者侧，运行期仍然零构建）。扩展名、模块格式都不设限——只要浏览器能加载。

### 6.2 宿主 API（白名单，其他一概没有）

API 通过宿主注入的 shim 暴露为 `window.dbc`（具体名字实现期定），**所有调用异步、可被拒绝、带错误码**：

| API | 语义 | 备注 |
|---|---|---|
| `dbc.card` | 卡片自身元信息（id、尺寸、主题、locale） | 只读 |
| `dbc.tags.subscribe(ids, cb)` | 订阅读数变化，返回取消句柄 | 只允许 manifest 声明过的 tag |
| `dbc.tags.get(id)` / `dbc.tags.snapshot()` | 取当前读数（含质量） | 同上 |
| `dbc.actions.list()` | 列出可用动作（含 danger、参数 schema） | 只列 manifest 声明过的 |
| `dbc.actions.invoke(id, params, opts)` | 调用动作，返回 `ActionResult`（含回读值与 verify 结论） | destructive 返回 `approval_required`，由宿主弹确认框 |
| `dbc.storage.get/set/remove` | 卡片私有键值存储（JSON） | 有配额；跨 reload 保留 |
| `dbc.media.open(streamId, opts)` | 打开媒体流句柄，`onFrame`/`close` | 状态仍走 tag |
| `dbc.theme.onChange(cb)` | 主题变化 | — |
| `dbc.log(level, msg)` | 写诊断日志 | 有速率限制 |

**没有的**：`fetch`（被 CSP 断网）、`fs`、`child_process`、`ssh`、`serial`、剪贴板、`window.open`、任意 `postMessage` 到宿主、加载外部脚本。卡片想做的事必须映射到上表之一；映射不到，说明该能力不该卡片有。

```js
// 一张最小监控卡的全部逻辑
const unsub = dbc.tags.subscribe(['cpu.usage', 'mem.usage'], readings => {
  for (const r of readings) renderMetric(r.tag, r);   // r.quality 决定渲染形态
});
renderQualityPlaceholder('cpu.usage', 'pending');      // 首帧先占位，不显示 0
```

### 6.3 沙箱：隔离 + 断网由宿主负责

实现意图级别（细节属实现层）：

- **iframe 隔离**：每卡独立 iframe，`sandbox="allow-scripts"`（刻意**不**给 `allow-same-origin`，使其成为不透明源，拿不到父窗口、localStorage、同源数据）。因此存储、主题、媒体全部由宿主 API 代劳。
- **断网必须由宿主注入 CSP**：仅靠 iframe `sandbox` 不断网（sandbox 管源与存储，不管网络）。宿主加载卡片时注入 CSP：`default-src 'none'; script-src 'unsafe-inline' dbc-card:; style-src 'unsafe-inline'; img-src blob: data: dbc-asset:; media-src blob:; connect-src 'none'; frame-src 'none'; form-action 'none'`。效果：卡片不能 `fetch`/WebSocket/加载任何外网资源，内网地址同样不可达——**卡片不能被 AI 写成数据外传通道**。
- **资源服务**：卡片目录由宿主以受限自定义协议（如 `dbc-card://<cardId>/<path>`）提供，main 侧强制路径不越界、MIME 白名单、只读。
- **通道**：宿主为每张卡建立**独立 MessagePort**，shim 只监听该 port；不使用全局 `window.onmessage` 裸通道，避免卡片之间/页面脚本互相串扰或伪造。
- **故障隔离**：卡片脚本异常、iframe 崩溃只影响自己（显示错误占位 + 重载按钮），外壳与其它卡片不受影响；每卡调用有频率与总时长配额。

### 6.4 生命周期与热插拔（AI 回路的关键）

```
发现(扫目录/解析 manifest) → 校验(schema/权限/引用存在) → 加载(iframe+shim)
   → 挂载 → 运行 ⇄ 文件变更(debounce 300ms) → 影子重载 → 原子替换 / 失败保留 last-good
```

- **原子替换**：新版本先在"影子 iframe"加载并完成首帧，成功后才替换 DOM、销毁旧实例；加载/挂载失败时**旧版本继续运行**，卡片右上角出现错误徽标，错误同时进 MCP `list_card_errors`——AI 写完就坏能立刻知道，而不是白屏。
- **状态保留**：`storage` 与布局不因重载丢失；卡片重新订阅后从当前快照恢复，不出现"重载后空白一会儿"的假象（首帧即可拿 `get/snapshot`）。
- **写入竞态**：编辑器保存过程中的半成品文件会导致校验失败；失败保留 last-good，等待下一次变更事件，不反复刷屏报错。
- **删除/禁用**：卡片从目录消失或 manifest 变坏 → 布局里保留"占位卡"（告知原因，可移除或修复），不静默消失。
- **时延预算**：文件写入 → 可见更新应在 1–2 秒内（watch 300ms debounce + 加载挂载 <1s），这是"AI 写卡立即可见"体验的下限。

### 6.5 布局

- `react-grid-layout` 承载网格：固定 12 列，卡片声明 `size` 作为默认尺寸，用户可拖拽/缩放。
- 布局独立持久化（工作区 `layout.json`）：`{ version, items: [{ cardId, x, y, w, h }] }`，可纳入 git；卡片与布局解耦——目录在即可添加，布局引用了不存在的卡片则显示占位。
- 编辑模式：进入后显示拖拽手柄、卡片库面板（列出可见卡片）与删除操作；退出后锁定，避免误拖。
- v1 只做单断点（窗口尺寸变化时容器自适应，不引入多断点布局切换）；多断点、响应式另排期。

### 6.6 内置卡 vs 工作区卡

| | 内置卡（builtin） | 工作区卡（workspace） |
|---|---|---|
| 位置 | 随应用安装 | `workspace/cards/` |
| 写权限 | 只读 | 用户 / AI（经 MCP）可写 |
| AI 可否改 | ❌（可"复制为我的卡片"后改副本） | ✅ |
| 用途 | 基线体验：监控卡、控制卡、终端外设卡 | 定制、AI 生成、二次开发 |

内置卡是**契约的活样板**：它们必须能在任意合规板型包上工作，从而证明 tag/action 契约真的与板型解耦。id 冲突（工作区卡与内置卡同名）**拒绝加载并报错**，不做隐式覆盖——覆盖关系会让"AI 改了半天没生效"成为玄学。

### 6.7 两张样板卡的验收标准

**样板卡 A：系统监控卡（纯观测）**

- 订阅 `cpu.usage`、`mem.usage`、`thermal.soc`，主图 + 数值面板。
- 板子断开 → 显示"未连接/不可用"占位，**绝不显示 0%**；`stale` 灰显 + "已过期"；恢复后 `pending → ok`，无需刷新页面。
- 图表在非 `ok` 区间断线，不插值。
- 换 target（串口↔ADB↔SSH）零代码改动可用。
- 文件改一行保存 → 1–2 秒内热更新，`storage`（如选择的 tag 集合）保留。

**样板卡 B：风扇控制卡（回读闭环 + 危险分级演示）**

- 从 `dbc.actions.list()` 读出 `fan.set_speed`（reversible），滑杆改值 → 调用 → 控件进入 pending → `applied` 后**跟随回读值**显示转速。
- 期望值不匹配 → 展示 `mismatch`：期望 vs 实际、原因码，允许再调；界面不得假装已成功。
- 演示 destructive：调用 `system.reboot` → 宿主弹确认框（dry-run 预览 + 二次确认），卡片只能"发起"，**不能自绘确认框**。
- AI 通过 MCP 触发同一个 destructive 动作时，确认框出现在 GUI 上——人不能不在场就被重启板子。

### 6.8 卡片不能做什么（边界清单）

- ❌ 联网（CSP 断网）、读文件、起进程、直接访问设备、加载外站脚本。
- ❌ 订阅 manifest 未声明的 tag、调用未声明的动作、自行弹出动作确认框。
- ❌ 修改布局（布局由用户操作或 MCP layout 工具改变）。
- ❌ 伪造读数：所有值只能来自 `tags.*` API，UI 上不能出现"卡片自己攒的数据"却不带质量状态。
- ❌ 影响其它卡片：异常、死循环、崩溃都在自己的 iframe 与配额内被处理。

## 7 MCP：AI 的 GUI

### 7.1 为什么与 GUI 同进程

MCP server 必须放在 Electron main 进程，与 GUI 共享同一份运行时状态：

- AI 要读写的是**正在运行的驾驶舱**：当前有哪些 target、tag 的实时读数、卡片是否加载成功、动作执行到哪一步。如果 MCP server 是独立进程，它只能看到文件；想拿到内存状态就得再造一套 IPC 与状态同步——多一层复杂度，收益为零。
- 授权与审计必须与 GUI 统一：动作的危险判定、destructive 人工确认、审计日志，都发生在同一处，AI 无法绕过 GUI 单独执行。
- 与卡片 API 同构：`tags/actions/layout` 三个门面在 main 是同一实现，卡片走 iframe 白名单，AI 走 MCP 工具——**同一能力，两套授权**。这正是 A2 "两条总线对称"的落地形态。

**传输选择（v1）**：本地 HTTP 回环 + 发现文件 + bearer token。

```
GUI 启动 → 生成会话 token（随机、仅本进程有效）
        → 绑定 127.0.0.1:<随机端口>（只回环，不对外）
        → 写发现文件 %APPDATA%\<app>\mcp.json
          { url, token, pid, protocol: "mcp/1", startedAt }
AI agent 读发现文件 → 带 token 连接 → 调工具
```

- **否决 stdio 直连**：stdio 模式下 server 由 agent 拉起，是一个独立的新进程，拿不到已运行 GUI 的状态；若让 stdio server 转发给 GUI，则多一层代理且仍需认证——不如直接回环 HTTP，简单且可诊断（`curl` 即可排障）。
- 发现文件在用户目录、当前用户可读；token 每次启动轮换，泄漏面仅限本机本用户会话；GUI 退出时删除发现文件。
- 端口冲突自动重试，发现文件始终写实际端口；不写固定端口，减少被本机其它程序猜测/占用。
- 可选增强（不在 v1）：随包提供一个极薄的 stdio→HTTP 转发器，方便只支持 stdio 的客户端接入。

### 7.2 工具面（设计级分组）

工具按"读状态 / 写卡片 / 改布局 / 触发动作 / 诊断"五组，不求全集（全集属实现层）。原则：**每个工具对应一个卡片也能做的操作**，AI 与卡片能力严格同构，只是授权不同。

| 组 | 工具（示例命名） | 说明 |
|---|---|---|
| 状态 | `list_targets`、`get_target_state`、`read_tags`、`list_actions`、`get_action_result` | 返回读数**一律带 quality/ts/reason**，与卡片看到的一致；`read_tags` 支持 `refresh:true` 插队一次采样 |
| 卡片 | `list_cards`、`read_card`、`write_card`、`validate_card`、`delete_card`、`list_card_errors` | 写卡片仅限工作区卡片目录；写入后自动触发热插拔；返回校验结果与加载状态 |
| 布局 | `get_layout`、`place_card` | 只做放置/移动/尺寸，不做任意 UI 操作 |
| 动作 | `invoke_action`、`get_action_result` | `invoke_action` 对 destructive 返回 `approval_required` + 待确认提示，人工在 GUI 确认后执行；支持 `dryRun` |
| 诊断 | `get_logs`、`get_audit`、`get_diagnostics_bundle` | 脱敏；审计只读 |

**明确不提供的**：任意 shell/文件/网络工具，板端命令透传，读写板型包，修改设置中的连接凭据，绕过动作回读。AI 要"新能力"只能提需求给人，由人写板型包——这是危险的边界，不能让 AI 从卡片回路升级成设备 root。

### 7.3 AI 写卡闭环（需求 4 的落地）

```
AI: read_card(spec/样例) → write_card(目录/文件) → validate_card → 自动热插拔
宿主: 校验失败 → 返回结构化错误（哪一行、哪个字段、为什么）→ 卡片保留 last-good
     校验通过 → 1–2s 内可见 → list_card_errors 反馈运行时错误 → AI 迭代
```

- **错误信息必须可行动**：不是"加载失败"，而是 `manifest.tags[2].id "cpu.usge" 不在词表且未声明为私有 tag；建议 cpu.usage`。AI 的迭代速度取决于错误信息的精度。
- **AI 看不到像素**（v1）：它能读 tag 值、卡片错误、日志、校验结果，不能看渲染截图。因此卡片错误要尽量转成文本信号；截图/像素级验证留作增强项。
- **写卡是原子目录操作**：多文件写入应提供一个写入批次（一次调用写多个文件）或由 AI 保证"先写临时目录再重命名"；宿主以最终文件内容为准，热插拔只认完整可加载的版本（呼应 §6.4 last-good）。
- **MCP 侧不需要"刷新页面"**：热插拔由文件监听自动触发；AI 写完即生效，符合"提需求 → AI 写卡 → 立即可见 → 迭代"。

### 7.4 安全地板（MCP 专章）

| 地板 | 要求 |
|---|---|
| 认证 | 仅回环 + 会话 token；拒绝无 token/错 token/非本机来源；token 不写日志 |
| 路径 | 卡片读写限制在工作区卡片目录内，禁止路径穿越；板型包、设置、机密目录不可写 |
| 动作 | 只能调用已声明动作；destructive 必须人工确认；无任意命令逃生舱（与 D1–D5 同一套） |
| 数据 | 板端返回内容视为**不可信数据**（可能含恶意文本/提示注入），工具输出标明来源，宿主不把板端输出当指令执行；AI 侧的提示注入防护由 agent 自行负责，但宿主不提供"把板端文本变命令"的通道 |
| 频率 | 工具级限流；写卡、热插拔、动作调用都有配额，防 AI 死循环刷爆设备 |
| 审计 | 所有写操作与动作记录 `origin: mcp`、工具名、参数摘要、结果；可追溯到"哪个 AI 会话"（客户端标识由连接时上报，仅用于审计） |
| 单实例 | GUI 单实例运行；第二个实例聚焦已存在窗口，避免两条 MCP 状态源 |

### 7.5 局限（诚实列出）

- **拉模式**：v1 不向 AI 推送状态变化，AI 需轮询 `read_tags`；对"实时跟随"类协作够用，对"事件驱动"不够高效。
- **看不到 UI**：无截图/像素读取，视觉验收仍需人。
- **不做通用文件编辑**：AI 只能写卡片，不能改板型包、不能改设置。
- **同进程风险**：MCP 工具缺陷可能拖垮 GUI；用请求超时、并发上限、错误隔离控制影响面。

---

## 8 横切设计

### 8.1 工作区与持久化

| 位置 | 内容 | 可否 git / 备份 |
|---|---|---|
| 工作区（默认 `%USERPROFILE%\DevBoardCockpit\`，可配置） | `cards/`（工作区卡片）、`layout.json`（布局）、可选 `fixtures/`（真机样本） | ✅ 可 git，卡片与布局是"用户资产" |
| 应用数据（`%APPDATA%\<app>\`） | `settings.json`（非机密设置）、`targets.json`（连接档案，密码为引用）、`secrets.bin`（safeStorage 加密）、`logs/`、`audit/`、`mcp.json`（发现文件） | ❌ 不 git；机密绝不进工作区 |
| 内置资源 | 内置卡片、内置板型包、内置解析器 | 随安装包 |

**规则**：工作区是"可版本化的组态"，应用数据是"本机运行态"。导出一台机器的组态 = 打包工作区；导出一台机器的连接 = 导出 target（不含机密）+ 重新输入凭据。首次启动生成默认工作区与示例卡片。

### 8.2 机密与安全存储

- 连接密码、私钥口令、MCP token 用 Electron `safeStorage`（Windows DPAPI）加密落盘；`targets.json` 只存 `secretRef`，不存明文。
- 机密不进日志/审计/诊断包；诊断包导出前做字段级脱敏。
- 内存中机密只在建立连接时短暂存在；不写入 renderer 可见的 IPC 消息。
- 卡片与 MCP 都拿不到机密（没有相应工具/API）。

### 8.3 错误模型

统一 `AppError { code, message, details?, retriable, origin }`，错误码按域分族：

| 族 | 示例 |
|---|---|
| `CONN_*` | `CONN_REFUSED`、`CONN_TIMEOUT`、`CONN_LINK_BUSY`、`CONN_AUTH_FAILED` |
| `TAG_*` | `TAG_NOT_SUPPORTED`、`TAG_PARSE_ERROR`、`TAG_OUT_OF_DOMAIN`、`TAG_NO_VALUE` |
| `ACTION_*` | `ACTION_UNKNOWN`、`ACTION_PARAM_INVALID`、`ACTION_APPROVAL_REQUIRED`、`ACTION_VERIFY_MISMATCH`、`ACTION_TIMEOUT` |
| `CARD_*` | `CARD_MANIFEST_INVALID`、`CARD_PERMISSION_DENIED`、`CARD_LOAD_FAILED`、`CARD_CRASHED` |
| `PROFILE_*` | `PROFILE_SCHEMA_INVALID`、`PROFILE_VERIFY_UNOBSERVABLE`、`PROFILE_INACTIVE` |
| `MCP_*` | `MCP_UNAUTHORIZED`、`MCP_PATH_DENIED`、`MCP_RATE_LIMITED` |
| `IO_*` | `IO_NOT_FOUND`、`IO_DENIED`、`IO_CONFLICT` |

**呈现规则**：同一错误码在 UI（toast/内联）、卡片（`reason`）、MCP（结构化错误）三处含义一致；给用户/AI 的 `details` 只含安全信息，堆栈只进日志。`retriable` 驱动重试按钮是否出现。

### 8.4 日志、审计与诊断

- **应用日志**：滚动文件，分模块级别；`windowsHide: true` 子进程输出转入日志。
- **审计日志**：append-only JSONL，仅追加不可改；事件包括：连接/断开、动作调用（含 dry-run、拒绝、超时、确认人与时间）、destructive 确认、卡片写入/删除（MCP 来源）、板型包安装/升级、设置变更。审计是"谁在什么时候对板子做了什么"的账本。
- **卡片控制台**：卡片 `dbc.log` 落到独立通道，带卡片 id，供开发者与 AI 诊断。
- **诊断包**：一键导出（版本、目标、连接状态、最近日志/审计、卡片错误），自动脱敏；提交 issue 用。

### 8.5 性能预算

| 指标 | 预算 | 保障手段 |
|---|---|---|
| 采样 IPC 合帧 | 16ms/批 | tag 引擎合帧，质量变化不被合并丢失 |
| 卡片帧率 | 默认 ≤30fps，媒体卡按需协商 | 宿主限流，卡片只能请求不能强推 |
| 启动到可用 | <3s（不含设备连接） | 延迟加载非首屏卡片；连接异步 |
| 单目标采样开销 | 由包声明 `cost` 与预算约束 | 调度器预算 + 动作优先 |
| 内存 | 卡片/iframe 有上限并回收 | 卡片数量与 iframe 生命周期管理 |
| 热插拔时延 | 1–2s | 300ms debounce + 快速校验 + 影子加载 |

**背压策略**：renderer → iframe 用"最新状态优先、丢中间帧"；采样端用"跳过并累计 drift"，绝不排队堆积。慢卡片不能拖慢设备采样。

### 8.6 并发模型

- main 单线程事件循环 + 异步 I/O；设备事务由 LinkArbiter 串行化（§2.4）。
- 解析器是**纯函数**，输入有大小上限（默认 256KB），超限判解析错误，防畸形输出打爆内存；重解析可下放 worker（实现期决定）。
- 每张卡片独立 iframe（等价独立渲染上下文）；卡片调用有并发与速率配额。
- 同一动作/同一 target 串行；MCP 请求有并发上限与超时。

### 8.7 威胁模型（简表）

| 威胁 | 影响 | 缓解 |
|---|---|---|
| 恶意/写坏的卡片 | 数据外传、伪造界面、拖垮宿主 | iframe 不透明源 + 宿主 CSP 断网 + MessagePort 专属通道 + 白名单 API + 配额 + 错误隔离 |
| 恶意板型包 | 对板子执行未预期的命令 | 无内嵌代码；装包显式授权；destructive 需确认；命令模板校验；来源标记 |
| 被本机其它程序调用 MCP | 越权改卡/操作板子 | 仅回环 + 会话 token + 发现文件权限 + 审计 |
| 板端返回恶意数据 | 提示注入、渲染异常、解析器崩溃 | 数据与指令分离；输出转义/长度上限；解析错误隔离；AI 侧不把板端文本当指令 |
| 板子被攻陷 | 主机侧被进一步利用 | 主机不信任板端输出；不提供"板端命令→主机执行"通道；文件互传只走受限路径 |
| 本机其它用户 | 读取机密/工作区 | 机密用 DPAPI；工作区在用户目录；无提权设计 |
| 肩窥/截屏 | 泄露敏感画面 | 敏感值遮蔽选项（超出 v1 范围，记录为增强） |

### 8.8 打包与原生模块

- 技术栈固定（Electron + React + TS）；**锁定 Electron 版本**并固化进构建脚本（node-pty ABI 兼容是第一风险）。
- `node-pty`、`serialport` 为原生模块：`electron-rebuild` 进构建流水线；CI 对目标 Electron 版本做预编译/校验；发布前跑"终端 + 串口"冒烟。
- Windows 子进程一律 `windowsHide: true`（否则每条命令闪黑窗）。
- 单实例锁；Windows 10/11 x64 为 v1 目标平台；代码签名与自动更新放 v1 之后。
- 构建产物：安装包 + 内置卡片/板型包资源；首次启动初始化工作区。

### 8.9 可访问性与国际化

- 键盘可达：所有操作可 Tab 到达；卡片 iframe 焦点管理由宿主协助（焦点进入/离开提示）。
- 高对比/字体缩放：主题 token 统一由宿主注入，卡片不要硬编码颜色。
- 国际化：UI 文案 zh-CN 优先，en 兜底；**契约单位不随语言变**（tag 单位固定归一，卡片负责展示格式与本地化）。

## 9 测试与验证

### 9.1 测试分层

| 层 | 对象 | 手段 | 门禁 |
|---|---|---|---|
| 单元 | 解析器、参数编码器、状态机迁移、权限判定、布局纯逻辑 | vitest | 纯函数必须有单测；覆盖率不是目标，"契约分支"全覆盖才是 |
| 契约 | tag 词表、manifest schema、板型包 schema、MCP 工具 schema | 黄金样本 + schema 快照 | 契约变更必须同步样本，样本只增不改 |
| 集成 | 连接层 + 采样 + 分发 | fake transport（模拟串口/ADB/SSH/本地源，可注入延迟、乱码、断线、半包） | 每个失败注入场景有明确期望 |
| 端到端 | Electron 外壳 + 真机 | 一块真板跑 demo 剧本 | M1–M6 每个里程碑的验收剧本 |
| 安全 | 沙箱、CSP、MCP、路径、动作闸门 | 攻击性测试（见 9.4） | 不允许带已知越权路径进发布 |
| 性能 | 采样开销、热插拔时延、内存 | 基准 + soak | 超预算即回归 |

### 9.2 黄金样本对拍（契约的硬判据）

- `fixtures/` 存**真机原始输出**（`/proc/stat` 文本、命令 stdout、错误输出），配 `profileId + readerId` 与期望结果（含 `Reading[]` 的 quality/value/reason）。
- 断言链路：原始字节 → 内置解析器 → Reading[]；同一份样本在 TS 实现与校验器（若用不同实现做对拍）上结果一致。
- 样本代表真实世界：至少覆盖正常读、板子卡顿导致的重复值、单位边界（温度 0/85）、畸形输出、连接中断前后的快照。
- **规则**：样本只增不改；发现样本本身错，加新样本并注明旧样本作废原因，不静默篡改（否则对拍失去意义）。

### 9.3 失败注入矩阵（必须逐个有测试）

| 注入 | 期望 |
|---|---|
| 连接断开 | 宽限内 `stale`（灰显旧值）→ `unavailable`（清值）；UI 绝不显示 0；重连 `pending → ok` |
| 命令超时/非零退出 | `error`（`TAG_READ_FAILED`/`TIMEOUT`），保留 last-known |
| 输出半包/乱码/截断 | 解析失败 → `error`，不崩溃、不猜值 |
| 值域越界（温度 999） | `error`（`TAG_OUT_OF_DOMAIN`），不夹紧冒充正常 |
| 乱序/重复行 | 按 `seq`/`ts` 去重与排序，最终值正确 |
| 串口被终端占用 | 采样 `stale`（`LINK_BUSY_TERMINAL`），不争抢串台 |
| 动作执行成功但状态没变 | `mismatch`，UI 显示期望 vs 实际 |
| 动作超时但实际已生效 | `timed_out` 后仍回读并展示实际状态 |
| 卡片 manifest 损坏 | 卡片加载失败 → last-good 保留 + 错误徽标 + 转文本错误给 AI |
| 卡片死循环/崩溃 | 只坏自己，外壳与采样不受影响；可重载 |
| 卡片尝试 fetch/外网 | CSP 拦截；攻击性测试验证无数据外传 |
| MCP 无 token/错 token | 401，审计记录拒绝 |
| MCP 写工作区外路径 | `MCP_PATH_DENIED`，不落盘 |
| AI 直接触发 destructive | `approval_required`，GUI 弹窗；无人工确认不得执行 |
| 板型包 verify 不可观测 | 加载期拒绝（`PROFILE_VERIFY_UNOBSERVABLE`） |
| 两个包 id 冲突 / 包 schema 未知字段 | 拒绝加载并报精确错误，不影响其它包 |

### 9.4 安全测试清单

- 沙箱逃逸：卡片尝试 `parent`、`top`、`window.open`、`postMessage` 伪造、`localStorage`、`indexedDB`——全部失败且被审计。
- 断网：卡片内 `fetch`/`WebSocket`/`<img src=http://...>` 全部被拦截（含内网地址）。
- 路径穿越：卡片资源请求 `../../`、绝对路径、UNC 路径；MCP 写卡路径越界。
- 动作闸门：绕过 GUI 直接调 MCP destructive；伪造 approval token；重放 requestId。
- 命令注入：参数含 `;`、`$()`、换行、引号、超长字符串——按类型编码，不产生额外命令。
- 审计完整性：动作/写卡/装包都有记录，日志不可改。

### 9.5 验收剧本（每个里程碑可演示）

| 里程碑 | 演示 | 通过判据 |
|---|---|---|
| M1 | 串口、ADB、SSH 各开一个终端，切换/断线重连 | 终端可用、无串台、进程不泄漏 |
| M2 | Windows ↔ 板子、Windows ↔ Ubuntu 双向传文件 | 进度/取消/冲突可处理，SFTP 与 ADB 都通 |
| M3 | 监控卡跑真板 | 五态正确；拔线不显示 0%；换连接方式不改卡 |
| M4 | AI/人写一张卡，保存即可见 | 1–2s 生效；坏卡回退 last-good；布局持久化 |
| M5 | 风扇控制卡 | 回读闭环；mismatch 可见；destructive 确认 |
| M6 | AI 客户端读状态、写卡、触发动作 | 全程有审计；越权被拒；写卡即热插拔 |

### 9.6 测不了/难测的（诚实声明）

真机型号覆盖有限（v1 以一块 RK3588 为基准 + fake transport 扩展）；长时间稳定性用 soak（连续采样 + 反复热插拔 + 反复连接）；HDMI 采集与多板属增强阶段，验证方式届时定义。

---

## 10 演进路线

七个里程碑严格对齐简报的演进顺序，**不跳步**：M1 风险最大，先证伪；后面的每一步都建立在前一步的可演示成果上。

| 里程碑 | 交付 | 退出判据 | 主要风险 |
|---|---|---|---|
| **M1 连接与终端** | target/connection/channel 抽象；serialport、ssh2、adb 三种接入；xterm.js + node-pty 终端；LinkArbiter | 三种连接都能开终端、断线重连、互不串台；原生模块在锁定的 Electron 上构建通过 | node-pty ABI 不匹配；ADB 交互 shell 需 PTY 的处理；串口独占仲裁死锁 |
| **M2 文件互传** | TransferTask（SFTP/ADB push-pull）；队列、进度、取消、冲突策略 | 双向传大文件稳定；失败可重试；与终端/采样共用链路不打架 | 大文件内存占用；ADB 与 SFTP 语义差异；路径权限 |
| **M3 tag 契约 + 真板包** | tag 引擎（五态/调度/分发）、第一份板型包、fixtures、词表落地 | 监控数据五态齐全；拔线/超时/畸形输出表现正确；换连接方式零改卡 | 逐文件往返污染 `/proc`；解析器兼容性；值域与单位 |
| **M4 卡片框架 + 监控卡** | 卡片目录/manifest/沙箱/热插拔/布局；样板卡 A；内置卡机制 | 写卡 1–2s 生效；坏卡保留 last-good；断网/逃逸测试通过 | CSP 误配；iframe 崩溃；热插拔竞态 |
| **M5 控制卡 + 回读闭环** | action 注册/执行/危险分级/verify/审计；样板卡 B | `applied/mismatch/timed_out` 状态正确；destructive 二次确认+ dry-run；动作失败不篡改界面 | verify 假成功；退出码误判；串口上动作与采样并发 |
| **M6 MCP** | main 内 MCP server、回环+token+发现文件、五组工具、AI 写卡闭环 | AI 能读状态、写卡即生效、触发 reversible；destructive 经 GUI 确认；越权被拒且有审计 | 回环端口/发现文件安全；工具面漏洞；AI 写坏卡 |
| **M7 增强** | HDMI 采集（本地源 + 媒体通道）、多板管理、主题/国际化、诊断包增强、可选 stdio 转发器 | 采集帧率与状态分离正确；多板 namespace 可用；无回归 | 多板让 UI 与调度复杂化；采集卡兼容性；性能 |

**风险登记册（跨里程碑）**：

| 风险 | 概率/影响 | 缓解 | 早期信号 |
|---|---|---|---|
| node-pty 与 Electron ABI 不兼容 | 中/高 | 锁定版本、构建脚本固化 electron-rebuild、CI 冒烟、真机样本 | 开发机终端偶发崩溃 |
| 串口单链路争用/串台 | 中/高 | LinkArbiter 事务化、优先级、终端独占语义 | 交错字符、命令错配响应 |
| 采样污染 `/proc`（多次往返） | 中/中 | reader 批读、一次命令多值、事实清单核对 | 相邻读数跳变、与 top 不一致 |
| verify 假成功（退出码 0 但没生效） | 高/高 | 回读裁决、稳定窗口、多采样、mismatch 呈现 | 开关显示已开但板子行为没变 |
| MCP 越权/被本机程序滥用 | 中/高 | 回环+token+白名单工具+审计+人工确认 | 未认证请求、异常写入 |
| CSP 配置失效导致卡片可联网 | 中/高 | 默认拒绝、攻击性测试、评审 | CSP 报错被忽略、控制台告警 |
| AI 写坏卡片 | 高/低 | last-good + 精确错误 + 校验器 | 卡片频繁加载失败 |
| 多板引入复杂度 | 低（v1）/中 | 命名空间预留、单板 v1 | M7 前不引入 |
| 性能问题（iframe/图表/采样） | 中/中 | 预算、合帧、配额、基准测试 | 帧率下降、IPC 排队 |

---

## 11 待拍板问题

以下是"设计已给出倾向，但需要用户/评审确认"的决策点。每项含建议，避免悬空。

| # | 问题 | 选项与倾向 |
|---|---|---|
| Q1 | v1 是否只支持单板？ | 倾向：单板（一个 board target）+ 一台 Ubuntu + 本地源；内部命名空间已预留多板，M7 再开 |
| Q2 | Ubuntu 虚拟机是否只做终端+文件？ | 倾向：v1 是；board profile 机制保留，之后可给 Ubuntu 写能力包 |
| Q3 | 卡片目录默认位置与是否允许自定义？ | 倾向：默认 `%USERPROFILE%\DevBoardCockpit\`，允许设置改路径；工作区可 git |
| Q4 | MCP 传输 v1 是否只做回环 HTTP？是否附带 stdio 转发器？ | 倾向：v1 回环 HTTP + token；stdio 转发器作为可选增强，不阻塞主链路 |
| Q5 | destructive 的确认粒度 | 倾向：每次执行都确认，approval 绑定 actionId+params+targetId+TTL；不提供"本会话内记住" |
| Q6 | 内置卡"复制为我的卡片"的命名与冲突策略 | 倾向：复制生成新 id（`<name>-copy` 或用户命名），工作区与内置同 id 时拒绝加载并报错，不隐式覆盖 |
| Q7 | HDMI 采集路径 | 倾向：v1 本地源（USB/UVC 采集卡）走 `local_capture` + 媒体通道；板端编码回传作为后续 |
| Q8 | tag 词表治理归属 | 倾向：核心词表小而稳，板型包用命名空间扩展；新 tag 需评审合并，禁止各包自造核心语义 |
| Q9 | 动作"成功"的判据归属 | 倾向：唯一判据是板型包 `verify` 回读；卡片/MCP 不得自定义成功标准；`verify: none` 必须显式且结果标 `unverified` |
| Q10 | 发布形态与更新 | 倾向：v1 安装包（Windows x64），手动更新；自动更新与签名排 M7 之后 |
| Q11 | 板型包是否允许 AI 通过 MCP 写入 | 倾向：v1 不允许（板型包 = 设备权限，保留给人类）；卡片才是 AI 的创作面 |

---

## 附录 A 需求追踪矩阵

| 需求/事实 | 落地章节 |
|---|---|
| R1 统一工作台（串口/ADB/SSH 终端 + 文件互传） | §2（连接层）、§2.5（终端）、§2.6（文件互传）、§1.4（进程与信任边界） |
| R2 可插拔卡片（实时可视化、即插即用） | §6（卡片层）、§3（观测总线）、§5（板型包提供数据）、§6.4（热插拔） |
| R3 卡片双向 + 回读真实状态 | §4（控制总线）、§4.3（回读闭环）、§6.7 样板卡 B、§3.3（五态） |
| R4 AI 协作（读写卡片、立即生效） | §7（MCP）、§7.3（写卡闭环）、§6.4（热插拔）、§5.7（装包授权） |
| A1 分层单向向下 | §1.1 依赖规则 L1–L5、§1.4 |
| A2 两条契约总线 | §1.3（对称性推导）、§3/§4（tag/action 总线）、§7（MCP 与两条总线同构） |
| A3 板型差异=数据包 | §5 全章（reader/action 声明、校验、接入流程、装包授权） |
| A4 卡片即文件、免构建、iframe 沙箱 | §6.1（目录与 manifest）、§6.3（沙箱与断网）、§6.4（热插拔） |
| A5 读数永远带状态 | §3.2（Reading）、§3.3（五态与不变量 I1–I6） |
| A6 动作分级与回读 | §4.5（危险分级 D1–D5）、§4.3、§7.4（MCP 安全地板） |
| A7 数据源独立于连接 | §2.7（Source 抽象）、§3.8（流式 tag 与状态分离） |
| A8 技术栈与 node-pty 坑 | §2.2（技术栈分工）、§8.8（原生模块与构建锁定）、§10 风险 |
| 演进顺序（七步） | §10（M1–M7 与退出判据） |
| 边界（不展开实现层） | 附录 D |

---

## 附录 B 不变量清单

**分层（§1.1）**

| 编号 | 不变量 |
|---|---|
| L1 | 依赖单向向下：卡片层 → 能力层 → 连接层，禁止反向 import/回调 |
| L2 | 下层不知道上层存在：连接层不认识 tag 语义，能力层不认识卡片 |
| L3 | renderer 不直接接触设备：设备 I/O、协议、解析只在 main |
| L4 | 卡片只能通过白名单 API 触达宿主，没有后门通道 |
| L5 | 板型差异只以数据包形式存在，核心不出现板型分支 |

**tag 五态（§3.3）**

| 编号 | 不变量 |
|---|---|
| I1 | 非 ok 不得以正常数值样式呈现；趋势图非 ok 区间断线 |
| I2 | `unavailable` 不携带 value；`ok` 必带 value |
| I3 | 质量只能由 tag 引擎产生，卡片/UI/MCP 不得改写 |
| I4 | 断开后必须离开 `ok`（最迟一个 `staleAfter` 内） |
| I5 | `0` 只在 `ok` 下合法；把 `unavailable` 画成 0 是 P0 缺陷 |
| I6 | 同一 tag 的 `seq` 单调递增，渲染层可据此丢弃乱序 |

**动作安全（§4.5）**

| 编号 | 不变量 |
|---|---|
| D1 | 无任意命令：执行器只执行由板型包模板生成、参数经类型编码的命令 |
| D2 | destructive 必须由人工在 GUI 确认；card/MCP 只能发起不能确认 |
| D3 | destructive 首次调用默认 dry-run，确认界面展示 dry-run 结果 |
| D4 | 动作成功只由 verify 回读裁决，不由调用方声明 |
| D5 | 动作审计不可绕过（含 dry-run、拒绝、超时、确认人） |

---

## 附录 C 术语表

| 术语 | 英文/标识 | 含义 | 章节 |
|---|---|---|---|
| 语义位号 | tag | 板子能力的语义名，如 `cpu.usage`，与板型/传输无关 | §3.1 |
| 读数 | Reading | 值 + 五态质量 + 时间戳 + 来源的诊断记录 | §3.2 |
| 五态 | quality | ok/stale/unavailable/error/pending | §3.3 |
| 目标 | target | 一个可连接的实体（板卡/Ubuntu/本地）及其连接档案 | §2.1 |
| 连接 | connection | 目标上的一条具体传输链路（串口/ADB/SSH/本地） | §2.1 |
| 通道 | channel | 连接上承载终端/命令/文件的能力面 | §2.1 |
| 板型包 | board profile | 声明 tag 怎么产生、动作怎么执行的数据包 | §5 |
| 观测源 | source | 产生 tag 读数的数据来源（板子连接或本地设备） | §2.7 |
| 读者 | reader | 一次采样单位，产出 1..N 个 tag | §3.4 |
| 动作 | action | 板型包声明的可控操作，分 reversible/destructive | §4.1 |
| 回读 | verify | 用观测侧读数裁决动作是否真正生效 | §4.3 |
| 试运行 | dry-run | 只读预览动作将执行的内容，无副作用 | §4.5 |
| 卡片 | card | 一个目录：manifest + 视图代码，跑在沙箱 iframe | §6.1 |
| 热插拔 | hot reload | 文件变化后自动重新加载卡片，失败保留 last-good | §6.4 |
| 链路仲裁 | LinkArbiter | 单条连接上的事务优先级与独占管理 | §2.4 |
| 组态 | configuration | 用户/AI 创造的卡片与布局资产，可版本化 | §8.1 |
| 两条总线 | two buses | tag 契约（卡片↔板子）与 MCP 契约（AI↔GUI） | §1.3 |

---

## 附录 D 边界说明

**本文覆盖**：设计层——架构、契约语义、机制与不变量、风险与演进；不写实现代码、不写精确 schema/工具参数全集、不写 UI 视觉稿。

**明确不做的事**：

- 不展开沙箱实现细节（CSP 注入方式、自定义协议实现、MessagePort 建立时序的具体代码）。
- 不列 MCP 工具全集与精确参数。
- 不定义评审流程与历史决策编号体系。
- 不写安全闸门的实现规格（approval token 的具体签发/校验实现）。
- 不写具体 Electron/React 版本、构建脚本细节——这些在实现层定，但**锁定 Electron 版本**是硬约束（§8.8）。

**事实状态**：本文基于项目简报（用户定稿）与仓库既有目录/命名约定推导。文中凡"倾向/建议"为设计判断，需用户拍板（§11）；凡涉及具体平台行为（node-pty ABI、serialport 在 Electron 下的行为、ADB 交互 shell 方案、Windows DPAPI、回环端口策略）均**待真机/实机验证** 🔵；未标注即不构成已核实事实。

**独立性声明**：本文为独立设计，未展开阅读仓库中既有的设计/评审文档正文；仅在落位与命名上参考了仓库目录结构（如 `docs/spec/`、`profiles/`、`fixtures/`）。与既有文档如有冲突，以契约为准、以评审结论为准。

---

*本文写完时，最想让评审盯住的是三个地方：第一，五态与"0 不是未知"这条线是否在每张卡、每个 API、每次回读里都守住了；第二，控制动作的"回读裁决"是否真的不能被退出码和调用方声明绕过；第三，AI 的权限边界是否止步于卡片与已声明动作——一旦这三条松动，整个驾驶舱就会退化成一个带图表的遥控器。*

— deepseek V4.1 flash，2026-11-12
