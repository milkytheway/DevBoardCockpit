> **来源与修订**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex，提交 `c24b084`）。
> 契约层为**权威文档**。**迁入后经 `0244852` 修订过**，2026-11-12 的评审又做了一轮修订
> ——逐节来源见 `00-overview.md` §一之二。落地方式见 `docs/04-架构设计.md`。
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
  capabilities: [shell, exec, stream, files]
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
| `meminfo` | `path` | `total_bytes`, `used_bytes`, `usage` | 单次即可 |
| `devfreq_load` | `path`, `measure` | `duty`, `freq_hz` | `measure` 说明 `duty` 是什么，见下 |
| `rknpu_load` | `path` | `usage`, `core.*.usage` | vendor 专有格式，RK 专属 kind |
| `thermal_zone` | `glob`, `type_map` | `zone.*` | 按 `type` 归并，不按序号 |
| `file_read` | `path`/`glob`, `format`, `strip_trailing_null` | `value` | 逃生门 1：最通用 |
| `exec_regex` | `command`, `pattern`, `format` | `value` | 逃生门 2 |
| `script` | `path`, `interpreter`, `format` | 脚本 JSON 的键（段数不限） | 逃生门 3，见 §三 |

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

### 3.3 包内脚本 —— 逃生舱

实在复杂的，包里可以带一个脚本：

```yaml
  - id: pipeline
    kind: script
    args:
      path: scripts/pipeline_status.sh
      format: json
    provides:
      - tag: custom.rk3588-atk.pipeline.fps
        sample: fps
```

脚本必须**输出 JSON**，键就是它提供的 sample 名。这样 pack 依然是自解释的：
AI 读 YAML 就知道有个脚本，脚本本身是另一层。

**脚本在板子上跑。** 它住在包目录里（宿主上），但要读板子的状态，所以运行时必须先把它
推到板子上（一次会话一次，落在 `/tmp`），之后每次 poll 只是带上路径执行它。
脚本没推上去时命令跑不起来，那个 reader 的 tag 报 `unavailable`——
和其他资源不存在是同一种处理，不猜。

**推到板上的路径由运行时决定**，包不指定（`remote_path` 不是包的参数）：
运行时在板子的 `/tmp` 下建一个**每次会话唯一**的目录
（如 `/tmp/devboard-<session-id>/`），把脚本放进去，会话结束时清掉。
包只声明脚本的**宿主路径**（`path`）与**输出格式**（`format`）。

**脚本的执行要记审计。** `script` 与 `exec_regex` 是在板子上执行任意代码，
它们的执行事件与动作一样进审计日志（§5.4），只是没有 `danger` 分级——
它们是**读取**路径上的能力，不改变板子状态。
若脚本自己改了板子状态，那它就不该声明成 reader——那是动作。

`script` 是唯一一个 sample 名段数不限的 kind，因为它的 sample 名来自 JSON 的键。

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

### 4.4 回读的四种形式

`readback` 是一个块，四选一：

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

形式 1 是首选，因为它自动复用已有的 tag 通道。

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
不得用 `command_ok`（形式 3）。** 校验器强制这条。

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
写成 `reversible` 的包就能跳过人的确认，**分档就成了摆设**。

所以有一条**地板**：

> **某些操作永远是 `destructive`，不管包怎么声明。**

地板是一份固定的操作模式表，属于**契约**，不属于任何一个包：

| 模式 | 匹配的操作 |
|---|---|
| `reboot` / `shutdown` / `poweroff` / `halt` | 重启与关机 |
| `flash` / `upgrade` / `erase` / `burn` | 刷写存储 |
| `mkfs` | 格式化 |
| `dd` 写到 `/dev/mmcblk` `/dev/sd` `/dev/nvme` | 裸写块设备 |
| `rm -rf /` 及其等价形式 | 删根 |
| `iptables -F` / `nft flush ruleset` | 清空防火墙规则 |

运行时在执行一个动作前，**把命令和地板表对一遍**。命中任何一条，
这个动作按 `destructive` 处理——即使包说它是 `reversible`。

**地板是下限，不是上限。** 包**可以**把更多动作标成 `destructive`，
但不能把地板上的降级。校验器会检查：一个把命中地板的命令声明成 `reversible` 的包，
直接报错。

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
| 前缀匹配 | 仅当模式以 `*` 结尾才允许前缀匹配（如 `flash*` 命中 `flash_uboot`） |
| 路径类模式 | 先做路径规范化（展开 `..`、合并重复 `/`、去掉尾部 `/`），再比较 |
| `dd` 类模式 | 匹配 `dd` 词元 + **目标参数**命中块设备路径（`of=` 的值，或紧随其后的参数） |
| `rm -rf /` 类 | 匹配 `rm` + `-rf`/`-fr` 组合 + 路径参数规范化后等于 `/` |
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

每次动作执行记一行：时间、卡片 id、动作 id、参数、结果、回读值。

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
| 参数值落在 `guard` 内 | 属于装卡时批准的那一档，直接执行（仍记审计） |
| 参数值超出 `guard` | 报 `needs_approval`，走一次单独确认（与 destructive 同一条确认通道） |
| 没有声明 `guard` | 等价于 `guard` = 参数的完整声明域，即不缩小范围 |

**`guard` 只能缩小范围，不能扩大。** 校验器检查：
`guard` 的区间必须是 `params` 声明域的子集，否则报错。

> **为什么让包声明 `guard` 而不是让用户在装卡时手填**：用户批准的是「让这张卡把背光调到 30」，
> 不是「让这张卡把背光调到 0」。参数域由包作者（可能是 agent）声明，
> 但**它只能缩小、不能扩大**动作本身的声明域——所以 agent 不能靠写一个宽 `guard` 来扩大权限。
> 用户的批准界面必须显示这个域（`03` §3.2）。

