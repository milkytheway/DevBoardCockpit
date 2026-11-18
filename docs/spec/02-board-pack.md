> **来源与修订**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex，提交 `c24b084`）。
> 契约层为**权威文档**。**迁入后经 `0244852` 修订过**，2026-11-12 的评审又做了一轮修订
> ——逐节来源见 `00-overview.md` §一之二。落地方式见 `docs/04-架构设计.md`。
>
> **2026-11-13 修订（计划 2 前置拍板）**：能力词表与词义对照表（§10.3）、
> 回读形式 5 `kind: none`（§4.4 / §4.5）、校验规则 25/26/27（§七）。
> 依据 `docs/05` 的 **ADR-D24 / D25 / D26**，走「**v1 定稿前的修正**」口径：
> **不升 `apiVersion`**（`devboard/v1` 尚未随任何实现发布），
> 但**一次成文、一次评审**，不零敲碎打。
> 本次**没有改动任何既有 tag 的语义**——核心词表里的语义永不改变（§六）。
# 板型包（board pack）格式

> 一块板 = 一个 YAML 文件。板型差异全部住在这里，不进核心代码。
> 支持一块新板 = 提交一个包，不是等发版。

---

## 一、一个包长什么样

```yaml
# profiles/boards/rk3588-atk/board.yaml
apiVersion: devboard/v1
kind: BoardPack

id: rk3588-atk
name: 正点原子 ATK-DLRK3588
version: 1.0.0
description: RK3588，Buildroot 6.1.141，8 核（A55×4 + A76×4）

requires:
  transports: [adb, serial, ssh]     # 三种都支持
  # 板级能力（封闭词表，见 §10.3）。**不要写 `stream`**：
  # Stream 的业务契约还没定（`00-overview.md` §七），声明了也给不出来——
  # 校验规则 26 会把它当**错误**拦下。
  capabilities: [shell, exec, files]
  min_contract: devboard/v1

# 危险地板表的版本（§5.2.1）。不写默认按 1。
danger_floor_version: 1

# 自动识别：连接没指名 board_pack 时，运行时读板子的型号来匹配。
match:
  mode: substring                   # exact | substring
  models: [ATK-DLRK3588]

# 轮询分组：一个组 = 一次往返。
poll_groups:
  - id: fast
    interval_ms: 1000
    readers: [cpu, gpu, npu]
  - id: slow
    interval_ms: 2000
    readers: [mem, temp]
  - id: rare
    interval_ms: 30000
    readers: [board, npu_devfreq]

# 数据从哪来。reader 产出 sample，provides 把 sample 绑成 tag。
readers:
  - id: cpu
    kind: proc_stat
    args:
      stat_path: /proc/stat
      cpuinfo_path: /proc/cpuinfo
    provides:
      - tag: cpu.usage
        sample: usage
      - tag: cpu.core.*.usage
        sample: core.*.usage
      - tag: cpu.core.*.cluster
        sample: core.*.cluster

  - id: gpu
    kind: devfreq_load
    args:
      path: /sys/class/devfreq/fb000000.gpu/load
      measure: utilization           # utilization | duty_cycle
    provides:
      - tag: gpu.usage
        sample: duty
      - tag: gpu.freq_hz
        sample: freq_hz

  - id: npu
    kind: rknpu_load
    args:
      path: /sys/kernel/debug/rknpu/load
    provides:
      - tag: npu.usage
        sample: usage
      - tag: npu.core.*.usage
        sample: core.*.usage

  - id: mem
    kind: meminfo
    args:
      path: /proc/meminfo
    provides:
      - tag: mem.total_bytes
        sample: total_bytes
      - tag: mem.used_bytes
        sample: used_bytes
      - tag: mem.usage
        sample: usage

  - id: temp
    kind: thermal_zone
    args:
      glob: /sys/class/thermal/thermal_zone*
      type_map:
        soc-thermal: soc
        gpu-thermal: gpu
        npu-thermal: npu
    provides:
      - tag: temp.soc
        sample: zone.soc
      - tag: temp.gpu
        sample: zone.gpu
      - tag: temp.npu
        sample: zone.npu

# 这块板能接受什么写入。每个动作都要声明危险等级和怎么回读。
actions:
  - id: backlight.set
    label: 设置背光亮度
    danger: reversible          # reversible | destructive
    params:
      value:
        type: integer
        min: 0
        max: 255
    # 参数域（§5.5）：这个范围内算「温和」，超出走单独确认
    guard:
      value: {min: 16, max: 255}
    command: "echo {value} > /sys/class/backlight/backlight/brightness"
    readback:
      kind: file_equals
      path: /sys/class/backlight/backlight/brightness
      expect: "{value}"
      tolerance: 1

# 这块板特有的量。不进核心词表，别的板不保证有。
custom:
  - id: npu_devfreq
    kind: devfreq_load
    args:
      path: /sys/class/devfreq/fdab0000.npu/load
      measure: duty_cycle
    provides:
      - tag: custom.rk3588-atk.npu.duty
        sample: duty
```

### 1.1 sample 与 tag：两个命名空间

这是本格式最重要的一条。

**reader kind 产出的是 sample，不是 tag。** sample 是 reader 内部的相对名字（`usage`、
`core.3.usage`、`duty`）；tag 是全局限定名（`cpu.usage`、`cpu.core.3.usage`、`gpu.usage`）。

pack 用 `provides` 把两者**显式**连起来：

```yaml
provides:
  - tag: cpu.core.*.usage     # 目标名字
    sample: core.*.usage      # 来源样本
```

`*` 的位置一一对应：sample `core.3.usage` 绑成 tag `cpu.core.3.usage`。

**为什么不让 reader 直接产出 tag**：一个 kind 要服务多块名字不同的板。`devfreq_load`
产出 `duty` 和 `freq_hz`；RK3588 的包把 `duty` 绑成 `gpu.usage`，另一块板可以把同一个
`duty` 绑成 `custom.<那板>.gpu_duty`——**一行代码都不用改**。

**为什么不让 reader 直接产出 tag（另一个角度）**：两个不同 kind 的 reader 就不会在同一个
tag 上撞车。撞车只可能发生在 `provides` 写重的地方，而那是校验器能查的。

**两个命名空间的长度不必相同**（`cpu.core.*.usage` 是四段，`core.*.usage` 是三段），
但**通配符的数量必须一致**，且 sample 的字面段要与具体样本**逐位对上**
（`core.*.usage` 匹配 `core.3.usage`，不匹配 `core.3.cluster`）。

tag 与 sample 之间**不逐位比较**：它们在不同命名空间，`gpu.usage` 合法地绑定 sample
`duty`——是包的 `measure: utilization` 说明了「这个 duty 读数**就是**利用率」。
**sample 的字面说的是「读到了什么」，tag 的字面说的是「这意味着什么」。**

### 1.2 轮询分组

一个 **poll group = 一次往返**。同组的所有 reader 合成一条 shell 命令，一次取回，
每个 reader 的输出用 marker 隔开。

```
echo '###R cpu STAT'; ...; echo '###E cpu' ; echo '###R gpu LOAD'; ...; echo '###E gpu'
```

分组存在是因为两条实测事实打架：

- 每个文件 spawn 一次 `adb shell` 约 30ms，而且 fork 出来的 shell 自己的 CPU 时间会记进
  `/proc/stat`，让板子看起来 100% 忙。
- 但 `/proc/stat` 必须每秒采一次（占用率是两次采样做差），而 `/proc/device-tree/model`
  一天不变。

合成一条命令 ⇒ 每秒重读 model，白费 30ms，还多一份 fork 的 CPU 噪声。
一个组全包 ⇒ 同上。

分组把这件事说清楚了：**快的东西和慢的东西分开取。**

组内某个 reader 挂了，**不影响同组其他 reader**：每个 reader 有自己的 marker，
section 是空的就算它不可用。

每个 reader **必须属于恰好一个 group**——没组 = 没有往返 = 永远读不到。
校验器会拦。

#### 1.2.1 一次往返的互斥（串口上尤其要紧）

**同一个连接上，同时只能有一次往返。** poll group 的采样往返与动作往返
（`§四`）共享同一条通道，必须串行化。

这在串口上是硬约束：命令通道和交互终端**共用一根线**（旧工程事实 S1），
只有**一个读线程 + 一份 transcript**，命令靠 marker 认领自己的回包。
两次往返并发时，两个 marker 的回包会在同一条 transcript 里交错，
表现为「点了按钮，监控卡数值乱跳」。

