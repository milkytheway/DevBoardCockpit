> **来源与修订**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex，提交 `c24b084`）。
> 契约层为**权威文档**。**迁入后经 `0244852` 修订过**，2026-11-12 的评审又做了一轮修订
> ——逐节来源见 `00-overview.md` §一之二。落地方式见 `docs/04-架构设计.md`。
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
mem.total_bytes
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

核心词表用**匹配模式**表达，模式里的 `*` 匹配恰好一段。

> **权威在 `data/tag-vocabulary.yaml`。** 下面这张表是它的**渲染结果**，不是另一份定义。
> 要新增或修改核心 tag，改 YAML；实现层的机器可读形态也从它生成。
> 三者（YAML / 本表 / 实现层）由对拍测试保证逐条一致（`docs/04` §4.3）。
>
> 表里多了一列 **v1**：`required` = v1 的板型包应提供；`reserved` = 词表保留语义但 v1 不要求任何包提供。
> 这一列解决「词表里有定义、包里没有实现」的落差（`board.kernel`、`net.*`、`disk.*` 目前是 `reserved`）。

| 模式 | 类型 | 单位 | 取值域 | 语义 | v1 |
|---|---|---|---|---|---|
| `cpu.usage` | number | percent | [0,100] | 过去 1 秒内，所有 CPU 核心执行非空闲指令的时间占比 | required |
| `cpu.core.*.usage` | number | percent | [0,100] | 过去 1 秒内，单个 CPU 核心执行非空闲指令的时间占比 | required |
| `cpu.core.*.cluster` | string | - | 开放枚举 | CPU 核心所属的簇名，如 A55 / A76。**未知名字按字符串原样上报**，不报错 | required |
| `cpu.governor` | enum | - | 开放枚举 | 当前生效的 CPU 调频策略（cpufreq 的 `scaling_governor`），如 `schedutil`。取 cpu0 的值；各核可独立设置 | required |
| `gpu.usage` | number | percent | [0,100] | GPU 当前读数：执行非空闲指令的时间占比。**采样窗口由驱动决定**，不是固定的 1 秒 | required |
| `gpu.freq_hz` | number | hertz | ≥0 | GPU 当前工作频率 | required |
| `npu.usage` | number | percent | [0,100] | NPU 当前读数：各计算核利用率的**最大值**。**采样窗口由驱动决定**，不是固定的 1 秒 | required |
| `npu.core.*.usage` | number | percent | [0,100] | 单个 NPU 计算核的当前利用率 | required |
| `mem.total_bytes` | number | byte | >0 | 物理内存总量 | required |
| `mem.available_bytes` | number | byte | ≥0 | 无需交换即可分配给新进程的内存（MemAvailable） | required |
| `mem.used_bytes` | number | byte | ≥0 | 已用内存 = MemTotal - MemAvailable（**不含**可回收的 page cache） | required |
| `mem.usage` | number | percent | [0,100] | 已用内存占物理内存总量的百分比 | required |
| `temp.soc` | number | celsius | - | SoC 核心温度，按 thermal zone 的 `type` 归并，不依赖 zone 序号 | required |
| `temp.gpu` | number | celsius | - | GPU 温度，按 thermal zone 的 `type` 归并 | required |
| `temp.npu` | number | celsius | - | NPU 温度，按 thermal zone 的 `type` 归并 | required |
| `board.model` | string | - | - | 板子型号字符串，用于自动识别板型包 | required |
| `board.kernel` | string | - | - | 运行中的内核版本字符串 | reserved |
| `net.rx_bytes` | number | byte | ≥0 | 自启动以来累计接收的字节数 | reserved |
| `net.tx_bytes` | number | byte | ≥0 | 自启动以来累计发送的字节数 | reserved |
| `disk.*.free_bytes` | number | byte | ≥0 | 某个挂载点所在文件系统的可用字节数 | reserved |
| `disk.*.total_bytes` | number | byte | ≥0 | 某个挂载点所在文件系统的总字节数 | reserved |

**背光为什么不在核心词表**：这块板有**两块**背光（`backlight` 与 `backlight1`），
实例名与刻度都是板子特有的，不满足「语义在所有板上一致」的准入门槛。
所以两个实例都走 `custom.<板型>.*`（用户 2026-11-12 拍板，见 `docs/06` C2）。