### 5.6 谁能写板型包（reader 也能执行任意命令这件事）

**问题**：§5.2 的危险地板只管**动作**。但 `exec_regex` / `script` 是 **reader**——
它们在板子上执行任意命令，却不过地板、不需要用户授权。

而 `spec/04` §2.4.2 写着「**包一律生效**……agent 可以写板型包扩展，
写完直接用，不需要用户批准」。两条规则合起来就是：

> agent 写一个板型包，reader 里用 `exec_regex` 跑一条命令 ——
> 这条命令**不过危险地板、不需要人确认**，直接在那块板上跑。

这与「破坏性动作必须有人确认」这条产品底线是冲突的。

**处置：板型包 = 设备权限，不是卡片。**

| 规则 | 内容 |
|---|---|
| **谁能写板型包** | **人**。用户可以在本地编辑 `profiles/boards/`，也可以把一个包交给 agent **起草**，但**启用前要由人确认** |
| **确认什么** | 安装界面必须展示：这个包会**执行哪些命令**（`exec_regex` / `script` 的 `command`）、**声明哪些动作**、每个动作的 `danger` 等级、涉及哪些 tag 与设备路径 |
| **agent 起草 vs agent 启用** | agent 可以写文件（它的本职工作），但**装包这一步要人点头**。区别在「文件存在」与「文件生效」 |
| **升级不静默扩权** | 升级包若新增了 `destructive` 动作、或扩大了命令权限，**必须重新确认** |
| **装包失败不拖垮其它能力** | 某个包加载失败时，该连接相关的 tag 报 `unavailable`；终端与文件互传照常可用（§10.1 同理） |

**为什么这样切**：`spec/04` §1.3 说「不准有裸 send_command」，
但一个能执行任意命令的 reader **就是**裸命令通道——
只是换了个入口。契约不能一边禁止裸命令，一边给 agent 一条同样的路。

**被否掉的选项**：

| 选项 | 为什么否 |
|---|---|
| 现状（包一律生效，agent 写的也生效） | reader 是任意命令的旁路，「没有人能绕过人的确认」不成立 |
| 完全禁止 `exec_regex` / `script` | 它们是契约的**逃生门**（§三），砍掉就没有「复杂板子」的出路 |
| 让 reader 也过危险地板 | 地板匹配的是「命令」，reader 的命令在采样期就要跑，逐次确认会让采样不可用；而且地板是**下限**，不是**授权** |

> **这一条是两份独立设计（`docs/10`）共同指出的问题**，
> 两轮评审（`docs/07` / `docs/08`）都没有发现。
> 它也把「板型包一律生效」这条旧决策（`SPEC-D12`）**收窄**了：
> 生效的是**人确认过的包**，不是任何包。

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

一个 pack 在被接受之前，至少要过这些检查。**这 24 条就是契约本身**——
实现层必须逐条实现，缺一条都不算实现了板型包格式。

校验器的命令入口由实现层决定（例如 `npm run validate:profiles`），
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
| 15 | `danger: destructive` 的动作必须有 `readback`（形式 1/2）或 `verify`（形式 4），**不得**用 `command_ok` | 不可逆动作不能盲发 |
| 16 | 命中危险地板的命令必须声明为 `destructive` | agent 不能自己降级 |
| 17 | 每个 reader 必须属于恰好一个 poll group | 没组 = 没有往返 = 永远读不到 |
| 18 | poll group 的 `interval_ms` 不低于 200 | 太频繁会打爆板子 |
| 19 | `exec_regex` / `script` 存在时，打印警告 | 可执行任意代码 |
| 20 | 每个 `params.<name>` 的 `type` 必须是 §4.3 表里的值；`enum` 必须有非空 `values`；`string` 必须有 `maxLength` | 类型封闭，否则校验器无从下手 |
| 21 | `command` 模板里的 `{param}` 占位**不得自带引号** | 引号由运行时统一编码（§4.6），叠加会出错 |
| 22 | `guard` 必须是 `params` 声明域的子集 | `guard` 只能缩小授权范围，不能扩大 |
| 23 | `readback` 的 `kind` 必须是 `file_equals` / `command_ok` / `verify` 之一（不写 `kind` 时按形式 1 读 tag） | 回读形式封闭 |
| 24 | `danger_floor_version` 若声明，必须是已知版本（当前只有 1）；未知顶层字段报错 | 被静默忽略的字段就是拼错的字段 |

> **规则 20–24 是本轮评审新增的。** 前 19 条在 `0244852` 那次修订里就已经是契约的一部分，
> 后 5 条补的是评审发现的空洞：类型封闭、参数编码、`guard` 子集、回读形式封闭。

**校验器不检查、运行时检查的三条**（因为它们依赖运行时状态）：

| # | 检查 | 在哪查 |
|---|---|---|
| R1 | 参数值落在 `guard` 内，否则报 `needs_approval` | 运行时执行前 |
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
      scripts/
        pipeline_status.sh  # 逃生舱脚本，输出 JSON
    rk3568/
      board.yaml
```

一个目录一个包。包目录也可以带自己的 `scripts/`。

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
  "board_pack": "rk3588-atk"
}
```

> **绑定键的名字是 `board_pack`。** 这是契约口径，`docs/05` 的 ADR-D5 与
> `docs/spec/04` 都用它。历史上 `board` 这个键也出现过，
> 现在统一为 `board_pack`——运行时**只认 `board_pack`**，
> 见到 `board` 报「未知顶层字段」（与 §七 规则 24 同一条封闭规则）。

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

