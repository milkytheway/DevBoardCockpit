# rk3588-atk

正点原子 ATK-DLRK3588 的板型包。

## 这块板是什么

RK3588，Buildroot 6.1.141，8 核（Cortex-A55 ×4 + Cortex-A76 ×4）。
板子的 USB 被宿主机认领，**不装 VMware 直通也能从宿主的 `adb.exe` 直连**。

## 包里的路径来自哪里

来源是旧工程 `core/metrics.py` 的文档字符串与 README 的「Hardware metrics」一节，
以及 `docs/02-设备事实清单.md` 里对真板的核对记录。

> **注意**：这里说的是「**来自实测记录**」，不是「每条都实测过」。
> 迁入时有一条指向了实测不存在的路径（`rknpu/devfreq/cur_freq`），
> 又被改成了语义不对的路径（见下面第一个坑）。逐条的核实状态见
> `docs/06-契约核对.md` §一 与 §四。

## 三个被编码进包里的坑

**一、NPU 的 devfreq load 文件不是利用率。**
实测 `/sys/class/devfreq/fdab0000.npu/load` 读出来是 `100@1000000000Hz`，
而板子**空闲时它正好读 100** —— 那是时钟占空比，不是利用率。
空闲的板会因此显示 100% 忙。

所以 `npu.usage` 来自 `rknpu_load`（读 `/sys/kernel/debug/rknpu/load`，实测
`NPU load: Core0: 0%, Core1: 0%, Core2: 0%`），不是 devfreq。

本包同时把 devfreq 那条链绑成**板型私有量**，让卡片能对照着看：

| tag | 来源 | 含义 | 空闲时的值 |
|---|---|---|---|
| `npu.usage` | rknpu debugfs | 真实利用率 | 0% |
| `custom.rk3588-atk.npu.duty` | devfreq `load` | 时钟占空比 | 100% |
| `custom.rk3588-atk.npu.freq_hz` | devfreq `cur_freq` | 当前频率 | 1000000000 |

> **三者的来源各不相同**：`load` 里的 `@<freq>Hz` 是「这条 duty 在哪个频率上测的」，
> **不是当前频率**——所以 `duty` 只绑 duty，频率另从 `cur_freq` 取。
> 这三个量混着看，就会把「板子闲着但时钟满速待命」误判成「板子在满负荷」。

只显示占空比会误判成满载，只显示利用率则看不出时钟在待命。**两个一起看才对。**

devfreq 那条链显式声明 `measure: duty_cycle` —— 校验器会拦住「把占空比当利用率发布」。

**二、`thermal_zone5` 不是稳定的索引。**
coreutils 那个索引在别的板、别的内核版本上会指向别的 zone（实测本板
`thermal_zone5` 是 `gpu-thermal`）。
本包用 glob 遍历 + `type` 文件归并，所以换板子不会读错。

**三、`/sys/kernel/debug` 不保证已挂载。**
NPU 的读法依赖它。挂载与否取决于板子的 `/etc/fstab` 与 init 脚本，**不持久**——
本机实测时它**是挂载的**，但重启后可能丢。
没挂载时 `npu.usage` 报 `unavailable`，
**不退回去读 devfreq 那个占空比**——那会显示 100% 但板子是闲的。

## 验证这个包

契约层（`docs/spec/02` §七）列了 **24 条校验规则**——实现层必须逐条实现它们。
命令入口由实现层决定（约定为 `npm run validate:profiles`）。

校验是纯静态的，不需要板子。它会检查：tag 名在不在核心词表里、有没有两个 reader
的 tag 模式重叠、`duty_cycle` 有没有被当成利用率发布、动作的参数声明和命令对不对得上、
回读的 tag 是不是这个包真的提供的、命令有没有命中危险地板。

要对着真板验证：

```bash
# 板子接在宿主的 adb 上（默认用 profiles/targets 里第一个能连上的板型包）
npm run probe:board

# 指定板型包（**包 id 或目录路径都认**）
npm run probe:board -- --pack rk3588-atk

# 指定连接 profile
npm run probe:board -- --profile board-adb
```

> **命令行**：`--pack <包 id 或目录>` 选板型包，`--profile <连接 profile id>` 选连接。
> 传输参数（`--transport` / `--host` / …）**还没实现**——
> 传输由 `profiles/targets/` 里的连接 profile 决定。

probe 会跑两轮（CPU 占用率需要两次采样做差），然后打印每个 reader 的
每个 tag 的值和状态。任何一个 tag 出不来，它会**明说缺了什么**——
**这比显示 0 强**。

> **真机验收还没跑过**（2026-11-13）：探针已就绪，但一次都没对着真板子跑过。
> 见 `docs/06-契约核对.md` 的 **C12**。

## 契约核对清单的状态

`docs/06-契约核对.md` 列了 **C1–C7** 共 7 条（不是 5 条），本包现在的状态：

| # | 事项 | 本包现在的处理 | 状态 |
|---|---|---|---|
| C1 | `npu_devfreq` 的路径 | **已回滚**：`npu_devfreq` 读 devfreq 的 `load` 但**只提供 `duty`**；频率另由 `npu_freq` 读 `fdab0000.npu/cur_freq` | ✅ 已拍板（2026-11-12） |
| C2 | 双背光进核心词表还是走 custom | **走 custom**：本包提供 `custom.rk3588-atk.backlight.brightness` 与 `...backlight1.brightness` 两个 reader | ✅ 已拍板（2026-11-12） |
| C3 | `cpu.governor` / `npu.governor` 是否进核心词表 | **`cpu.governor` 进核心词表**（本包有 `cpu_governor` reader）；`npu.governor` 不进——它的 `available_governors` 是 rkdevfreq 全局列表，语义不一致 | ✅ 已拍板（2026-11-12） |
| C4 | 是否补三个动作（含 destructive 的 `system.reboot`） | ✅ **已拍板**（2026-11-13，ADR-D26）：已补 `system.reboot`；`npu.governor.set` **不补**（实测写 devfreq governor 会**锁死板子**、只有重启能救）、`debugfs.mount` **不补**（本板已挂着） | ✅ |
| C5 | `unavailable` 是否带 reason 码 | ✅ **已定**：`reason`（封闭枚举 7 码，带版本）+ `detail`（自由文本），见 `docs/spec/01` §2.1.1 | ✅ |
| C6 | 单位换算责任 | 已写入契约：reader 负责换算，契约只认 byte | ✅ 已定 |
| C7 | NPU 占空比对照量 | 保留 `custom.rk3588-atk.npu.duty`，但**只提供 duty**，不冒名提供频率 | ✅ 已定 |

> **C1 改过两次**：迁入时写的路径实测不存在 → 第一次修订改成读 devfreq 的 `load`
> （但那个文件里的 `@freq` 是「duty 在哪个频率上测的」，不是当前频率，语义被冒名）
> → 现按用户拍板**回滚**：占空比只提供占空比，频率另取一处。

## 未验证的部分

包里的两个动作（`backlight.set`、`cpu.governor.set`）走的是 Linux 通用 sysfs 路径，
实测确认路径存在（背光主屏 `brightness` 读 200，max 255；`scaling_governor` 读
`schedutil`），但**写入效果没实测过**。它们是 `reversible` 等级、有回读、有参数范围，
即使路径不对也只是报错，不会造成破坏。用 probe 或控制卡试一次就能确认。

> 实测发现这台板有**两个**背光实例：`/sys/class/backlight/backlight/` 与
> `/sys/class/backlight/backlight1/`。注意目录名是 `backlight`，不是 `backlight0`。
> 这就是 Q2 那条待拍板事项的背景。