**「语义」这一栏不是装饰。** 它就是 `describe_tag()` 返回给 AI 的那段文字，
也是防止「npu.usage」被当成任何模糊的「NPU 负载」来理解的唯一东西。
没有语义的量不要进核心词表。

**权威只有一份：`data/tag-vocabulary.yaml`。** 本表是它的渲染结果，
实现层的机器可读形态也从它生成——不允许在代码里另写一份词表。

> **为什么强调「唯一」**：词表一旦有两份，就会漂移——改了文档没改代码，
> 或者改了代码没改文档，而两边都说自己是对的。
> 实现层的那一份是**生成物**，不是**源头**；源头永远在 YAML 里。
> 评审通过后，实现层需要自带一个对拍测试：逐条比对「代码里的词表」、
> 「本表的渲染结果」与「YAML」，不一致就红。

新增一个核心 tag 是**契约升版本**的事，不是 board pack 的事。board pack 只能**声明自己实现了哪些核心 tag**。

> **本轮（T-6）新增了三个核心 tag**：`mem.available_bytes`、`cpu.governor`，
> 以及把 `mem.used_bytes` 的语义写准（原来写「含可回收 page cache」，
> 而 `MemTotal - MemAvailable` 恰恰是**不含**可回收部分的口径）。
> 因为 `devboard/v1` 尚未随任何实现发布，这属于 **v1 定稿前的修正**，不是破坏性变更。
> v1 一旦发布，核心 tag 的语义就不再原地改。

### 板型私有扩展的命名

私有 tag 的命名空间是 `custom.<board pack id>.<…>`。

- `<board pack id>` 可以含连字符（`rk3588-atk`），因为匹配是**字面前缀**匹配，不是段模式匹配。
- 私有 tag 的段数不限：`custom.rk3588-atk.npu.duty` 是合法的。
- 私有 tag **没有核心词表那样的语义约束**——它们是那块板自己的东西。
  但 board pack 应该在自己的 README 里写清楚每一个的含义。


---

## 二、状态：一个 tag 不是一个数字

这是最容易做错、也最影响「驾驶舱 vs 遥控器」的地方。

一个 tag 的读数**永远是**「值 + 状态」，不是裸值：

| 状态 | 含义 | 卡片怎么显示 |
|---|---|---|
| `ok` | 有值，且在刷新周期内 | 正常显示 |
| `stale` | 有值，但上次刷新失败，值可能过时 | 显示值 + 「已过时」标记 |
| `unavailable` | 这块板不提供这个 tag，或该资源此刻不在 | 显示「不可用」，不显示数值 |
| `error` | 应该能读，但读取或解析失败 | 显示错误 |
| `pending` | 还没建立起基线（如需要两次采样做差） | 显示「等待」 |

**关键约定：`unavailable` 和 `0` 是两回事，绝不能混。**

这直接继承旧工程 `core/metrics.py` 里已经做对的事——那个 `Metrics` dataclass 里读不到的
量是 `None` 而不是 `0.0`，注释写得很清楚：「一块够不到的板和一块没事干的板，绝不能长得
一样」。契约把它升格成正式的状态机。

这条约定是「驾驶舱」的底线：**显示 0% 负载的按钮，可能其实是没连上。** 反过来，一个
`unavailable` 的按钮必须显示成不可用，而不是 0——否则用户会去点一个不存在的开关。

### 2.1 状态怎么迁移

这张表是**有状态的**：运行时必须按这张表迁移，不能各写各的。

