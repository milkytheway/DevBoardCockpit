# 为一块陌生的板子建立板型包

本文说明如何为一台尚未登记的板子生成板型包。完成后，宿主能读取该板的状态并执行动作。

教程面向两类读者：希望手工建立板型包的开发者，以及负责扩展板型包的 AI agent。两者遵循同一条路径。

---

## 前置条件

- 应用已安装并启动，板子已连接
- 应用能通过某种传输与板子通信
- 若使用串口，需要知道端口号与波特率

应用内置接板向导，覆盖了本文描述的完整流程。手工执行本文各步骤的原因是需要控制探测范围，或需要检查向导产出的初版包。

---

## 原理

板型包描述一个板型的能力：有哪些位号，数据从哪里来，有哪些动作可以被执行。位号的采集依赖板型包中声明的数据源，因此没有板型包就无法读取未登记的板子。

通用包 `profiles/boards/generic-linux/` 绕开这一依赖。它声明的路径是 Linux 与 sysfs 的通用约定，不针对具体型号：

| 数据源 | 路径 | 提供位号 |
|---|---|---|
| `cpu` | `/proc/stat`、`/proc/cpuinfo` | `cpu.usage`、`cpu.core.*.usage`、`cpu.core.*.cluster` |
| `mem` | `/proc/meminfo` | `mem.total_bytes`、`mem.used_bytes`、`mem.available_bytes`、`mem.usage` |
| `loadavg1`、`loadavg5`、`loadavg15` | `/proc/loadavg` | `custom.generic-linux.loadavg.*` |
| `model` | `/proc/device-tree/model` | `custom.generic-linux.board.model` |
| `osrelease` | `/etc/os-release` | `custom.generic-linux.sys.osrelease` |
| `kernel` | `/proc/version` | `custom.generic-linux.sys.kernel` |
| `uptime` | `/proc/uptime` | `custom.generic-linux.sys.uptime_seconds` |
| `thermal` | `/sys/class/thermal/thermal_zone*` | `custom.generic-linux.temp.zone.*` |
| `backlight` | `/sys/class/backlight/*/brightness` | `custom.generic-linux.backlight.brightness` |
| `led` | `/sys/class/leds/*/brightness` | `custom.generic-linux.led.brightness` |
| `net` | `/sys/class/net/*/address` | `custom.generic-linux.net.mac` |

通用包在大多数嵌入式 Linux 板上可用。它的局限是命名：它无法判断哪个温区对应 SoC，哪个 devfreq 节点对应 GPU。探测结果因此是事实层面的，不是语义层面的。

---

## 步骤

### 一 · 建立连接

在 `profiles/targets/` 下建立连接 profile。profile 描述如何连到板子，与板型无关。

```json
{
  "id": "my-board",
  "label": "My board",
  "transport": "serial",
  "options": { "port": "COM3", "baudrate": 1500000, "pty": true }
}
```

`id` 全局唯一。`device_key` 缺省时取 `id`，用于把同一块板的多条连接归为一组。

### 二 · 探测通用包

将通用包指向该连接，读取其声明的全部数据源：

```bash
npm run probe:board -- --pack generic-linux --profile my-board
```

输出按数据源列出结果：

```
✓ cpu            proc_stat        cpu.usage=0.45percent  cpu.core.0.cluster=A55 …
✓ mem            meminfo          mem.total_bytes=8302329856byte  mem.usage=5.76percent
✗ led            file_read        tag custom.generic-linux.led.brightness 的状态是 error
```

标记含义：成功表示该路径在此板可用，失败表示路径不存在、读法不适用或权限不足。

失败项的原因区分三类，对应三种不同的处理：

- 路径不存在：该板没有这个硬件，探测结果中删除该数据源
- 路径存在但读法不适用：通用包的假设不对，需要针对该板另写数据源
- 权限不足：以 root 身份运行后重新探测

### 三 · 生成初版包

将探测结果整理为板型包。保留成功的数据源，删除失败的数据源。

```yaml
apiVersion: devboard/v1
kind: BoardPack

id: my-board
name: My board
version: 1.0.0

requires:
  transports: [serial, adb]
  capabilities: [shell, exec]
  min_contract: devboard/v1

match:
  mode: substring
  models:
    - MyBoard

poll_groups:
  - id: fast
    interval_ms: 1000
    readers: [cpu]

  - id: slow
    interval_ms: 2000
    readers: [mem]

readers:
  - id: cpu
    kind: proc_stat
    args:
      stat_path: /proc/stat
      cpuinfo_path: /proc/cpuinfo
    provides:
      - tag: cpu.usage
        sample: usage
```

命名有两处需要注意。

**位号命名空间。** 自定义位号必须带本包 id 前缀，即 `custom.<包 id>.*`。校验规则 1 会拒绝其它写法。通用包的前缀是 `custom.generic-linux.`，实例化后需要改写为 `custom.my-board.`。

**轮询分组。** 每个数据源恰好属于一个分组。分组决定采集频率：`/proc/stat` 需要每秒采集以计算占用率，而型号与内核版本一天不变。将它们放进同一组会让慢速数据每秒被重新读取一次。

### 四 · 校验

```bash
npm run validate:profiles -- profiles/boards/my-board
```

校验覆盖 31 条规则。错误表示包无法使用，警告表示包可用但存在需要留意的地方。

### 五 · 接入运行时

将包目录放入 `profiles/boards/`，或放入用户数据目录下的 `boards/`。用户目录优先于内置目录。

应用启动时扫描板型包目录，并在连接建立后按下列顺序选择：

1. 连接 profile 的 `board_pack` 字段指明了包，直接采用
2. 未指明时读取板子型号，与各包的 `match.models` 比对
3. 零个或多个匹配时不作猜测，报出无法确定

因此连接 profile 中填写 `board_pack: my-board` 可以避免自动识别带来的歧义。

### 六 · 验证

```bash
npm run probe:board -- --pack my-board --profile my-board
```

全部数据源应显示成功。应用内的工作台随即显示该板的数据。

---

## 完善初版包

向导与手工探测产出的包是初版。它在事实层面准确：有哪些能力、几个实例、数据形状为何。在语义层面不准确：哪个温区是 SoC，哪个 devfreq 节点是 GPU，那个 duty 值是利用率还是占空比。

补全这些需要两类信息：板子手册与进一步探测。典型的完善工作包括：

- 用手册确认温区类型，改写 `thermal` 数据源的 `type_map`，使 `temp.soc` 与 `temp.gpu` 成为独立位号
- 确认 devfreq 节点的 `load` 文件语义，用 `measure: utilization` 或 `duty_cycle` 明确标注
- 为板子特有的动作补充定义，例如背光调节、LED 开关
- 补充只在此型号存在的硬件，例如 MIPI 相机节点

每一次修改后重新执行校验与探测。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [板型包格式](../spec/02-board-pack.md) | 完整字段定义与 31 条校验规则 |
| [位号契约](../spec/01-tag-contract.md) | 词表、命名空间、位号的五种状态 |
| [设备事实清单](../02-device-facts.md) | 一台真实板子的实测路径与行为约束 |
