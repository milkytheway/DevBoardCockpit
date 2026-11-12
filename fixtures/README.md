# fixtures —— 真机样本（黄金测试向量）

这些文件是**从真板子 / 真实会话里原样截取**的输出，不是编的。
它们的作用：让解析器（`/proc/stat`、`/proc/cpuinfo`、devfreq、rknpu、meminfo、thermal）
在没有板子的情况下也能被测试，而且**改动解析逻辑时能立刻看出有没有回归**。

> 规矩：**样本只增不改**。要加新样本就加新文件；要改解析器就让旧样本继续绿。
> 契约的 tag 名与状态语义见 `docs/spec/01-tag-contract.md`，**本文不重复定义**。

| 文件 | 来源 | 用来测什么 |
|---|---|---|
| `metrics/proc-stat.txt` | 🟢 ATK-DLRK3588 真实 `/proc/stat` | `cpu.usage` / `cpu.core.*.usage`；**核编号取 `cpuN` 的 N** |
| `metrics/cpuinfo-excerpt.txt` | 🟢 真实 `/proc/cpuinfo` 摘录 | `cpu.core.*.cluster`（A55/A76，`CPU part` 0xd05 / 0xd0b） |
| `metrics/snapshot-sample.txt` | 🟢 真实一次往返的合并快照（`###STAT`…`###END`） | 快照分段、GPU/NPU/内存/温度解析 |
| `metrics/snapshot-degraded.txt` | 构造的**降级样本** | 畸形数据必须解析成 `unavailable`，**不能变成 0** |
| `session-log/serial-session.log` | 🟢 真实串口会话日志 | 会话日志格式（时间戳前缀、去 ANSI、事件行） |

`session-log/serial-session.log` 来自前身工程的真实运行记录
（`%LOCALAPPDATA%\DevBoardConsole\logs\2026-11-12\`），原样复制，未脱敏（内容只是 shell 提示符与目录列表）。

## 与契约参考实现的对拍

`reference/boardkit-python/test_boardkit.py` 里也内嵌了同一批真机样本。
两处样本互为印证：**对拍测试（TS 结果 == Python 参考结果）是「语义不漂移」的唯一硬判据**，
见 `docs/04-架构设计.md` §4.3。