# rk3588-atk

正点原子 ATK-DLRK3588 的板型包。

## 这块板是什么

RK3588，Buildroot 6.1.141，8 核（Cortex-A55 ×4 + Cortex-A76 ×4）。
板子的 USB 被宿主机认领，**不装 VMware 直通也能从宿主的 `adb.exe` 直连**。

## 包里的每条路径都实测过

来源是旧工程 `core/metrics.py` 的文档字符串与 README 的「Hardware metrics」一节，
以及 `docs/02-设备事实清单.md` 里对真板的核对记录。

## 三个被编码进包里的坑

**一、NPU 的 devfreq load 文件不是利用率。**
实测 `/sys/class/devfreq/fdab0000.npu/load` 读出来是 `100@1000000000Hz`，
而板子**空闲时它正好读 100** —— 那是时钟占空比，不是利用率。
空闲的板会因此显示 100% 忙。

所以 `npu.usage` 来自 `rknpu_load`（读 `/sys/kernel/debug/rknpu/load`，实测
`NPU load: Core0: 0%, Core1: 0%, Core2: 0%`），不是 devfreq。

本包同时把 devfreq 那条链绑成两个**板型私有量**，让卡片能对照着看：

| tag | 含义 | 空闲时的值 |
|---|---|---|
| `npu.usage` | 真实利用率 | 0% |
| `custom.rk3588-atk.npu.duty` | 时钟占空比 | 100% |
| `custom.rk3588-atk.npu.freq_hz` | 当前频率 | 1000000000 |

只显示占空比会误判成满载，只显示利用率则看不出时钟在待命。**两个一起看才对。**

devfreq 那条链显式声明 `measure: duty_cycle` —— 校验器会拦住「把占空比当利用率发布」。

**二、`thermal_zone5` 不是稳定的索引。**
coreutils 那个索引在别的板、别的内核版本上会指向别的 zone（实测本板
`thermal_zone5` 是 `gpu-thermal`）。
本包用 glob 遍历 + `type` 文件归并，所以换板子不会读错。

**三、`/sys/kernel/debug` 默认没挂载。**
NPU 的读法依赖它。没挂载时 `npu.usage` 报 `unavailable`，
**不退回去读 devfreq 那个占空比**——那会显示 100% 但板子是闲的。

## 验证这个包

契约层（`docs/spec/02` §七）列了 **19 条校验规则**——实现层必须逐条实现它们。
命令入口由实现层决定（约定为 `npm run validate:profiles`）。

校验是纯静态的，不需要板子。它会检查：tag 名在不在核心词表里、有没有两个 reader
的 tag 模式重叠、`duty_cycle` 有没有被当成利用率发布、动作的参数声明和命令对不对得上、
回读的 tag 是不是这个包真的提供的、命令有没有命中危险地板。

要对着真板验证：

```bash
# 板子接在宿主的 adb 上
npm run probe:board

# 或者走 SSH
npm run probe:board -- --transport ssh --host 192.168.1.102 --username root
```

probe 会跑两轮（CPU 占用率需要两次采样做差），然后按卡片看到的样子打印每个 tag 的
值和状态。任何一个 tag 出不来，它会明说「did not produce a value」——**这比显示 0 强**。

> 这两个命令**现在还不存在**——契约评审通过、实现层建好之后才有。
> 需要立刻验证板型包时，可以用评审通过后重写的校验器，
> 或对照 `docs/02-设备事实清单.md` 里已核实的事实逐条核对。

## ⚠️ 待你拍板

`docs/06-契约核对.md` 列了 5 条需要你定的条目（Q1–Q5），本包现在的状态：

| # | 事项 | 本包现在的处理 |
|---|---|---|
| Q1 | `npu_devfreq` 的路径 | **已改**：用实测存在的 `/sys/class/devfreq/fdab0000.npu/load`（原路径 `/sys/kernel/debug/rknpu/devfreq/cur_freq` 实测不存在） |
| Q2 | 双背光进核心词表还是走 custom | 未处理：本包只做了主屏 `backlight.set` |
| Q3 | `cpu.governor` / `npu.governor` 是否进核心词表 | 未处理：词表里还没有这两个 tag |
| Q4 | 是否补三个动作（含 destructive 的 `system.reboot`） | 未处理：本包只有两个 reversible 动作 |
| Q5 | `unavailable` 是否带 reason 码 | 参考实现里叫 `detail`，词表与契约都还没定这个字段 |

**Q1 是我按实测数据先改了**（原路径指向一个不存在的目录，留着必然报 `unavailable`）。
其余四条等你拍板后再动。

## 未验证的部分

包里的两个动作（`backlight.set`、`cpu.governor.set`）走的是 Linux 通用 sysfs 路径，
实测确认路径存在（背光主屏 `brightness` 读 200，max 255；`scaling_governor` 读
`schedutil`），但**写入效果没实测过**。它们是 `reversible` 等级、有回读、有参数范围，
即使路径不对也只是报错，不会造成破坏。用 probe 或控制卡试一次就能确认。

> 实测发现这台板有**两个**背光实例：`/sys/class/backlight/backlight/` 与
> `/sys/class/backlight/backlight1/`。注意目录名是 `backlight`，不是 `backlight0`。
> 这就是 Q2 那条待拍板事项的背景。