**规则**：

| 项 | 规则 |
|---|---|
| 排队 | 一个连接上有一个往返队列，poll group 的采样与动作都进同一个队列 |
| 优先级 | **动作优先于采样**。动作在队列里等采样时，采样让路 |
| 串口单行 | 串口上一次往返只能是一行命令（事实 S6）；多行脚本压成一行 |
| 采样让路 | poll group 的采样若因动作让路而错过本周期，**跳过本周期**，不补发 |
| 超时清理 | 往返超时后必须**等 marker 收齐或明确放弃该 marker**，才能开始下一次往返 |

**跳过而不是补发**：补发会让一个已经落后的采样窗口变得毫无意义
（`/proc/stat` 的差值算的是两次采样的间隔，间隔不固定就没有意义）。

> **这条不是理论洁癖。** 事实 S2 说得很清楚：板子会**回显**命令，
> 所以 marker 在 transcript 里出现**两次**（回显一次、输出之后一次）。
> 并发往返时，回显与输出无法配对——这正是旧工程用 marker 协议的原因，
> 而 marker 协议的前提是「一次只有一条命令在飞」。

---

## 二、reader kind：为什么是「有版本的少量内置 + 逃生门」

### 2.1 问题

RK3588 上的量不是同一种形状：

| 量 | 形状 |
|---|---|
| CPU 占用率 | **两次采样做差**（有状态） |
| 每核名字（A55/A76） | 跨文件**按索引 join** |
| GPU 占用率 | `<pct>@<freq>Hz`，只取第一个数 |
| NPU 占用率 | `Core0: 12%, Core1: 9%`，一行多值 |
| 温度 | **glob 遍历**后按 `type` 文件的名字归并 |

只有「模式匹配」这一种形状能写成纯声明式。其余三种都不是。

### 2.2 三条出路

| 方案 | 形态 | 代价 |
|---|---|---|
| **纯声明式** | pack 里只有 {source, path, pattern, transform} | 表达不了「做差」和「跨文件 join」。要么在 YAML 里长出一套微型表达式语言（比代码更糟），要么最重要的 CPU 占用率根本写不进去。 |
| **代码绑定** | 每个 tag 绑到注册表里的一个函数 | pack 不再自解释——AI 必须读代码才知道 `proc_stat_delta` 干什么。新板从「交一个包」变成「写一段代码再交一个包」。 |
| **混合（采用）** | 少量有版本的内置 kind + 逃生门 | 多一层间接：AI 要知道 `proc_stat_delta` 是干嘛的。 |

### 2.3 选定：混合

采用第三种。理由是它保住了 pack 的**自解释性**：

> **一个 AI 读完 pack 的 YAML 和 kind 的说明书，就知道这块板的一切，不需要执行任何东西，也不需要读源码。**

kind 的说明书是契约的一部分（`01` 与本文档之间），是一份**有版本的、有限的**清单。清单封闭 = AI 的心智模型封闭 = AI 写卡时不会猜。

### 2.4 内置 reader kind 清单（v1）

这些 kind 在所有板上是同一份实现，所以：

- 实现一次，全板复用
- 可单元测试（不需要真板）
- 行为有版本号，可随契约升版

每个 kind 声明三件事：**接受什么参数**、**产出什么 sample**、**怎么从板子上取**。

| kind | 参数 | 产出的 sample | 备注 |
|---|---|---|---|
| `proc_stat` | `stat_path`, `cpuinfo_path` | `usage`, `core.*.usage`, `core.*.cluster` | **需要两次采样**，首次为 pending |
| `meminfo` | `path` | `total_bytes`, `available_bytes`, `used_bytes`, `usage` | 单次即可 |
| `devfreq_load` | `path`, `measure` | `duty`, `freq_hz` | `measure` 说明 `duty` 是什么，见下 |
| `rknpu_load` | `path` | `usage`, `core.*.usage` | vendor 专有格式，RK 专属 kind |
| `thermal_zone` | `glob`, `type_map` | `zone.*` | 按 `type` 归并，不按序号 |
| `file_read` | `path`/`glob`, `format`, `strip_trailing_null` | `value` | 逃生门 1：最通用 |
| `exec_regex` | `command`, `pattern`, `format` | `value` | 逃生门 2 |
| ⛔ `script` | `path`, `interpreter`, `format` | （脚本 JSON 的键） | **已封存** —— **规则 31 禁用** ✓ · **实现里有** ✓ 但**不许包用** ✓ · 理由见 §三.3 |

这张表是**契约的一部分**，它的机器可读形态由实现层提供：实现层必须有一份
reader kind 注册表，声明每个 kind 的参数 schema、产出的 sample、是否需要两次采样、
取数用的 shell 片段。

校验器检查 pack 声明的参数在 kind 的 schema 里存在——**拼错参数名会被拦下**，
而不是静默用默认值。

**关于 `devfreq_load` 的重要警告**：devfreq 的 `load` 文件读出 `<duty>@<freq>Hz`，
这个 duty 是**时钟占空比**，不是利用率。空闲时读 100（时钟满速待命），满载也读 100。

所以 `devfreq_load` 必须带一个 `measure` 参数声明它读的是什么：

```yaml
  - id: gpu
    kind: devfreq_load
    args:
      path: /sys/class/devfreq/fb000000.gpu/load
      measure: utilization      # utilization | duty_cycle
    provides:
      - tag: gpu.usage
        sample: duty
```

`measure: duty_cycle` 的包**不能**把 `duty` 绑到任何 `*.usage` 上（核心词表的
`gpu.usage` 语义是利用率）。校验器必须拒绝这个组合。这是把旧工程
`core/metrics.py` 里那个踩过的坑（「NPU 的 devfreq load 文件空闲时读 100@1000000000Hz。
那是占空比，不是利用率」）变成机器可检查的规则。

**`measure` 不是可选的**：绑到 `*.usage` 而没声明 `measure`，校验器报错。
沉默的默认值会骗人——「没说是利用率」不能当成「是利用率」。

---

## 三、逃生门

混合方案必须留门，否则遇到没预料的板就无路可走。三个级别，按优先顺序用：

### 3.1 `file_read` —— 读一个文件

最常用。适合「某个值就是一个文件里的一个数」：

```yaml
  - id: brightness
    kind: file_read
    args:
      path: /sys/class/backlight/backlight/brightness
      format: integer
    provides:
      - tag: custom.rk3588-atk.backlight.brightness
        sample: value
```

### 3.2 `exec_regex` —— 跑一条命令，正则取

适合「这个值要算一下」：

```yaml
  - id: uptime
    kind: exec_regex
    args:
      command: "cat /proc/uptime"
      pattern: "^([0-9.]+)"
      format: float
    provides:
      - tag: custom.rk3588-atk.uptime_s
        sample: value
```

**注意**：`exec_regex` 有安全含义——它在板子上执行任意命令。
校验器会对它报警告（§七 规则 19），运行时对它执行的动作**记审计**（§3.3 末段）。

**但 `exec_regex` 不是动作，所以它不过危险地板、也不需要用户授权。**
这意味着：一个 **agent 写的板型包**可以在 reader 里塞一条任意命令，
绕过「破坏性动作要人确认」这条链。契约对此有明确处置（§5.6）。

### 3.3 包内脚本 —— ⛔ **已封存**（曾有的第三个逃生门）

> **这一节记的是「为什么封存」，不是「怎么用」** ✓
> —— **用法已经不存在了** ✓（下面 §三.3.1 只留历史 ✓）。

**曾经有过第三个逃生门** ✓：包里带一个脚本 ✓，运行时把它推到板子上 ✓，
每次 poll 带上路径执行它 ✓，脚本输出 JSON ✓，键就是它提供的 sample 名 ✓。

**为什么封存** ✓（**这是本节唯一还活着的内容** ✓）：

| 理由 | 说明 |
|---|---|
| **脚本正文一个字都没查** ✓ | 危险地板（§5.2 ✓）匹配的是**命令词元** ✓ —— 而脚本的正文**根本不是命令** ✓ → **地板看不见它** ✓ |
| → 于是它成了**绕过地板的那条路** ✓ | 一个包可以带一个 `rm -rf /` 的脚本 ✓，而它的 `kind` 看着像**只读 reader** ✓ |
| → 所以**封掉** ✓ | **规则 31** ✓：板型包里不许用 `script` kind ✓（校验器当场拦下 ✓） |
| → **但实现里它还在** ✓ | `src/main/tags/kinds/script.ts` ✓ —— **它没有被删** ✓ → **它是「潜伏的」** ✓ |

