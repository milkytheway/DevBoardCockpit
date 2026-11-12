# 语义 tag 契约

> 卡片 ↔ 板子之间的总线。这份文档定义**词汇**，板型包定义**怎么产生**。

---

## 一、一个 tag 是什么

一个 tag 是**一个可被命名的标量量测**，有五个属性：

| 属性 | 含义 | 例 |
|---|---|---|
| **名字** | 稳定标识，点号分层，全小写 | `cpu.usage` |
| **类型** | number / string / boolean / enum | number |
| **单位** | SI 单位或无量纲 | `percent` |
| **取值域** | 合法范围，越界视为读失败 | `[0, 100]` |
| **语义** | 这个数字**究竟是什么** | 「过去 1 秒所有核心的忙碌时间占比」 |

名字**不含板型**。`cpu.usage` 在 RK3588 上、在 RK3568 上、在全志上，含义必须一致。

### 名字的分层

```
cpu.usage                 设备 . 属性
cpu.core.3.usage          设备 . 实例组 . 实例 . 属性
npu.core.0.usage
mem.total
temp.soc
```

规则：

- **第一段是设备域**：`cpu` / `gpu` / `npu` / `mem` / `temp` / `disk` / `net` / `board` / …
- **第二段起是实例组和实例**，只在需要区分同类实体时出现。
- **最后一段是属性**。
- 全小写，下划线连接单词（`temp.soc`、`net.rx_bytes`）。
- **不缩写**：写 `gpu.freq_hz` 不写 `gpu.f`；写 `mem.used_bytes` 不写 `mem.u`。

### 词表分层

| 层 | 谁定义 | 谁能用 | 稳定性 |
|---|---|---|---|
| **核心词表** | 本文档，随契约版本走 | 所有板、所有卡片 | 语义永不改变；要改语义就升版本并另起新名 |
| **板型私有扩展** | board pack 自己声明，命名空间 `custom.<板型>.<…>` | 只有该板型的卡片 | 不保证跨板可用 |
| **逃生舱** | `custom.local.<…>` | 本地脚本、临时实验 | 无保证 |

核心词表用**匹配模式**表达，模式里的 `*` 匹配恰好一段：

```
cpu.usage          : number, percent,  [0,100]
cpu.core.*.usage   : number, percent,  [0,100]
cpu.core.*.cluster : string, -,        枚举 {A55, A76, ...}（可扩展）
gpu.usage          : number, percent,  [0,100]
gpu.freq_hz        : number, hertz,    >= 0
npu.usage          : number, percent,  [0,100]
npu.core.*.usage   : number, percent,  [0,100]
mem.total_bytes    : number, byte,     > 0
mem.used_bytes     : number, byte,     >= 0
mem.usage          : number, percent,  [0,100]
temp.soc           : number, celsius,  毫度内部值
temp.gpu           : number, celsius
temp.npu           : number, celsius
disk.*.free_bytes  : number, byte
disk.*.total_bytes : number, byte
net.rx_bytes       : number, byte      累计接收字节
net.tx_bytes       : number, byte
board.model        : string, -
board.kernel       : string, -
```

新增一个核心 tag 是**契约升版本**的事，不是 board pack 的事。board pack 只能**声明自己实现了哪些核心 tag**。

---

## 二、状态：一个 tag 不是一个数字

这是最容易做错、也最影响「驾驶舱 vs 遥控器」的地方。

一个 tag 的读数**永远是**「值 + 状态」，不是裸值：

| 状态 | 含义 | 卡片怎么显示 |
|---|---|---|
| `ok` | 有值，且在刷新周期内 | 正常显示 |
| `stale` | 有值，但上次刷新失败/超时，值可能过时 | 显示值 + 「已过时」标记 |
| `unavailable` | 这块板不提供这个 tag | 显示「不可用」，不显示数值 |
| `error` | 提供这个 tag 但读取失败 | 显示错误 |
| `pending` | 首次读，还没建立起基线（如需要两次采样做差） | 显示「等待」 |

**关键约定：`unavailable` 和 `0` 是两回事，绝不能混。**

这直接继承现有 `core/metrics.py` 里已经做对的事——那个 `Metrics` dataclass 里读不到的量是 `None` 而不是 `0.0`，注释写得很清楚：「一块够不到的板和一块没事干的板，绝不能长得一样」。契约把它升格成正式的状态机。

这条约定是「驾驶舱」的底线：**显示 0% 负载的按钮，可能其实是没连上。** 反过来，一个 `unavailable` 的按钮必须显示成不可用，而不是 0——否则用户会去点一个不存在的开关。

---

## 三、刷新模型

一个 tag 有两个时间属性：

| 属性 | 含义 | 谁定 |
|---|---|---|
| **刷新周期** | 多久读一次 | board pack（默认按设备域给建议值） |
| **新鲜度上限** | 超过多久算 `stale` | 契约默认 = 3 × 刷新周期 |

