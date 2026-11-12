> **迁入说明**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex）。
> 契约层为**权威文档**，正文未改动。落地方式见 `docs/04-架构设计.md`。
# 板型包（board pack）格式

> 一块板 = 一个 YAML 文件。板型差异全部住在这里，不进核心代码。
> 支持一块新板 = 提交一个包，不是等发版。

---

## 一、一个包长什么样

```yaml
# boards/rk3588-atk/board.yaml
apiVersion: devboard/v1
kind: BoardPack

id: rk3588-atk
name: 正点原子 ATK-DLRK3588
version: 1.0.0
description: RK3588，Buildroot 6.1.141，8 核（A55×4 + A76×4）

# 这块板需要什么连接方式才能被访问
requires:
  transports: [adb, serial, ssh]     # 三种都支持
  capabilities: [shell, exec, stream]

# 数据从哪来。reader 是「一次往返取回的一批数据」的单位。
readers:
  - id: cpu
    kind: proc_stat
    interval_ms: 1000
    args:
      path: /proc/stat
      cpuinfo_path: /proc/cpuinfo
    provides:
      - cpu.usage
      - cpu.core.*.usage
      - cpu.core.*.cluster

  - id: gpu
    kind: devfreq_load
    interval_ms: 1000
    args:
      path: /sys/class/devfreq/fb000000.gpu/load
    provides:
      - gpu.usage
      - gpu.freq_hz

  - id: npu
    kind: rknpu_load
    interval_ms: 1000
    args:
      path: /sys/kernel/debug/rknpu/load
    provides:
      - npu.usage
      - npu.core.*.usage

  - id: mem
    kind: meminfo
    interval_ms: 2000
    args:
      path: /proc/meminfo
    provides:
      - mem.total_bytes
      - mem.used_bytes
      - mem.usage

  - id: temp
    kind: thermal_zone
    interval_ms: 2000
    args:
      glob: /sys/class/thermal/thermal_zone*
      type_map:
        soc-thermal: temp.soc
        gpu-thermal: temp.gpu
        npu-thermal: temp.npu
    provides:
      - temp.soc
      - temp.gpu
      - temp.npu

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
    command: "echo {value} > /sys/class/backlight/backlight/brightness"
    readback:
      tag: backlight.brightness
    verify:
      kind: file_equals
      path: /sys/class/backlight/backlight/brightness
      tolerance: 1

# 这块板特有的量。不进核心词表，别的板不保证有。
custom:
  - id: npu.freq_mhz
    kind: devfreq_load
    interval_ms: 2000
    args:
      path: /sys/kernel/debug/rknpu/devfreq/cur_freq
    provides:
      - custom.rk3588-atk.npu.freq_mhz
```

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

| kind | 一次性往返取回 | 产出形状 | 备注 |
|---|---|---|---|
| `proc_stat` | `/proc/stat` + `/proc/cpuinfo` | `cpu.usage`, `cpu.core.*.usage`, `cpu.core.*.cluster` | 需要两次采样，**首次为 pending** |
| `meminfo` | `/proc/meminfo` | `mem.total_bytes`, `mem.used_bytes`, `mem.usage` | 单次即可 |
| `devfreq_load` | 一个 devfreq `load` 文件 | `gpu.usage` + `gpu.freq_hz` | **只取 duty cycle 时另说，见下** |
| `rknpu_load` | `rknpu` debugfs 文件 | `npu.usage`, `npu.core.*.usage` | vendor 专有格式，RK 专属 kind |
| `thermal_zone` | glob 遍历 thermal_zone | `temp.*`（按 `type` 归并） | |
| `file_read` | 任意文件 | 任意自定义 tag | 逃生门 1：最通用 |
| `exec_regex` | 任意命令 + 正则 | 任意自定义 tag | 逃生门 2 |
| `script` | 包内脚本，输出 JSON | 任意自定义 tag | 逃生门 3，见 §三 |

**关于 `devfreq_load` 的重要警告**：devfreq 的 `load` 文件读出 `<duty>@<freq>Hz`，这个 duty 是**时钟占空比**，不是利用率。空闲时读 100（时钟满速待命），满载也读 100。

所以 `devfreq_load` 这个 kind **必须**带一个参数声明它读的是什么：

```yaml
  - id: gpu
    kind: devfreq_load
    args:
      path: /sys/class/devfreq/fb000000.gpu/load
      measure: utilization      # utilization | duty_cycle
    provides:
      - gpu.usage
```

`measure: duty_cycle` 的包**不能**把它映射到 `gpu.usage`（核心词表的 `gpu.usage` 语义是利用率）。校验器必须拒绝这个组合。这是把现有 `metrics.py` 里那个踩过的坑（README 第 193 行明确写着「NPU 的 devfreq load 文件空闲时读 100@1000000000Hz。那是占空比，不是利用率」）变成机器可检查的规则。

---

## 三、逃生门

混合方案必须留门，否则遇到没预料的板就无路可走。三个级别，按优先顺序用：

### 3.1 `file_read` —— 读一个文件

最常用。适合「某个值就是一个文件里的一个数」：

```yaml
  - id: brightness
    kind: file_read
    interval_ms: 2000
    args:
      path: /sys/class/backlight/backlight/brightness
      format: integer
    provides:
      - custom.rk3588-atk.backlight.brightness
```

### 3.2 `exec_regex` —— 跑一条命令，正则取

适合「这个值要算一下」：