> ⚠️ **「潜伏」的意思** ⚠️：**实现里有 ✓ · 校验器不让用 ✓** ——
> → **所以契约不能把它当可用项来教** ✓ → **本节只留理由** ✓
> → **如果将来要重开它**，得先解决「地板看不见脚本正文」这件事 ✓
> （**那是契约级的问题** ✓ · **不是加个开关** ✓）

#### 3.3.1 · 历史（⛔ **已不适用** —— 保留作历史，别照着实现）

> ⚠️ **下面这些是封存之前的设计** ✓ —— **运行时从未提供过这条路径** ✓
> （**不推脚本** ✓ · **不建 `/tmp/devboard-<session-id>/`** ✓）→
> **照着它实现就是实现一个不存在的东西** ⚠️。

- 脚本住在包目录里（宿主上）✓，但要读板子的状态 ✓ → 运行时须先把它推到板子上 ✓
  （一次会话一次 ✓，落在 `/tmp` ✓），之后每次 poll 只是带上路径执行它 ✓
- 脚本没推上去时命令跑不起来 ✓ → 那个 reader 的 tag 报 `unavailable` ✓
  （和其他资源不存在是同一种处理 ✓ · 不猜 ✓）
- 推到板上的路径由运行时决定 ✓（包不指定 ✓ —— `remote_path` 不是包的参数 ✓）
- 脚本的执行要记审计 ✓（与动作一样进审计日志 ✓ · §5.4 ✓）——
  ⚠️ **但它没有 `danger` 分级** ⚠️ → **那正是问题所在** ✓
  （「读侧的能力」却能改板子状态 ✓ → **分不了级** ✓ → **地板也管不到** ✓）

---

## 四、动作（控制面）

### 4.1 为什么动作不能只是命令

如果控制面只有「发一条命令」，那它就是遥控器，不是驾驶舱。

**驾驶舱的定义**：按钮显示的是板子的**真实状态**，不是你上次点的意图。

所以每个动作必须声明**怎么回读**：

```yaml
actions:
  - id: npu.pipeline.start
    label: 启动推理管线
    danger: reversible
    params:
      # 字符串参数必须声明 maxLength —— 没有上限的字符串参数就是注入面（§4.6）
      model: {type: string, maxLength: 64}
      fps:   {type: integer, min: 1, max: 60}
    command: "/usr/local/bin/pipeline start --model {model} --fps {fps}"
    readback:
      tag: custom.rk3588-atk.pipeline.running
      expect: true
```

> **这个示例正是注入面的教材**：`model` 是字符串，而命令模板把它原样拼进 shell。
> 按 §4.6，运行时会把它的值单引号包裹并转义 `'`，
> 所以 `yolov8n; reboot` 只会变成一个**无害的参数值**。
> 这也说明为什么 `string` 参数必须声明 `maxLength`（校验规则 20）。

三件事同时成立才算闭环：

1. **点击** → 发命令
2. **回读** → 读 `readback.tag` 确认板子实际状态
3. **UI 以回读为准** → 按钮显示的是 `readback.tag` 的值，不是你点了没点

如果回读失败（命令返回了但状态没变），卡片应该显示「命令已发出，未确认生效」，而不是乐观地显示成已开启。

**每个动作都必须声明 `readback`**（**规则 27**）——
不只是 `destructive`，**`reversible` 也一样**。
早期版本只有规则 15 管 `destructive`，于是**一个 `reversible` 动作不写 `readback` 也能过校验**：
闭环静默断掉，这是真洞。

确实没有可回读状态的动作走**形式 5 `kind: none`**（§4.4.1）——
但它**必须显式写**，且只限 `reversible`。

### 4.2 危险等级

| 等级 | 含义 | 例子 | 行为 |
|---|---|---|---|
| `reversible` | 可逆，误操作能恢复 | 开关一个开关、改采样率、启停服务 | 直接执行，但记审计日志 |
| `destructive` | 不可逆或影响全局 | 重启板子、刷固件、格式化 | **必须二次确认** |

**只读不是动作**——只读走 tag。动作一律是写。

> **只有两档。** 早期版本写过三档（`read` / `reversible` / `destructive`），
> 与本契约冲突，已按**契约口径**统一：只读走 tag，不是一种动作。
> 文档 `docs/05` 的 ADR-D7 已同步改写。

> **「reversible」不等于「无害」。** 它只承诺「**能恢复**」——把背光调到 0、
> 把 governor 设成 `powersave`，都能恢复，但用户会以为板子坏了。
> 所以授权界面必须显示**参数范围**（见 §5.5），而不是只显示动作名。

### 4.3 参数

参数是**声明式**的，不是字符串模板里的自由文本：

```yaml
params:
  fps: {type: integer, min: 1, max: 60, default: 30}
```

`type` 的取值是**封闭的**，只能取以下之一：

| type | 必填字段 | 说明 |
|---|---|---|
| `integer` | — | 可选 `min` / `max` / `default` |
| `number` | — | 可选 `min` / `max` / `default` |
| `string` | `maxLength` | 可选 `pattern`（正则）与 `default` |
| `boolean` | — | 取 `true` / `false` |
| `enum` | `values` | `values` 是**非空字符串列表**，取值必须逐一命中 |

好处：

- 校验器能在执行前检查范围
- MCP 的 `execute_action` 能返回参数 schema，让 AI 不用猜
- 危险动作的参数范围是安全边界的一部分（`max: 60` 防止 AI 把帧率设成 100000）

**`string` 参数必须声明 `maxLength`。** 没有上限的字符串参数就是注入面
（§4.6）。默认上限建议 256 字节。

### 4.4 回读的五种形式

`readback` 是一个块，五选一：

```yaml
readback:
  tag: some.tag            # 形式 1：读一个 tag（最常见）
  expect: true             # 期望值，不符则报「未确认生效」
```

```yaml
readback:
  kind: file_equals        # 形式 2：读文件比值
  path: /sys/class/backlight/backlight/brightness
  expect: "{value}"        # 与哪个参数比；可以是参数名
  tolerance: 1
```

```yaml
readback:
  kind: command_ok         # 形式 3：命令本身返回 0
```

```yaml
readback:
  kind: verify             # 形式 4：二次验证（见下）
  command: "test -e /tmp/marker"
  timeout_ms: 5000
```

```yaml
readback:
  kind: none               # 形式 5：这个动作没有可观测状态（见下）
  consequence: "点亮板载 LED 约 1 秒后熄灭"    # **必填且非空**
```

形式 1 是首选，因为它自动复用已有的 tag 通道。

#### 4.4.0补 · 跨目标的判据（流程层，`05` §五）

本文的五种形式**都在「执行的那条连接」上回读** ✓（§5.2 的执行与回读不可拆分 ✓）。

但流程层有一种情况是**跨机器**的 ✗：「客机跑完 scp 之后，**板子上**真的有那个文件吗」
——那是**另一台机器**的事实 ✗ → 它**不在**执行的那个事务里 ✓。

→ **跨目标的判据由流程层跑** ✓（`05` §五 ✓）→
**两个事实、两行账** ✓（命令一行 ✓、判据一行 ✓）。

> 流程层**仍然复用本文的五种形式** ✓（不新增第六种 ✓），
> 只是多了一个 `role`：「**在哪个角色上读**」✓。

### 4.4.1 形式 5 `kind: none`：确实没有可回读状态的动作

有一类动作**真的没有可回读的状态**：点亮一颗 LED、往某个 UART 写一串字节、
触发一次蜂鸣。**契约不能假装它们存在**——也不能因为它们不存在就把这条路堵死。

所以有第五种形式 `none`。但它是一扇**窄门**，四条规矩：

| 规矩 | 内容 | 为什么 |
|---|---|---|
| **必须显式写** | 不写 `readback` **不等于** `none`——**规则 27** 拦下漏写 | 「不写」与「写 none」是两件事，只有后者是**声明** |
| **`consequence` 必填非空** | 一句话说明副作用，如「点亮板载 LED 约 1 秒」 | 把「声明用户可见后果」从自然语言变成**机械可查的字段**——不写就过不了校验 |
| **只允许 `danger: reversible`** | `destructive` **仍禁止** `none` | 不可逆动作不许「不验证」。若某个 destructive 动作真的没有可观测后态，**唯一的合法路径是加一条 `verify` 命令**（如 `test -e /tmp/marker`）——那正是 §4.5 的 `verify` 存在的意义。连 `verify` 都做不到的动作，**v1 就不许声明** |
| **逐动作 warning + 审计留痕** | 校验器对每个用 `none` 的动作记一条 warning；审计日志要能一眼看出「未验证」 | `unavailable ≠ 0` 防的是「把没读到当读到」；这条防的是「把没验证当不用验证」。**可见性就是主要防线** |