| 从 | 到 | 触发条件 |
|---|---|---|
| （无） | `pending` | 该 tag 第一次被读，且需要两次采样做差 |
| （无） | `ok` | 该 tag 第一次被读，且单次即可算出（无历史依赖） |
| `pending` | `ok` | 第二次采样完成，算出差值 |
| `pending` | `pending` | 第二次采样仍未成功（基线还没建立） |
| `pending` | `unavailable` | 资源已不存在 |
| `pending` | `error` | 采样过程本身失败（命令非零、超时、传输断了） |
| `ok` | `ok` | 读到新值 |
| `ok` | `stale` | 本次刷新失败，但保留上一次的值 |
| `ok` | `error` | 读出了值，但值**坏了**（解析失败、越界、类型不符） |
| `ok` | `unavailable` | 资源消失（设备被拔出、debugfs 被卸载） |
| `stale` | `ok` | 刷新恢复 |
| `stale` | `stale` | 继续失败，值仍是旧的 |
| `stale` | `error` | 刷新恢复但这次读出来的值坏了 |
| `stale` | `unavailable` | 资源消失 |
| `stale` | `pending` | 资源回来，但需要**重新建立基线**（有状态 tag） |
| `unavailable` | `ok` | 资源回来，且直接能读出值 |
| `unavailable` | `pending` | 资源回来，但需要**重新建立基线**（有状态 tag） |
| `unavailable` | `error` | 资源回来了，但第一次读就失败 |
| `error` | `ok` | 刷新恢复 |
| `error` | `error` | 继续失败 |
| `error` | `stale` | 继续失败，且之前有过一个可用的值——**保留它**，标为已过时 |
| `error` | `unavailable` | 资源消失 |
| `error` | `pending` | 资源回来，但需要重新建立基线 |

**这张表没有死路。** 每一行都可以走回 `ok`——一次瞬时故障不会让一张卡的显示永久坏掉。
这很重要：`error` 和 `stale` 都不是终态。

**`unavailable` 与 `error` 的分界**：资源**不在**是 `unavailable`，资源**在但读不出来**
是 `error`。

> 一个具体的例子：RK3588 的 NPU 读 `/sys/kernel/debug/rknpu/load`，而
> `/sys/kernel/debug` 默认没挂载。挂载与否是**环境状态**，不是板子能力的缺失——
> 所以它是 `unavailable`（此刻读不到），不是 `error`（读的时候出了错）。

这直接影响卡片：一个 `unavailable` 的 widget 应当引导用户去挂载 debugfs，
而不是报「NPU 读取失败」。

**取值越界算 `error` 还是 `unavailable`？算 `error`。**
取值域（§一）是 tag 的语义契约；资源还在但读出的值不合法，是「读出来了但坏了」，
与「资源不在」是两回事。实现层遇到越界值必须报 `error`，**不得**把它夹到合法区间当作 `ok`
（那是在撒谎），也**不得**当 `0`（那是更糟的撒谎）。

**`stale` 保留旧值**，`unavailable` 不保留（值为 `null`）。
`error` 的行为分两种，**由运行时决定，不由 reader 决定**：

| 情形 | 行为 |
|---|---|
| 从 `ok`/`stale` 进入 `error`（值坏了） | **保留旧值**，同时标 `error` |
| 从 `pending` 进入 `error`（从没成功过） | 没有旧值，值为 `null` |

保留旧值是有理由的：一个刚刚掉线的板子，显示它最后一次已知的 37% 比显示空白有用——
但必须**标出它已过时**，否则就是在撒谎。卡片拿到 `error` 且值为 `null` 时，
显示「读取失败」；拿到 `error` 且有值时，显示「读取失败（显示的是上一次的值）」。

### 2.1.1 读数的结构

一个读数是**一个结构**，不是一个裸值：

```json
{
  "tag": "npu.usage",
  "value": 12.5,
  "unit": "percent",
  "status": "unavailable",
  "reason": "device_absent",
  "detail": "/sys/kernel/debug/rknpu/load 不存在：debugfs 未挂载。修复：mount -t debugfs debugfs /sys/kernel/debug",
  "at": 1762910000123,
  "seq": 418
}
```

| 字段 | 含义 |
|---|---|
| `value` | 当前值。`unavailable` 时**没有** value；`ok` 时**必带** value |
| `status` | 五态之一 |
| `reason` | **机器可读的封闭枚举**，见下 |
| `detail` | **给人看的自由文本**。可含修复提示 |
| `at` | 本次采样的完成时刻（毫秒 UTC） |
| `seq` | 同一 tag 内**单调递增**的序号 |

**`reason` 是封闭枚举，带版本**（`reason_code_version`，与 `danger_floor_version` 同一治理模式）。
起始码表：

