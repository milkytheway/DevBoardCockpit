# 板型 profile（board profile）

**一份板型 profile = 一类板的能力说明书**：它有哪些语义位号、每个位号怎么产生、有哪些可写的动作。

它**不**描述「怎么连」——那是 `../targets/*.json` 的事：

```
板型 profile (boards/atklrk3588.yaml)      连接 profile (targets/board-adb.json)
  ├─ 有哪些 tag、怎么产生                      ├─ 用什么传输连
  ├─ 有哪些 action、什么分级                   ├─ 连到哪台具体设备（serial / COM3 / IP）
  └─ 与具体设备无关                            └─ board: atklrk3588   ← 指回板型
```

同一块板可以有多个连接实例（ADB 一条、串口一条），它们**共用同一份板型 profile**。
这正是「N 张卡 × M 种板 = N+M 个文件」能成立的原因（见 `docs/05-决策记录.md` D5）。

## 三段结构

```yaml
recipes:  # 读取配方：这台板上「怎么把东西读出来」——一条命令，不写脚本
tags:     # 语义位号：指向一个 recipe + 一个通用提取器 + 单位
actions:  # 可写动作：命令模板 + 分级 + 回读哪个位号
```

**为什么要拆出 recipes**：板型差异最终会落在「路径」上，但**路径之上还有读法**
（`/proc/stat` 要按行解析、`thermal_zone` 要配对 type 与 temp）。
把「读法」交给通用提取器，板型 profile 就只剩**数据**——
于是「加一块新板」不需要改核心代码，「加一种新的读法」才需要。

## 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `label` / `version` | ✅ | 标识与版本；语义变更时递增版本号 |
| `status` | ✅ | `draft` = 还没对板全量核过；`verified` = 走完 smoke 断言 |
| `identity` | ⬜ | 板子自我描述（compatible、内核、CPU 分簇、内存） |
| `recipes` | ✅ | 读取配方表：`{ <name>: { run: "<命令>" } }` |
| `tags` | ✅ | 位号表 |
| `actions` | ⬜ | 可写动作 |
| `custom_tags` | ⬜ | 逃生门：自定义位号，一律带 `custom.` 前缀 |

## 硬性要求

1. **配方必须能压成一行**——串口一次只能跑一条命令（事实清单 S6）。
   写多行脚本的板型在串口上不可用。
2. **配方里不要用 `&&` 串联有副作用的命令**——合并成一条命令时顺序会被重排。
3. **位号 id 必须符合命名规则**：`<domain>.<measure>`，小写点分（设计文档 §5.1）。
4. **写操作必须声明 `verify`**——不声明回读的写动作等于遥控器，不是驾驶舱。

## 提取器词表（第一版）

| extractor | 输入 | 输出 | 备注 |
|---|---|---|---|
| `proc_stat_total` | `/proc/stat` | 百分比 | busy = total − idle |
| `proc_stat_cores` | `/proc/stat` | 每核百分比 | 核编号取 `cpuN` 的 N |
| `cpuinfo_part` | `/proc/cpuinfo` | 分簇名 | 按 `map` 翻译 `0xd05`/`0xd0b` |
| `devfreq_percent` | `<百分比>@<频率>Hz` | 百分比 | |
| `devfreq_hertz` | 同上 | 频率 | |
| `rknpu_load` | `NPU load: Core0: 12%, …` | 百分比（取 max） | |
| `meminfo_value` | `Key: 8107744 kB` | KiB | |
| `thermal_zone` | `type=temp` 行 | 摄氏度（× scale） | 按 `key` 过滤 |
| `file_text` | 文件全文 | 文本 | trim |
| `file_number` | 文件全文 | 数字 | trim |

> 新增提取器 = 新增一个词，**不改板型**。这就是把旧工程
> `metrics.py` 里硬编码的 `fb000000.gpu` 拆出来的意义。

## 新增一块板的步骤

1. 复制 `atklrk3588.yaml` → 改 `id` / `label` / `identity`。
2. 改 `recipes` 里的路径（**唯一**需要按板改的地方）。
3. 改 `tags` 的位号映射与 `actions`。
4. `npm run validate:profiles` → schema + 命名规则 + 提取器存在性全过。
5. `npm run smoke:board -- --profile <id>` → 全绿后把 `status` 改成 `verified`。