**执行结果怎么标**：`ok: true` + **`verified: false`**（`04` §2.4）。
**不写 `ok: false`**——命令确实执行了、效果也确实有（点 LED 亮了），
报失败是另一种撒谎；**也不写 `ok: true` 什么都不说**——
把「没验证」藏起来，正是选项「用 `verify` 跑一条恒真的命令」被否掉的同一个毛病。

> **`verify` 块里不允许 `kind: none`。**
> `verify` 是 §4.5 的**另一个块**（有 `command` / `timeout_ms` / `expect`）。
> 给它加 `kind: none` 会让「没有回读」有**两种**写法，
> 校验器就得同时认两种表达同一件事的写法——**只留 `readback: {kind: none}` 一种**。


**`expect` 可以写参数名**：`expect: "{value}"` 的意思是「读完文件后，
它的值应该等于这次调用的 `value` 参数」。这比把期望值硬编码进包好。

`{param}` 的替换在 `command`、`readback.path`、**`readback.expect`** 三处都允许——
`{cpu}` 出现在 `/sys/devices/system/cpu/cpu{cpu}/cpufreq/...` 这种地方是必要的。
校验器**三处都扫**：只在一处出现过的参数算「死参数」，
在任何地方都没出现过的 `{param}` 算「未声明」。

### 4.5 `verify`：不可逆动作的验证形式

`command_ok` 只说明「shell 接受了这条命令」，不说明板子进入了目标状态。
对 `destructive` 动作尤其不够——重启命令返回 0，不等于板子重启成功了。

所以有第四种形式 `verify`：

| 字段 | 必填 | 含义 |
|---|---|---|
| `command` | 是 | 验证命令。命令**必须**返回 0 才算验证通过 |
| `timeout_ms` | 否 | 验证超时，默认 5000 |
| `expect` | 否 | 期望的退出码，默认 0 |

`verify` 的执行时机是**动作执行之后**（不是之前）。
执行流程：发命令 → 等板子重启 → 轮询验证命令直到成功或超时 → 超时则报「未确认生效」。

**`destructive` 动作必须有 `readback`（形式 1/2）或 `verify`（形式 4），
不得用 `command_ok`（形式 3），**也不得用 `none`（形式 5）**。** 校验器强制这条。

> **串口上没有退出码。** 旧工程实测：串口拿不到 exit status，
> 「有文本回包 = 0，超时 = 124」（`docs/02` 事实 S5）。
> 所以在串口传输上，`command_ok` 与 `verify` 都**不可用**——
> 运行时必须拒绝在这两种传输上执行依赖退出码的动作，而不是假装它成功。
> 串口上只能用形式 1（tag）或形式 2（file_equals）。

### 4.6 参数怎么进入命令（注入防线）

`command` 是模板，但**参数值不是原样拼进去的**。这是本契约的安全底线之一。

**规则**：

1. 参数值按 `type` 编码后再注入：
   - `integer` / `number` → 按十进制数字字面量注入，不带引号，不带任何其他字符；
   - `boolean` → `true` / `false`；
   - `enum` → 必须是 `values` 里的某一项，原样注入（`values` 由包作者写死并被校验）；
   - `string` → **单引号包裹**，内部 `'` 转义为 `'\''`，且长度不超过 `maxLength`。
2. **模板里写 `{param}` 的位置不要自己加引号**——编码由运行时统一负责，
   包作者加的引号会与运行时加的引号叠加，产生错误语义。
3. 校验器检查：`string` 参数若在包里带了引号包裹的占位（如 `'{value}'`），报错。
4. 运行时在执行前**再次**按类型校验（不信任包的自述），校验不过就拒绝执行并报
   `invalid_params`。

**为什么必须这样**：板端会话是 root 权限（`docs/02` 事实 A1/S1 一带的实测），
一条 `--model 'x; reboot'` 就能把「启动管线」变成「重启板子」，
而 `reboot` **不在这条命令的模板里**——所以 §5.2 的地板按模板匹配根本拦不住（见 §5.3）。

> **参数编码属于契约，运行时负责执行。** 包只声明类型与范围，不负责转义——
> 十个包作者会写出十种转义方式，其中九种是错的。

---

## 五、权限与安全

board pack 里的动作**不是**自动获准执行的。权限在卡片侧声明、在运行时授权。

### 5.1 分级

| 档 | 在哪 | 含义 | 授权 |
|---|---|---|---|
| 只读 | 卡片的 `permissions.read` | 读 tag | 不需要（tag 本身只读） |
| `reversible` | 板型包的 `danger: reversible` | 可逆写 | 装卡时问一次 |
| `destructive` | 板型包的 `danger: destructive` | 破坏性写 | 装卡时问一次 + 每次执行二次确认 |

**只读不是动作。** 只读走 tag，`permissions.read` 不需要授权流程。板型包里
也**没有** `danger: readonly` 的动作——动作一律是写。

授权是**按动作**的，不是一刀切。装一张卡不等于装上它所有动作的权限。

### 5.2 危险等级的地板

包自己声明 `danger`。但 agent 可以写包——如果没有任何别的约束，一个把 `reboot`
写成 `reversible` 的包就能把危险的动作说成安全的，**分档就成了摆设**。

所以有一条**地板**：

> **某些操作永远是 `destructive`，不管包怎么声明。**

地板是一份固定的操作模式表，属于**契约**，不属于任何一个包：

| 模式 | 匹配的操作 |
|---|---|
| `reboot` / `shutdown` / `poweroff` / `halt` | 重启与关机 |
| `flash*` / `upgrade` / `erase` / `burn` | 刷写存储 |
| `mkfs*` | 格式化 |
| `dd` 写到 `/dev/mmcblk` `/dev/sd` `/dev/nvme` | 裸写块设备 |
| `rm -rf /` 及其等价形式 | 删根 |
| `iptables -F` / `nft flush ruleset` | 清空防火墙规则 |

**地板在哪里生效** ✓（**2026-11-16 改** ✓ · ADR-D48 ✓）：

| 地方 | 做什么 |
|---|---|
| **校验器**（§七 **规则 16** ✓） | **一个把命中地板的命令声明成 `reversible` 的包 → 直接报错** ✓ → **那个包根本不加载** ✓ |
| **设置页的权限区**（`03` §2.4 ✓） | **危险的 action 在那一行标着「破坏性动作」** ✓ → **它的开关默认关** ✓ → **打开它就是那一下知情** ✓ |
| **运行时** | **不再复查** ✓ —— **不再「问危不危险」** ✓（用户 2026-11-16：「**一律都用权限**」✓） |

**地板是下限，不是上限。** 包**可以**把更多动作标成 `destructive`，
但不能把地板上的降级。

**为什么按命令模式匹配而不是动作清单**：要拦的是**命令**，不是动作 id。
`reboot` 可能藏在任何动作里：`system.reboot`、`board.power_cycle`、`do_a_soft_reset`。
按命令匹配，拦的是「这条命令到底做了什么」，而不是「这个动作叫什么名字」。

可执行的版本由实现层提供（一张命令模式表 + 一个匹配函数）。

#### 5.2.1 地板怎么匹配（匹配规范）

地板表是**契约**，所以匹配规则也必须是**契约**——否则不同实现会得出不同的判定。

**匹配对象是「解析后的命令」，不是模板。** 顺序固定：

1. 先按 §4.6 把参数编码进模板，得到**最终命令字符串**；
2. 把最终命令**按 shell 词法切分**成 argv 序列（不执行 shell，不做变量展开）；
3. 对 argv 序列做**地板匹配**。

**如果先匹配模板**，`pipeline start --model {model}` 里没有 `reboot`，
注入进来的 `reboot` 就永远匹配不到——地板形同虚设。

**匹配规则**：