| 码 | 语义 | 典型来源 |
|---|---|---|
| `not_found` | **你问的那个东西不存在**（当前板型包不提供这个 tag、动作 id 不存在……） | 静态可判，装卡时就能算出。**与 `04` §2.4 动作侧的 `not_found` 同名同义**——不给 AI 两套要互相翻译的方言（ADR-D27） |
| `device_absent` | 资源此刻不在：路径不存在、设备被拔、挂载丢失 | reader 段缺失、文件不可读 |
| `service_down` | 依赖的服务 / 进程没在跑 | `exec_regex` 的命令失败 |
| `link_busy_terminal` | 链路被终端占用，采样暂停 | ADR-D23 |
| `parse_error` | 读到了但解析不出来 | 格式不匹配 |
| `out_of_domain` | 读到了但值越界 | 取值域校验失败 |
| `timeout` | 这次读没在期限内完成 | 往返超时 |

**为什么要「机器码 + 自由文本」两栏**：
`reason` 给 AI 与卡片逻辑消费（`unavailable(device_absent)` 可以程序化地
映射到一个「挂载 debugfs」按钮），`detail` 给人看。
只给自由文本，等于每个包一种写法，AI 读不懂，降级提示无法被程序化消费。

**码表保持最小**：具体性由 `detail` 承担，不为每个路径变体新增一个码。

> **别把「动作没验证」塞进这张表。**
> 本表是 **tag 读数**的原因码；**动作执行**的原因码在 `04` §2.4
> （`readback_mismatch` / `denied` / `not_found` / …）——**两张表，别混**。
> 「动作执行了但没有回读」既不是 tag 状态、也不是本表的码：
> 它是动作结果上的一个**独立布尔字段 `verified`**（`04` §2.4）。
> `unverified` **不是** tag 状态——加进五态模型会污染所有 tag 消费者。

> **卡片 API 的错误码与这张 `reason` 码表共用一套词汇**——
> 不给 AI 两套需要互相翻译的方言。

### 2.2 谁负责算什么

| 谁 | 负责 |
|---|---|
| **reader** | 判断这次读**成没成**：产出 `ok` / `pending` / `unavailable` / `error` |
| **运行时** | 判断值**新不新**：把 `ok` 降级成 `stale`，并做 §2.1 的状态迁移 |

所以：**reader 不产出 `stale`。** `stale` 是一个关于「时间」的判断，而 reader 只知道
「我刚才读到了什么」。运行时知道上一次成功是什么时候，所以由它来决定一个值是否还新鲜。

这条分工很重要，因为它让 reader 保持纯函数：给它同样的输入，它给出同样的输出。
`stale` 依赖历史，所以它不属于 reader。

### 2.3 新鲜度

**运行时**把一个 tag 标为 `stale` 的条件是：**最后一次成功读到现在，超过了 3 × 该 poll
group 的刷新周期**。

这个倍数由契约固定，board pack 不能改。原因很简单：不同板子刷新快慢差很多，
如果每个包自己定「多久算过时」，那 `stale` 就成了一个没有统一含义的词，
AI 和卡片都无法据此判断。

注意 `stale` 有**两个触发路径**，都是同一个状态：

1. **刷新失败**——本次 poll 没能读出来，但保留着上一次的值，标记为 `stale`。
2. **刷新停了**——整个 poll group 停止被轮询（连接断了、程序挂了），
   值本身还在，但已经过了 3 倍周期。

两者都是「值可能不准了」，卡片上的处理是一样的：**显示值 + 标出已过时**。

**两条路径的优先级**：同一次刷新里如果**既失败又超时**（例如超时后紧接着连接断开），
按 **`stale`** 处理，不进 `error`。理由：`stale` 说的是「值可能不准」，
`error` 说的是「这次读出来的值坏了」——超时并没有读出任何坏值。
只有**读出了值但值不合法**（越界、类型不符、解析出乱码）才是 `error`。

**超时后本周期是跳过还是重试**：本周期**跳过**，不立刻重试。
理由是旧工程的实测：每文件一次 `adb shell` ≈ 30ms，失败后立刻重试会在连接不稳时
把板子打满，并把 `/proc/stat` 的采样窗口搅乱。下一次按 poll group 的正常周期重试。

**重连后的状态**：连接断开又恢复时，该连接下**所有** tag 一律先转 `unavailable`，
再按 §2.1 正常迁移（需要两次采样的转 `pending`）。不允许把断线前的旧值直接恢复成 `ok`——
那正是「显示 0% 负载的按钮其实没连上」这类谎言的来源。