```yaml
  - id: uptime
    kind: exec_regex
    interval_ms: 5000
    args:
      command: "cat /proc/uptime"
      pattern: "^([0-9.]+)"
      format: float
    provides:
      - custom.rk3588-atk.uptime_s
```

**注意**：`exec_regex` 有安全含义——它在板子上执行任意命令。它受 §五 的权限分级约束。

### 3.3 包内脚本 —— 逃生舱

实在复杂的，包里可以带一个脚本：

```yaml
  - id: pipeline
    kind: script
    args:
      path: scripts/pipeline_status.sh
      format: json
    provides:
      - custom.rk3588-atk.pipeline.fps
```

脚本必须**输出 JSON**，键就是它提供的 tag 名（去掉 `custom.<板型>.` 前缀）。这样 pack 依然是自解释的：AI 读 YAML 就知道有个脚本，脚本本身是另一层。

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
      model: {type: string}
      fps:   {type: integer, min: 1, max: 60}
    command: "/usr/local/bin/pipeline start --model {model} --fps {fps}"
    readback:
      tag: custom.rk3588-atk.pipeline.running
      expect: true
```

三件事同时成立才算闭环：

1. **点击** → 发命令
2. **回读** → 读 `readback.tag` 确认板子实际状态
3. **UI 以回读为准** → 按钮显示的是 `readback.tag` 的值，不是你点了没点

如果回读失败（命令返回了但状态没变），卡片应该显示「命令已发出，未确认生效」，而不是乐观地显示成已开启。

### 4.2 危险等级

| 等级 | 含义 | 例子 | 行为 |
|---|---|---|---|
| `reversible` | 可逆，误操作能恢复 | 开关一个开关、改采样率、启停服务 | 直接执行，但记审计日志 |
| `destructive` | 不可逆或影响全局 | 重启板子、刷固件、格式化 | **必须二次确认**，且默认 dry-run |

**只读不是动作**——只读走 tag。动作一律是写。

### 4.3 参数

参数是**声明式**的，不是字符串模板里的自由文本：

```yaml
params:
  fps: {type: integer, min: 1, max: 60, default: 30}
```

好处：

- 校验器能在执行前检查范围
- MCP 的 `execute_action` 能返回参数 schema，让 AI 不用猜
- 危险动作的参数范围是安全边界的一部分（`max: 60` 防止 AI 把帧率设成 100000）

### 4.4 回读的三种形式

```yaml
readback:
  tag: some.tag            # 形式 1：读一个 tag（最常见）
  expect: true             # 期望值，不符则报「未确认生效」
```

```yaml
readback:
  kind: file_equals        # 形式 2：读文件比值
  path: /sys/class/backlight/backlight/brightness
  tolerance: 1
```

```yaml
readback:
  kind: command_ok         # 形式 3：命令本身返回 0
```

形式 1 是首选，因为它自动复用已有的 tag 通道。

---

## 五、权限与安全

board pack 里的动作**不是**自动获准执行的。权限在卡片侧声明、在运行时授权。

### 5.1 三档分级

| 档 | 含义 | 安装卡片时 | 执行时 | 审计 |
|---|---|---|---|---|
| `readonly` | 只读 | 直接放行 | 直接执行 | 记 |
| `reversible` | 可逆写 | 首次安装询问一次 | 直接执行 | 记 |
| `destructive` | 破坏性写 | 首次安装询问一次 | **二次确认** + 支持 dry-run | 记 |

授权是**按动作**的，不是一刀切。装一张卡不等于装上它所有动作的权限。

### 5.2 dry-run

`dry_run: true` 时，返回「将会执行什么」，不执行：

```json
{
  "dry_run": true,
  "command": "/usr/local/bin/pipeline start --model yolov8n --fps 30",
  "readback_tag": "custom.rk3588-atk.pipeline.running"
}
```

### 5.3 审计日志

每次动作执行记一行：时间、卡片 id、动作 id、参数、结果、回读值。

沿用现有 `core/session_log.py` 的形态（追加写、每行 flush、时间戳前缀）——那套已经被验证过：崩了也留下可读记录。

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

一个 pack 在被接受之前，至少要过这些检查：

| # | 规则 | 为什么 |
|---|---|---|
| 1 | 每个 reader 的 `provides` 里的 tag 名**匹配核心词表**或落在 `custom.<本包 id>.*` 下 | 防止拼错和私自扩词表 |
| 2 | 同一个 tag 不能被两个 reader 提供 | 歧义 |
| 3 | `devfreq_load` 且 `measure: duty_cycle` 时，**不得**提供 `*.usage` | 就是那个占空比坑 |
| 4 | `proc_stat` 提供的 tag 必须包含 `cpu.usage`（首次 pending 语义） | |
| 5 | 每个 action 的 `readback.tag` 必须是本 pack 提供的 tag | 否则闭环断了 |
| 6 | 每个 action 的 `command` 里出现的 `{param}` 必须都在 `params` 里声明 | 拼错参数名到运行时才炸 |
| 7 | 每个 `params` 里的声明的参数必须真的在 `command` 里用上 | 死参数 |
| 8 | `danger: destructive` 的动作必须有 `verify` 或 `readback` | 不可逆动作不能盲发 |
| 9 | reader 的 `interval_ms` 不低于 200 | 太频繁会打爆板子 |
| 10 | `exec_regex` / `script` 动作或 reader 存在时，打印警告（可执行任意代码） | |

---

## 八、目录布局

```
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