| 项 | 规则 |
|---|---|
| 匹配单位 | argv 的**单个词元**（不是子串） |
| 词元相等 | `argv[i] == 模式` 才算命中；`upgrade_status.sh` **不**命中 `upgrade` |
| 前缀匹配 | 仅当模式以 `*` 结尾才允许前缀匹配（如 `flash*` 命中 `flash_uboot`、`mkfs*` 命中 `mkfs.ext4`） |
| 词元的 **basename 也算** | `/sbin/reboot` 的 basename 是 `reboot` → 命中 `reboot`。**真实的调用几乎都带绝对路径**——只按字面匹配，地板在真实写法上就是空的 |
| 路径类模式 | 先做路径规范化（展开 `..`、合并重复 `/`、去掉尾部 `/`），再比较 |
| `dd` 类模式 | 匹配 `dd` 词元 + **目标参数**命中块设备路径（`of=` 的值，或紧随其后的参数） |
| `rm -rf /` 类 | 匹配 `rm` + `-rf`/`-fr` 组合 + 路径参数规范化后等于 `/`。**`/*` 展开后就是根目录下的全部条目 → 等价于 `/`**（表里那条「及其等价形式」说的就是它） |
| 匹配失败的方向 | **匹配不上不等于安全**。表里没有的模式按包的声明走，但**运行时必须记录一条 warning** |

**地板表要有版本。** 它是契约的一部分，所以带 `danger_floor_version`：

```yaml
danger_floor_version: 1
```

v1 的表就是上表这六条。**改地板表 = 改契约**，要走评审并升 `apiVersion`。
包不声明 `danger_floor_version` 时，默认按 1 处理。

> **为什么「匹配不上不等于安全」要写进契约**：一张操作模式表永远不完整。
> 如果规则是「匹配不上就放行」，那漏写一条 = 开一个后门；
> 如果规则是「匹配不上就当 destructive」，那每条命令都要人确认，产品没法用。
> 所以取中间：**表内命中 = 强制 destructive；表外 = 照包的声明，但记 warning**。
> 记录下来的 warning 就是下一版地板表的输入。

### 5.3 dry-run

`dry_run: true` 时，返回「将会执行什么」，不执行：

```json
{
  "dry_run": true,
  "command": "/usr/local/bin/pipeline start --model yolov8n --fps 30",
  "readback_tag": "custom.rk3588-atk.pipeline.running"
}
```

> **`destructive` 的默认行为是「二次确认」，不是「默认 dry-run」。**
> 早期版本写过「默认 dry-run」，与二次确认互斥——
> dry-run 的返回值不是执行结果，用户确认完之后还得再跑一次，多一轮往返且容易漏。
> 现在的流程是：请求 → 用户在 GUI 里确认 → 才执行。
> `dry_run` 仍然可用，但它是 agent 主动的**预览**手段，不是 destructive 的默认行为。

### 5.4 审计日志

每次动作执行记一行：时间、**触发者**（卡片 id / agent / 用户）、动作 id、参数、
**最终命令**（编码后的 ✓）、**输入值**（流程层用 ✓）、结果、回读值。

> **为什么必须有「最终命令」与「输入值」** ✓：
> 只有动作 id 与参数，事后拼不出**到底执行了什么** ✗；
> 流程的输入更是在**流程包**里声明的（不在板型包里 ✓）→
> 不记它，事后只看到「跑了某一步」，看不到「**用了哪个工程**」✗。

**用 `none` 的动作（形式 5）必须在这一行里标出「未验证」**——
否则事后无法追责：日志上写着「成功」，读的人却不知道**没人验证过它**。

沿用旧工程 `core/session_log.py` 的形态（追加写、每行 flush、时间戳前缀）——那套已经被验证过：崩了也留下可读记录。

### 5.5 授权粒度：动作 id + 可选参数域

授权是**按动作**的（`03-card-manifest.md` §3.2），但只有动作 id 不够细：
用户批准「这张卡可以改背光亮度」，实际授予的是 `0..255` 全域，
包括把屏幕调到全黑。

所以动作可以声明一个**参数域**（`guard`），声明「这个动作在什么参数范围内算温和」：

```yaml
actions:
  - id: backlight.set
    label: 设置背光亮度
    danger: reversible
    params:
      value: {type: integer, min: 0, max: 255}
    guard:
      value: {min: 16, max: 255}     # 落在 [16,255] 内 = 温和；超出 = 需单独批准
    command: "echo {value} > /sys/class/backlight/backlight/brightness"
    readback:
      kind: file_equals
      path: /sys/class/backlight/backlight/brightness
      expect: "{value}"
      tolerance: 1
```

**语义**：

| 情形 | 行为 |
|---|---|
| 参数值落在 `guard` 内 | 直接执行（仍记审计） |
| 参数值超出 `guard` | **拒绝** ✓（`denied` ✓ —— **guard 是包作者划的界** ✓ —— **超出去就是不许可** ✓ —— 2026-11-16 起**不再有「问一次」** ✓ · ADR-D48 ✓） |
| 没有声明 `guard` | 等价于 `guard` = 参数的完整声明域，即不缩小范围 |

> **动作执行的原因码以 `04` §2.4 的表为准**——本表不再另立一个码。
> （历史：`needs_approval` → `needs_confirmation`（2026-11-14 ADR-D28）→
> **2026-11-16 起没有这一档了** ✓ —— **超域直接 `denied`** ✓ · ADR-D48 ✓。）

**`guard` 只能缩小范围，不能扩大。** 校验器检查：
`guard` 的区间必须是 `params` 声明域的子集，否则报错。

> **为什么让包声明 `guard` 而不是让用户在装卡时手填**：用户批准的是「让这张卡把背光调到 30」，
> 不是「让这张卡把背光调到 0」。参数域由包作者（可能是 agent）声明，
> 但**它只能缩小、不能扩大**动作本身的声明域——所以 agent 不能靠写一个宽 `guard` 来扩大权限。
> 用户的批准界面必须显示这个域（`03` §3.2）。

### 5.5补 · 流程层的授权与凭据（`05-workflow-pack.md` §7）

流程**不是动作**（它不在板型包里 ✓），但它**一样能在用户机器上执行命令** ✗
→ 它的入口必须**比动作更严** ✓：

| 项 | 规则 |
|---|---|
| **两层授权** | manifest 声明（`03` §2.4 ✓）→ **流程包 / 板型包本身被用户批过** ✓ → **两层都要过** ✓（**卡级那一层 2026-11-16 删了** ✓ —— ADR-D46 ✓） |
| **只认 id** | 卡片与 agent **给不了路径** ✓（只能按 id 取注册表里的包 ✓） |
| **批准绑摘要** | 改了内容 → **要重新批准** ✓（同 §5.6「升级不静默扩权」的同款理由 ✓） |
| **每个写步过地板** | 自由命令是**第二条命令通道** ✗ → 它必须与动作**同一条防线** ✓ |
| **凭据的绑定** | 动作：`(动作 id, 参数摘要, 包 id, 版本)`；**流程**：再加**这一步的输入摘要**与**这一步最终命令的摘要** ✓（`05` §7.5 ✓） |

### 5.6 谁能写板型包（reader 也能执行任意命令这件事）

**问题**：§5.2 的危险地板只管**动作**。但 `exec_regex` 是 **reader**——
它们在板子上执行任意命令，却不过地板、不需要用户授权。

而 `spec/04` §2.4.2 写着「**包一律生效**……agent 可以写板型包扩展，
写完直接用，不需要用户批准」。两条规则合起来就是：

> agent 写一个板型包，reader 里用 `exec_regex` 跑一条命令 ——
> 这条命令**不过危险地板、不需要人确认**，直接在那块板上跑。

这与「破坏性动作必须有人确认」这条产品底线是冲突的。

**处置：板型包 = 设备权限，不是卡片。**

| 规则 | 内容 |
|---|---|
| **谁能写板型包** | **人**。用户可以在本地编辑 `profiles/boards/`，也可以把一个包交给 agent **起草**；**包写好就生效** ✓（**板子描述文件说了算** ✓ · ADR-D46 ✓ —— 用户 2026-11-16：「**加一个板加啥就执行啥**」✓） |
| **生效的前提** | **没有额外的那道门** ✓ —— 但**包里的东西仍要过规矩** ✓：**动作**过危险地板与 `danger` 等级 ✓（§5.2 ✓）· **reader 的取数命令**过危险地板 ✓（**规则 28** ✓）· **tag / sample / 能力词表**过校验 ✓（§七 ✓） |
| **agent 起草** | agent 可以写文件（它的本职工作）✓ —— **但它写的东西照样过校验** ✓（**规则 28 就在校验里** ✓） |
| **装包失败不拖垮其它能力** | 某个包加载失败时，该连接相关的 tag 报 `unavailable`；终端与文件互传照常可用（§10.1 同理） |