---

## 三、刷新模型

### 3.1 谁在轮询

**运行时是唯一的轮询者。** 卡片订阅，agent 查询，都不自己轮询。

理由在旧工程里有实测记录：每个文件 spawn 一次 `adb shell` 大约 30 ms，而且 fork 出来的
shell 自己的 CPU 时间会记进 `/proc/stat`，让板子看起来 100% 忙。N 张卡各自轮询，
负载就是 N 倍。

### 3.2 轮询的单位是 poll group

board pack 把 reader 分成 **poll group**（见 `02-board-pack.md` §1.2）。
**一个 group = 一次往返 = 一个刷新周期。**

同组的所有 reader 合成一条命令取回，每个 reader 的输出用 marker 隔开，所以一个 reader
挂了不影响同组其他 reader。

这解决了两个实测事实的冲突：`/proc/stat` 必须每秒采一次（占用率是两次采样做差），
而 `/proc/device-tree/model` 一天不变。合成一条命令会让 model 每秒被重读一次，
白费 30ms，还多一份 fork 的 CPU 噪声。

因此：

| 概念 | 归属 | 周期 |
|---|---|---|
| poll group | board pack | 组自己的 `interval_ms` |
| reader | board pack | 继承所在 group 的周期 |
| tag | board pack | 继承其 reader 的周期 |
| 刷新推送 | 运行时 | 按 group 周期 |

**card manifest 里的权限和降级判断用的是 tag 名，与轮询无关。**

### 3.3 首次读的特殊性

有些量必须**两次采样做差**才能算出来（CPU 占用率就是这样）。这类 tag 在第一次读时返回
`pending`，第二次起才有值。

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

**「保留」不等于「已实现」**：词表里 `v1: reserved` 的条目（`board.kernel`、`net.*`、`disk.*`）
语义已经占位、名字已经占住，但 v1 不要求任何板型包提供。
它们**不是**「漏实现了」——板型包不提供它们是合规的，卡片引用它们按 §五 走降级。
这样做的目的是：等这些量真的被两块板实现时，名字不必另起，不必升契约版本。

**「语义已占位」的名字也不许被实现者改写。** `reserved` 条目一旦被某块板实现，
它的语义必须与词表里写的一致；实现者不得借「反正还没实现」自行定义语义。

---

## 七、一个具体的坑：当心 duty cycle

这条值得单独立，因为它是真实踩过的：

> 某厂商的 devfreq `load` 文件读出来是 `<duty>@<freq>Hz`。这个 duty 是**时钟占空比**，不是**利用率**。板子空闲时它读 100（时钟满速待命），板子满载时它读 100（真的在算）。用它当利用率，空闲的板会显示 100% 忙。

正确的来源通常是另一处（该厂商的 debugfs 或 sysfs 属性）。

**契约层面的要求**：核心词表里的每个量，其「语义」一栏必须写清楚**它到底代表什么**。
「利用率」不够，要写「当前读数：执行非空闲指令的时间占比，采样窗口由驱动决定」。
写不清楚的量，不要进核心词表。

> **不要写「过去 1 秒」除非确实是 1 秒。** CPU 占用率是**我们**做两次采样做差算出来的，
> 所以它的窗口确实是两次采样间隔；GPU/NPU 的 devfreq 与 debugfs 读数是**驱动**给的快照，
> 窗口由驱动决定。把这两种都写成「过去 1 秒」会让 agent 以为它们可以互相比较，
> 也会让实现者去写一个根本做不到的滑动窗口。

---

## 八、名词对照

| 契约名词 | 含义 | 现有代码对应 |
|---|---|---|
| tag | 一个可命名的标量量测 | `Metrics` 里的一个字段（如 `cpu_total`） |
| 状态 | ok / stale / unavailable / error / pending | `Metrics` 里的 `None` 与 `ok` 标志 |
| reader | 一次往返取回的一批数据 | `SNAPSHOT_SCRIPT` 那段脚本 |
| board pack | 一块板的 YAML 数据包 | 不存在（散落在 `metrics.py` 里） |
| 动作 | GUI → 板的一次受控写入 | 不存在 |

