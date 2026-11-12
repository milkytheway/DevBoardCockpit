# rk3588-atk

正点原子 ATK-DLRK3588 的板型包。

## 这块板是什么

RK3588，Buildroot 6.1.141，8 核（Cortex-A55 ×4 + Cortex-A76 ×4）。
板子的 USB 被宿主机认领，**不装 VMware 直通也能从宿主的 `adb.exe` 直连**。

## 包里的每条路径都实测过

来源是 `core/metrics.py` 的文档字符串和 README 的「Hardware metrics」一节，
两者都写明这些路径是在「一块跑 Linux 6.1.141 的 RK3588」上验证的。

## 两个被编码进包里的坑

**一、NPU 的 devfreq load 文件不是利用率。**
`/sys/kernel/debug/rknpu/devfreq/cur_freq` 那条链上的 load 读出来是
`100@1000000000Hz`，而板子空闲时它**正好读 100** —— 那是时钟占空比，不是利用率。
空闲的板会因此显示 100% 忙。

所以 `npu.usage` 来自 `rknpu_load`（读 `/sys/kernel/debug/rknpu/load`），
不是 devfreq。devfreq 那条链在本包里只提供 `custom.rk3588-atk.npu.freq_hz`，
并且显式声明 `measure: duty_cycle` —— 校验器会拦住「把占空比当利用率发布」。

**二、`thermal_zone5` 不是稳定的索引。**
coreutils 那个索引在别的板、别的内核版本上会指向别的 zone。
本包用 glob 遍历 + `type` 文件归并，所以换板子不会读错。

**三、`/sys/kernel/debug` 默认没挂载。**
NPU 的读法依赖它。没挂载时 `npu.usage` 报 `unavailable`，
**不退回去读 devfreq 那个占空比**——那会显示 100% 但板子是闲的。

## 验证这个包

```bash
python tools/boardkit/validate.py boards/rk3588-atk/board.yaml
```

校验是纯静态的，不需要板子。它会检查：tag 名在不在核心词表里、有没有两个 reader
抢同一个 tag、`duty_cycle` 有没有被当成利用率发布、动作的参数声明和命令对不对得上、
回读的 tag 是不是这个包真的提供的。

要对着真板验证：

```bash
# 板子接在宿主的 adb 上
python tools/boardkit/probe.py boards/rk3588-atk/board.yaml

# 或者走 SSH
python tools/boardkit/probe.py boards/rk3588-atk/board.yaml \
    --transport ssh --host 192.168.1.102 --username root
```

probe 会跑两轮（CPU 占用率需要两次采样做差），然后按卡片看到的样子打印每个 tag 的
值和状态。任何一个 tag 出不来，它会明说「did not produce a value」——**这比显示 0 强**。

## 未验证的部分

包里的两个动作（`backlight.set`、`cpu.governor.set`）走的是 Linux 通用 sysfs 路径，
没有在这块板上实测过。它们是 `reversible` 等级、有回读、有参数范围，
即使路径不对也只是报错，不会造成破坏。用 probe 或控制卡试一次就能确认。

`npu_core_freq` 这个 custom reader 用 glob 遍历 `/sys/kernel/debug/rknpu/*/freq`，
路径是否存在取决于 rknpu 驱动的版本。没找到时它报 `unavailable`。