> **为什么没有「启用前要人确认」这道门**（**2026-11-16 改** ✓ · ADR-D46 ✓）：
> → **用户要的** ✓：「**板子描述文件说了算**」✓「**加一个板加啥就执行啥**」✓「**这个也要同意那个也要同意不累吗**」✓。
> → **替代它的那道门是规则 28** ✓ —— **reader 的命令自己过地板** ✓（**这是 reader 唯一能越界的地方** ✓）。
> → **动作那条路一直都在** ✓：危险地板 ✓ + `danger` 等级 ✓ + **agent 侧仍要人点头** ✓（`04` §2.4.1 ✓）。

**为什么这样切**：`spec/04` §1.3 说「不准有裸 send_command」，
但一个能执行任意命令的 reader **就是**裸命令通道——
只是换了个入口。契约不能一边禁止裸命令，一边给 agent 一条同样的路。

**现在的处置**（**2026-11-16 改** ✓ · ADR-D46 ✓）：

| 选项 | 现在的结论 |
|---|---|
| **包一律生效**（agent 写的也生效） | ✅ **改成这样了** ✓ —— 用户原话：「**加一个板加啥就执行啥**」「**板子描述文件说了算**」✓ |
| **让 reader 也过危险地板** | ✅ **改成这样了** ✓ —— **规则 28** ✓（reader 的取数命令命中地板 → 包不过校验 ✓ → **不生效** ✓） |
| **完全禁止 `exec_regex` / `script` | ⚠️ **只禁了 `script`** ✓（**规则 31** ✓ —— **它执行的是正文** ✓ —— **地板看不见** ✓）；**`exec_regex` 留着** ✓（**它是逃生门** ✓）→ **但补了两道** ✓：**规则 29**（参数值不许含 shell 元字符 ✓）· **规则 30**（命令里不许有解释器 / 下载器 / 提权器 ✓ —— **包装起来就绕过了地板** ✓） |

> **「包一律生效」这条旧决策（`SPEC-D12`）不再收窄** ✓ —— **生效的是任何包** ✓
> （**但包要过自己的校验器** ✓ —— **规则 28/29/30/31 是那道门** ✓）。
>
> **2026-11-16 的独立评审查出来的洞** ✓（**规则的强度** ✓ —— 不是规则的条数 ✓）：
> **规则 28 只挡地板表里那几条词** ✓ → `bash -c 'rm -rf /'` **匹配不上** ✓ →
> **所以补了规则 29 与 30** ✓ —— **同一件事，写法不同结论相反** ✗ → **那不是设计取舍，是匹配器的洞** ✓。

---

## 六、pack 的版本

| 字段 | 含义 |
|---|---|
| `apiVersion` | 契约版本（`devboard/v1`）。格式本身变了这个才动 |
| `version` | 这个包自己的版本。包内内容变了就升 |
| `requires.min_contract` | 需要哪个契约版本以上 |

**核心词表里的语义永不改变。** 要改语义就升 `apiVersion` 并另起新 tag 名——绝不原地改一个已有 tag 的含义，否则所有已发布的卡片会在某次升级后悄悄说谎。

---

## 七、校验规则（validator 必须拦住的）

一个 pack 在被接受之前，至少要过这些检查。**这 31 条就是契约本身**——
实现层必须逐条实现，缺一条都不算实现了板型包格式。

校验器的命令入口由实现层决定（例如 `npm run validate:profiles`——**属计划 2，现在还不存在**），
但**规则本身以这张表为准**，不因实现而增减。

| # | 规则 | 为什么 |
|---|---|---|
| 1 | 每个 `provides[].tag` 匹配核心词表，或落在 `custom.<本包 id>.` 下 | 防止拼错和私自扩词表 |
| 2 | 两个 reader 的 tag **模式不得重叠** | `cpu.core.*.usage` 与 `cpu.core.3.usage` 会运行时撞车 |
| 3 | `devfreq_load` 且 `measure: duty_cycle` 时，`duty` 不得绑到任何 `*.usage` | 就是那个占空比坑 |
| 4 | `devfreq_load` 绑到 `*.usage` 时必须声明 `measure: utilization` | 沉默的默认值会骗人 |
| 5 | `proc_stat` 必须把 `usage` 绑到 `cpu.usage` | 首次 pending 语义 |
| 6 | 每个 `provides[].sample` 必须是该 kind 能产出的 sample | 绑定指向了不存在的数据 |
| 7 | tag 和 sample 的 `*` 数量必须一致，段数不必一致 | 两个命名空间，长度可以不同 |
| 8 | 每个 reader 声明的参数必须在 kind 的 schema 里存在 | 拼错参数名会被静默忽略 |
| 9 | 必填参数不能缺 | |
| 10 | 未知顶层字段报错 | 被静默忽略的字段就是拼错的字段 |
| 11 | `match.models` 必须是非空字符串列表，`match.mode` 只能是 exact/substring | 自动识别靠它 |
| 12 | 每个 action 的 `readback.tag` 必须是本包提供的 tag | 否则闭环断了 |
| 13 | 每个 action 的 `command`、`readback.path`、`readback.expect` 里的 `{param}` 都必须声明 | 拼错参数名到运行时才炸 |
| 14 | 声明了但没在任何地方用的参数是死参数 | 死参数 |
| 15 | `danger: destructive` 的动作必须有 `readback`（形式 1/2）或 `verify`（形式 4），**不得**用 `command_ok`，**也不得**用 `none`（形式 5） | 不可逆动作不能盲发 |
| 16 | 命中危险地板的命令必须声明为 `destructive` | agent 不能自己降级 |
| 17 | 每个 reader 必须属于恰好一个 poll group | 没组 = 没有往返 = 永远读不到 |
| 18 | poll group 的 `interval_ms` 不低于 200 | 太频繁会打爆板子 |
| 19 | `exec_regex` 存在时，打印警告 | 可执行任意代码（`script` 已被规则 31 全禁 ✓ · 这一条对它永远不会触发 ✓） |
| 20 | 每个 `params.<name>` 的 `type` 必须是 §4.3 表里的值；`enum` 必须有非空 `values`；`string` 必须有 `maxLength` | 类型封闭，否则校验器无从下手 |
| 21 | `command` 模板里的 `{param}` 占位**不得自带引号** | 引号由运行时统一编码（§4.6），叠加会出错 |
| 22 | `guard` 必须是 `params` 声明域的子集 | `guard` 只能缩小授权范围，不能扩大 |
| 23 | `readback` 的 `kind` 必须是 `file_equals` / `command_ok` / `verify` / `none` 之一（不写 `kind` 时按形式 1 读 tag） | 回读形式封闭 |
| 24 | `danger_floor_version` 若声明，必须是已知版本（当前只有 1）；未知顶层字段报错 | 被静默忽略的字段就是拼错的字段 |
| 25 | `requires.capabilities` 的每个值必须属于**封闭词表** `{shell, exec, stream, files}`（§10.3） | 拼错的能力名要有报错，不是静默忽略（与规则 24 同一条封闭性原则） |
| 26 | `requires.capabilities` 的每个值必须属于**运行时已实现的能力集**（v1 = `{shell, exec, files}`）。声明一个**给不出来**的能力是**错误**，不是警告 | 声明了但永远给不出 = 承诺一个不存在的交付。`stream` 因 Stream 契约缺失（`00-overview.md` §七）不在集内 |
| 27 | **每个 action 必须有 `readback` 块**，其 `kind` 属于 `{file_equals, command_ok, verify, none}`（不写 `kind` 按形式 1 读 tag）；其 `kind` 为 `none` 时**必须**带**非空**的 `consequence` | 只有规则 15 管 `destructive` → 一个 `reversible` 动作不写 `readback` 也能过校验 → **闭环静默断掉**。`none` 是唯一合法的「我没有可回读状态」的写法——**不许用「不写」表达同一件事** |
| 28 | **reader 的取数命令不许命中危险地板**（`exec_regex` 的 `command` 原样上板 ✓ → **它自己也要过地板** ✓） | **板型包直接生效** ✓（ADR-D46 ✓ —— 「板子描述文件说了算」✓）→ **「启用前要人确认」那道门没了** ✓ → **这条规则就是替代它的那道** ✓。reader **不是动作** ✓ —— 它不过执行器 ✓ —— **所以这里判** ✓ |
| 29 | **reader 的参数值不许含 shell 元字符**（`;` `|` `&` `` ` `` `$` `>` `<` 换行 ✓）。**例外**：`exec_regex` 的 `command` 与 `pattern` ✓ · `script` 的路径与解释器 ✓ | reader 的取数片段**会被拼进一条 shell 命令** ✓ → **值里带元字符 = 拼出第二条命令** ✓（**这是绕过地板的路** ✓）。**正则的元字符不算** ✓（正则不是 shell ✓） |
| 30 | **`exec_regex` 的 `command` 里不许有解释器 / 下载器 / 提权器**（`sh` `bash` `env` `xargs` `python*` `perl` `node` `curl` `wget` `nc` `busybox` `sudo` `su` …… **任何位置** ✓） | **地板表匹配的是词** ✓ —— `bash -c 'rm -rf /'` **一个词都不匹配** ✓ → **包装器就是绕过地板的那条路** ✓ → **所以这些词不许出现** ✓ |
| 31 | **板型包里不许用 `script` kind** | **它执行的是脚本正文** ✓ —— **正文一个字都没查** ✓ → **地板看不见它** ✓ → **别留一个「将来会开」的洞** ✓（运行时至今不给它推脚本 ✓ → **它是潜伏的** ✓） |

> **规则 20–24 是 2026-11-12 那轮评审新增的。** 前 19 条在 `0244852` 那次修订里就已经是契约的一部分，
> 后 5 条补的是评审发现的空洞：类型封闭、参数编码、`guard` 子集、回读形式封闭。
>
> **规则 25–27 是 2026-11-13 计划 2 前置拍板新增的**（依据 `docs/05` ADR-D24/D25/D26）：
> 前两条补的是 `requires.capabilities` **无人校验、无人消费**的洞——
> 24 条规则里**没有一条**检查它；后一条补的是「`reversible` 动作可以不写回读」这个闭环洞。
>
> **规则 26 读的是一张数据表，不是硬编码的 `if (stream)`。**
> Stream 契约落地那天，**改的是那张表，不是规则**。

**校验器不检查、运行时检查的三条**（因为它们依赖运行时状态）：

| # | 检查 | 在哪查 |
|---|---|---|
| R1 | 参数值落在 `guard` 内，否则 `denied`（**2026-11-16 改** ✓） | 运行时执行前 |
| R2 | 依赖退出码的 `command_ok` / `verify` 在串口上不可用 | 运行时执行前 |
| R3 | 地板表外的命令记一条 warning | 运行时执行前 |

---

## 八、目录布局

```
profiles/
  boards/
    rk3588-atk/
      board.yaml            # 板型包
      README.md             # 人类读的补充说明（怎么接、已知坑）
    rk3568/
      board.yaml