刷新是**按设备域批量**的，不是按 tag 单独轮询。原因在现有代码里有实测记录：每个文件 spawn 一次 `adb shell` 大约 30 ms，而且 fork 出来的 shell 自己的 CPU 时间会记进 `/proc/stat`，让板子看起来 100% 忙。

所以一条铁律：

> **同一个 board pack 的所有 reader，必须能在一次往返里取回全部数据。**

reader 的定义就是「一次往返能取回的一批数据」，见 `02-board-pack.md`。

### 首次读的特殊性

有些量必须**两次采样做差**才能算出来（CPU 占用率就是这样）。这类 tag 在第一次读时返回 `pending`，第二次起才有值。

卡片必须能优雅处理 `pending`：显示「等待第一次采样」，而不是转圈或显示 0。

---

## 四、tag 的发现

核心问题：**AI 怎么知道一块板上有哪些 tag？**

三种机制，缺一不可：

### 4.1 静态：board pack 自述

board pack 声明它实现了哪些 tag（见 `02-board-pack.md`）。这让 AI 不接板子也能先读懂这块板。

### 4.2 动态：运行时列举

`list_tags()` 返回当前连接的所有板**实际提供**的 tag，含实时状态。这解决「包说有，实际读不出来」的情况。

### 4.3 自省：读一个 tag 的详细信息

`describe_tag(name)` 返回类型、单位、取值域、当前值、状态、历史数据源。这是 AI 写卡片前的必查项。

> **为什么不能靠静态文档**：能力是动态出现的——摄像头是插上的，NPU 驱动是后来装的，profile 是运行时加载的。文档永远滞后于现场。MCP 工具表里 `list_data_sources` 那一行的原话就是「能力动态出现，不能靠静态文档」。

---

## 五、缺 tag 怎么办（已定：可降级）

卡片引用了当前板子没有的 tag 时：

1. **卡片照常加载**。不拒绝、不报错、不阻塞。
2. 引用缺失 tag 的那个 widget 显示「不可用」，并注明**缺哪个 tag**。
3. manifest 里声明所需的 tag 清单和最低 board pack 版本；加载时由运行时做检查，把缺失项列出来。

这与 AI 协作的回路直接相关：agent 写卡 → 热插拔 → 你看效果 → agent 迭代。中间任何一步因为「这张卡在别的板子上不完整」而失败，迭代就断了。降级让「不完整的卡」依然可用、可看、可诊断。

**但降级不等于沉默。** 缺失必须**显式可见**：
- 卡片内显示「不可用 · 缺 cpu.usage」
- MCP 的 `validate_card` 返回缺失清单
- MCP 的 `list_cards` 报告哪些卡在当前板上处于降级状态

---

## 六、核心词表的门槛

什么量才有资格进核心词表？三个条件同时满足：

1. **至少两块板会产生它**，或者它是一个 Linux 通用量（`mem.usage`、`board.model`）。
2. **语义在所有板上一致**。「负载」在不同厂商的语义经常不一样（duty cycle vs 实际利用率——现有 `metrics.py` 里就踩过这个坑：NPU 的 devfreq `load` 文件空闲时读 `100@1000000000Hz`，那是占空比不是利用率，真正的利用率在 `rknpu` debugfs 里）。这类量**必须先在多个板上核对语义一致**，才能进核心词表。
3. **有一个明确的失败语义**。读不到时状态是什么，写清楚。

不满足条件的量，走 `custom.<板型>.*`。

**这个门槛是防止核心词表膨胀成垃圾场的主要机制。** 词表每加一个词，就多一份「所有实现者都得按这个语义来」的承诺。

---

## 七、一个具体的坑：当心 duty cycle

这条值得单独立，因为它是真实踩过的：

> 某厂商的 devfreq `load` 文件读出来是 `<duty>@<freq>Hz`。这个 duty 是**时钟占空比**，不是**利用率**。板子空闲时它读 100（时钟满速待命），板子满载时它读 100（真的在算）。用它当利用率，空闲的板会显示 100% 忙。

正确的来源通常是另一处（该厂商的 debugfs 或 sysfs 属性）。

**契约层面的要求**：核心词表里的每个量，其「语义」一栏必须写清楚**它到底代表什么**。「利用率」不够，要写「过去 1 秒 CPU 执行非空闲指令的时间占比」。写不清楚的量，不要进核心词表。

---

## 八、名词对照

| 契约名词 | 含义 | 现有代码对应 |
|---|---|---|
| tag | 一个可命名的标量量测 | `Metrics` 里的一个字段（如 `cpu_total`） |
| 状态 | ok / stale / unavailable / error / pending | `Metrics` 里的 `None` 与 `ok` 标志 |
| reader | 一次往返取回的一批数据 | `SNAPSHOT_SCRIPT` 那段脚本 |
| board pack | 一块板的 YAML 数据包 | 不存在（散落在 `metrics.py` 里） |
| 动作 | GUI → 板的一次受控写入 | 不存在 |

---

> **迁入说明**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex）。
> 它是**语言中立的契约层**，正文未改动，是本工程的权威契约。
> 外壳与实现层的落地方式见 `docs/04-架构设计.md`。