```

一个目录一个包。

> ⚠️ **包目录**不**再带 `scripts/`** ✓ —— `script` kind **已封存** ✓（规则 31 ✓ · §三.3 ✓）
> → 那条路**没有实现** ✓ → **目录里放脚本也不会被读** ✓

---

## 九、两个顶层列表：`readers` 和 `custom`

板型包有两个 reader 列表：

| 列表 | 里面的 reader | 它提供的 tag |
|---|---|---|
| `readers` | 板子通用能力 | 核心词表里的 tag（`cpu.usage` 等） |
| `custom` | 板子特有的能力 | `custom.<本包 id>.*` 里的 tag |

**两者的唯一区别是 tag 的命名空间。** 运行时对它们的处理完全一样：都要属于一个
poll group，都要用同一个 reader kind 表，都要有 `provides` 绑定。

分成两个列表是给人看的：读 `readers` 就知道「这块板通用的那些量」，
读 `custom` 就知道「这块板特有的那些量」。机器不区分。

---

## 十、包怎么绑到连接上

一个 board pack 描述「这块板是什么」，一个连接（连接 profile）描述「怎么连上这块板」。
两者是分开的，但运行时必须知道**哪个包配哪个连接**。

三种绑定方式，按可靠性排序：

| 方式 | 怎么定 | 优缺点 |
|---|---|---|
| **连接里指名** | 连接 profile 写 `board_pack: rk3588-atk` | 最明确，但每个连接都要写一遍 |
| **自动识别** | 读 `board.model`，按包的 `match` 规则匹配 | 省事，但要板子支持读型号 |
| **探测匹配** | 试几个包的 reader，看哪个能读出东西 | 慢，且可能误判 |

**采用「连接里指名 + 自动识别兜底」**：

```json
{
  "id": "board-adb",
  "label": "板子 · ADB",
  "transport": "adb",
  "options": { "pty": false, "prompt": "root@board" },
  "board_pack": "rk3588-atk",
  "device_key": "atk-01"
}
```

> **绑定键的名字是 `board_pack`。** 这是契约口径，`docs/05` 的 ADR-D5 与
> `docs/spec/04` 都用它。历史上 `board` 这个键也出现过，
> 现在统一为 `board_pack`——运行时**只认 `board_pack`**，
> 见到 `board` 报「未知顶层字段」（与 §七 规则 24 同一条封闭规则）。

### 10.1 连接 profile 的格式（**封闭** ✓）

> **为什么补这一节** ✓：这一节之前**没有字段表** ✓ —— 只有一段示例 JSON ✓。
> **要加字段就得先有表** ✓（否则「封闭」无从谈起 ✓）。

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | ✅ | 连接 id（**全局唯一** ✓） |
| `label` | ✅ | 人看的名字 |
| `transport` | ✅ | `serial` / `adb` / `ssh` / `local` |
| `board_pack` | | 绑的板型包 id（**缺省 = 不绑** ✓） |
| **`device_key`** | | **这块板的标识** ✓（**缺省 = `id`** ✓） |
| `options` | ✅ | **传输自己的参数** ✓（**按传输封闭** ✓ —— 未知键报错 ✓） |

**未知顶层字段报错** ✓（与 §七 规则 24 同一条封闭规则 ✓）。

### 10.2 `device_key`：**板实物**与**连接**是两层

| 项 | 规则 |
|---|---|
| **它是什么** | **这块板的标识** ✓ —— **同一块板的多条连接给同一个值** ✓ |
| **取值域** | **profile id 空间里的一个 id** ✓ —— **不是主机名、不是 URL** ✓ |
| **缺省** | **`id`** ✓（**一板一连** ✓ 的连接就这么办 ✓） |
| **校验** | **同一个 `device_key` 的多条 profile，必须声明同一个 `board_pack`** ✓ —— **一块板只有一个型号** ✓ → **不一致 → 记一条警告** ✓（**不拖垮应用** ✓ —— 同「坏文件只跳过一个」✓） |

> **为什么要有这一层** ✓：一块板有 **ADB / 串口 / SSH** 三条连接 ✓ →
> **界面要按板子分组** ✓ → 得先知道「哪些连接是同一块板」✓。
> → **`board_pack` 是「板型包」（型号）✓，不是「板实物」✓** —— **两块同型号的板共享一个包** ✓。

### 10.3 `options.ssh`：**这条连接背后那台机器**的 SSH 端点

> **它跨传输** ✓ —— ADB 连接也知道自己背后那块板能不能用 SSH 连 ✓。

```jsonc
{
  "id": "board-adb",
  "transport": "adb",
  "board_pack": "rk3588-atk",
  "device_key": "atk-01",
  "options": {
    "serial": "f34dca7784396ab2",
    "pty": false,
    "ssh": { "host": "192.168.5.100", "port": 22, "username": "root" }
  }
}
```

| 项 | 规则 |
|---|---|
| **形状** | `{ host, port?, username? }`（**封闭** ✓ —— 未知键报错 ✓） |
| **谁写它** | **每条传输都允许** ✓（它是跨传输的事实 ✓） |
| **`transport: 'ssh'` 的 profile** | **不许带** ✓ —— **它自己就是那个端点** ✓（`options.host` 已经是了 ✓）→ **双写 = 漂移** ✓ |
| **`transport: 'local'`** | **不许带** ✓（它是宿主自己 ✓） |
| **冲突** | **报错** ✓（不是「谁赢」✓ —— **不猜** ✓） |

> **为什么要它** ✓：**跨机器的动作在另一台机器上发起** ✓（`05` §八·C ✓）→
> 那条命令要用**板子的 SSH 地址** ✓ → **流程包不该知道板子的地址** ✓ →
> **它跟着 profile 走** ✓（**机器专属的值不进包** ✓ —— ADR-D35 的 D35-2 ✓）。

### 10.4 界面上只列板：**宿主挑连接**

> **用户 2026-11-16 明确**：「**设备要放在界面最顶端，仅支持板卡选择，
> 当前有 fake 和 3588 的真版，不要把连接这些放进去**」✓
> **决策**：`docs/05` **ADR-D44** ✓

| 项 | 规则 |
|---|---|
| **界面列什么** | **板** ✓（`device_key` ✓）—— **不列连接** ✓ |
| **一块板是什么** | **至少有一条连接绑了板型包** ✓ —— **与运行时候选同一把尺** ✓（`tags/runtime.ts` 的 `pickCandidates` ✓）→ **本机与客机不是板** ✓ |
| **板的名字** | **就是 `device_key`** ✓（**不编名字** ✓ —— 三条连接的 label 各不相同 ✓ → **取哪个都是编** ✓） |
| **点板之后谁挑连接** | **宿主** ✓（界面交出 `device_key` ✓ → 宿主按 `device_key` 找它的连接 ✓ → **挨个试** ✓ → **第一条连上的就用它** ✓） |
| **已经在那块板上** | **不重连** ✓（**白连一次会掉读数** ✗ —— 采样器会重起 ✓） |
| **都不行** | **报错** ✓（**说清楚每一条为什么失败** ✓ —— **不静默地换一块板** ✗） |
| **板子放在哪** | **界面最顶端** ✓（**标题条上** ✓ —— 「我在这块板上」得一直在 ✓ —— 页面头会跟着页面换位置 ✗） |

**通道名**：IPC 的 `connections:select`（按连接）**由 `devices:select`（按板）取代** ✓ ——
界面交出去的是**板的身份** ✓，**不是连接 id** ✓。
**MCP 的 `list_connections` 不变** ✓（**它列的是连接** ✓ —— **agent 要看通道** ✓ —— **界面与人看的不是一回事** ✓）。

没写 `board_pack` 时，运行时读 `board.model`，按包的 `match` 规则找匹配的包：

| mode | 规则 |
|---|---|
| `exact` | 型号字符串与 `models` 里某一项完全相同 |
| `substring` | 型号字符串包含 `models` 里某一项 |

**自动识别的时序**：它发生在**连接建立之后、reader 启动之前**。
连接握手阶段读一次 `board.model`（一次往返），据此选定板型包，
然后才按该包的 poll group 开始采样。

> **为什么必须写清时序**：自动识别本身要读 `board.model`，
> 而 `board.model` 是某个板型包提供的 tag。
> 如果绑定发生在 reader 启动之前，就存在「先有鸡还是先有蛋」。
> 所以自动识别用的是**一次性探测**（按 `match.models` 匹配字符串），
> 不是「跑 reader 看能不能读出来」——
> 后者（探测匹配）会无限递归。契约因此**不采用探测匹配**。

**认不出来怎么办**：不猜。报「这块板没有板型包」，终端和文件互传照常可用，
监控和控制明确显示「不可用」。

这条「不猜」的承诺很具体：把一个 `gpu.usage` 绑到一块没有 GPU 的板上，
卡片会显示一个恒为 0 的仪表——**看不出错的仪表比没有仪表更危险**。

### 10.1 一个连接没有包会怎样

连接连上了，但没有匹配的板型包：

- 终端**照常能用**（终端只需要 HAL，不需要板型知识）
- 文件互传**照常能用**
- 监控和控制**不可用**，并明确显示「这块板没有板型包」

这条很重要：**板型包是增强，不是前提。** 用户拿一块新板来，先能连上、能敲命令，
再补一个包。

### 10.2 `requires.transports` 是什么意思

包可以声明它需要什么连接方式（`[adb, serial, ssh]`）。
这是**信息**，不是限制——它告诉运行时「这个包在串口上也能用」，让运行时知道
同一个包可以配多个连接。

但串口和 ADB 不是一回事：串口只有一行一次，`/proc/stat` 的多行快照在串口上跑不了。
所以 **reader 的取数方式必须适配传输**，这是运行时的责任，不是包的责任。

具体地：同一个 `proc_stat` reader，在 ADB 上可以取多行，
在串口上必须用单行变体（旧工程 `core/metrics.py` 里的 `SNAPSHOT_ONELINE` 就是为此存在的，
它的注释写着「UART 没有空间放多行脚本」）。

**包不感知传输。** 这是刻意的：包描述板子，HAL 描述通道，两者由运行时接起来。
一个包配 ADB 和串口时，两条通道各用各的取数方式，产出同样的 tag。

### 10.3 能力词表：板级与连接级

契约与实现各有一套 capability 词。**它们不是同一个轴**，
但词形有一部分重合——所以必须有一张**对照表**把它们的关系说死，
否则改一个词只改一处，两个词表就开始各说各话。

#### 10.3.1 两个轴

| | 契约层（板级能力） | 实现层（连接级能力） |
|---|---|---|
| **回答的问题** | 这块板能做什么 | **这条连接**能做什么 |
| **谁声明** | 板型包（`requires.capabilities`） | 运行时按连接 profile 协商（`capabilitiesFor(profile)`） |
| **封闭词表** | `{shell, exec, stream, files}` | `{exec, pty, files, exitCode}` |
| **由谁消费** | 校验器（规则 25/26）+ 包描述查询 | UI 的降级判断（文件浏览器禁不禁上传）+ 运行时的模式选择 |

**为什么是两个轴而不是一套**：§10.2 说「**包描述板子，HAL 描述通道**」。
硬合成一套就等于让包感知传输，**直接违反 §10.2**。

#### 10.3.2 词义对照表

**这张表是契约的一部分。** 它是**两种词之间的翻译**，**不是函数**——
板级能力**推不出**连接能力：同一块板走 adb 和走 serial，连接能力完全不同。

| 板级能力（契约，包声明） | 连接级能力（实现，profile 协商） | 语义 | v1 实现状态 |
|---|---|---|---|
| `shell` | `pty` | 能开交互式 shell | ✅ 已实现 |
| `exec` | `exec` | 能跑一条命令拿结果 | ✅ 已实现 |
| `files` | `files` | 有文件通道 | ✅ 已实现（**但串口上没有**，事实 S7） |
| `stream` | —— | 能推连续流 | ❌ **未实现**：Stream 契约缺失（`00-overview.md` §七） |
| —— | `exitCode` | **通道能给退出码** | ✅ 已实现（**串口上没有**，事实 S5） |

**两处要读懂的地方**：

1. **`files` 同名不同义**。板级说的是「这块板有文件通道」，
   连接级说的是「**这条连接**能传文件」——串口连接上后者是 false，前者仍是 true。
   **这正是 `requires.capabilities` 不能当连接门禁用的原因**（见 10.3.3）。
2. **`exitCode` 没有板级对应物**。它是**通道的属性，不是板子的属性**
   （串口拿不到退出码，事实 S5）。它**本来就该是连接级的**——
   不是「实现里多出来的一个」。

#### 10.3.3 `requires.capabilities` 是信息，不是门禁

与 §10.2 的 `requires.transports` 同一条口径：**它告诉运行时「这个包能配什么」，
不限制「这个包只能配什么」。**

**为什么不能拿它做连接门禁**：串口的 `files=false`。
若拿板子级 `files` 做门禁，这个包在串口上就废了——
**直接违反 §10.2「一个包配 ADB 和串口时，两条通道各用各的取数方式」**。

所以 v1 里它做两件事：

1. **被校验**——规则 25（封闭词表）与规则 26（必须是已实现的能力）；
2. **被查询**——包描述接口与 `probe:board` 的输出里带上它，
   让 agent 知道「这块板声明支持什么」。

> **不许装作它有意义。** 若某天 v1 不开包描述查询，
> 就要在 `docs/06` 记一条「该字段暂无消费者，待 v2」。

#### 10.3.4 `stream` 的处置

**`stream` 留在词表里，但 v1 的包不许声明它。**

- 留在词表：它是**真实的板级能力**（板子确实有视频管线）。
  将来 Stream 契约落地时**直接用，不必现在删词再还回去**——
  删词是契约改动，那一次才升 `apiVersion`。
- 不许声明：v1 **没有 Stream 契约**（`00-overview.md` §七），
  声明了就是**承诺一个不存在的交付**。
  **规则 26 把它当错误拦下**——不是警告。
  错误信息指向缺口登记处，撞到的人拿到的是一块**指路牌**，不是一个**悄悄的洞**。

> **规则 26 是通用的**，读的是「运行时已实现的能力集」这张表，
> 不是硬编码的 `if (stream)`。Stream 落地那天，**改的是表，不是规则**。

