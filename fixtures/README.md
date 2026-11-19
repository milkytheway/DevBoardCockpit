# fixtures —— 真机样本（黄金测试向量）

这些文件是**从真板子 / 真实会话里原样截取**的输出，不是编的。
它们的作用：让解析器（`/proc/stat`、`/proc/cpuinfo`、devfreq、rknpu、meminfo、thermal）
在没有板子的情况下也能被测试，而且**改动解析逻辑时能立刻看出有没有回归**。

> 规矩：**样本只增不改**。要加新样本就加新文件；要改解析器就让旧样本继续绿。
> 契约的 tag 名与状态语义见 `docs/spec/01-tag-contract.md`，**本文不重复定义**。

| 文件 | 来源 | 用来测什么 |
|---|---|---|
| `metrics/proc-stat.txt` | 🟢 ATK-DLRK3588 真实 `/proc/stat` | `cpu.usage` / `cpu.core.*.usage`；**核编号取 `cpuN` 的 N** |
| `metrics/proc-stat-second.txt` | ⚠️ **构造**（由上一份精确派生） | `cpu.usage` 的**差值向量**——只有一份样本时差值根本不存在 |
| `metrics/cpuinfo-excerpt.txt` | 🟢 真实 `/proc/cpuinfo` 摘录 | `cpu.core.*.cluster`（A55/A76，`CPU part` 0xd05 / 0xd0b） |
| `metrics/snapshot-sample.txt` | 🟢 真实一次往返的合并快照（`###STAT`…`###END`） | 快照分段、GPU/NPU/内存/温度解析 |
| `metrics/roundtrip-per-reader.txt` | ⚠️ **构造**（内容取自上一份，按契约格式重排） | 契约的 **per-reader 围栏**（`###R <reader>` / `###E <reader>`） |
| `metrics/snapshot-degraded.txt` | 构造的**降级样本** | 畸形数据必须解析成 `unavailable`，**不能变成 0** |
| `session-log/serial-session.log` | 🟢 真实串口会话日志 | 会话日志格式（时间戳前缀、去 ANSI、事件行） |
| `validator/illegal-floor-downgrade.yaml` | ⚠️ **故意非法**的板型包 | **负例**：把 `reboot` 声明成 `reversible`，校验器必须拒它 |

## 分段格式有两代

| 代 | 文件 | 格式 | 状态 |
|---|---|---|---|
| 旧（扁平） | `snapshot-sample.txt`、`snapshot-degraded.txt` | `###STAT` … `###END` 一整段 | **保留**，不改 |
| 新（per-reader） | `roundtrip-per-reader.txt` | 每个 reader 自己的 `###R <reader> <KIND>` … `###E <reader>` | 契约 `spec/02` §1.2 规定的格式 |

**契约规定的是新格式。** 旧格式来自前身工程的一次性快照脚本，
它的分段边界**不区分 reader**——一个 reader 坏了会污染整段，
而契约要求「组内某个 reader 挂了，不影响同组其他 reader」。
所以实现层要按新格式解析；旧样本作为「历史输入」保留，
用来验证解析器遇到未知分段时的降级行为。

## cpu.usage 差值向量

`cpu.usage` 是**两次采样做差**算出来的。第一份样本单独存在时，
`cpu.usage` 恒为 `pending`（契约 `spec/01` §3.3）——**差值向量不存在**。

`metrics/proc-stat-second.txt` 补上了这个缺口：它由 `proc-stat.txt`
按「1 秒 @ HZ=1000、每核 idle +1000」精确派生，文件头写明了每个核的
`busyΔ` / `totalΔ` / 预期 `usage`。

**用法**：把两份样本依次喂给解析器，断言第二次输出等于文件头写的预期值。
注意预期值是 **Δbusy / Δtotal**，不是「累计 busy / 累计 total」——
后者是开机以来的平均值，不是当前负载。

> ⚠️ 这份样本是**构造**的，不是真机抓取。真机抓取的第二份样本仍值得补
> （规矩是**只增不改**，补上后新增一个文件即可，不要覆盖这份）。

## 负样本：故意非法的板型包

`validator/illegal-floor-downgrade.yaml` 是一个**永远不应通过校验**的样本：
它把命中危险地板的命令（`reboot`）声明成 `danger: reversible`，
违反 `spec/02` §七 的**规则 16**。

它验两件事（缺一不可）：

1. **静态**：校验器拒包，错误要指向规则 16 与具体的字段。
2. **运行时兜底**：即使这个包被强行喂给运行时，
   地板匹配那一步仍判它 `destructive`、返回 `needs_confirmation`，**不执行**。

> 地板是**下限**，校验器是**第一道闸**。两道都要在——
> 只验静态的话，一个绕过校验器的路径就能把重启当可逆动作执行。

## `board/` —— 2026-11-13 在真板上直接采的样本

`metrics/` 里的样本来自**前身工程**（`DevBoardConsole`）的运行记录；
`board/` 里的样本是 **2026-11-13 直接从板子上采的**
（`boardctl.py sh`，板子 serial `0000000000000000`）。

| 文件 | 内容 |
|---|---|
| `rk3588-atk-ls-root.txt` | `ls -la /` 的真实输出（5 个软链接、`----------` 权限的条目） |
| `rk3588-atk-snapshot.txt` | 一次往返采到的 `/proc/stat`、`/proc/cpuinfo`、`/proc/meminfo`、GPU devfreq、rknpu、thermal zone |
| `rk3588-atk-devfreq.txt` | NPU 的两条路径并排（devfreq 占空比 vs rknpu 真正利用率）+ debugfs 挂载状态 |
| `rk3588-atk-proc-stat-pair.txt` | `/proc/stat` 的**两次真实采样**（间隔 3 秒） |

**为什么还要再采一份**：`metrics/proc-stat-second.txt` 是**构造**的
（按「1 秒 @ HZ=1000」推算出来的），不是真采样。
`cpu.usage` 是两次采样做差算出来的，**差值向量应该来自真的两次采样**——
否则解析器的容错（多一行、少一行、CPU 数量不同）根本没被验过。

逐条结论见 `docs/06-契约核对.md` §五，对拍用例在 `tests/unit/board-fixtures.test.ts`。

## 已知缺口

| 缺口 | 说明 |
|---|---|
| ~~真机的第二份 `/proc/stat`~~ | ✅ 已补：`board/rk3588-atk-proc-stat-pair.txt`（真的两次采样） |
| 契约格式的真机往返样本 | 现用「真实内容 + 构造排版」代替 |
| `rare` 轮询组（30000 ms） | 整组无向量 |
| `backlight.set` 的回读 | 实测 `200`/max 255 只在散文里 |
| `cpu.governor.set` 的回读 | 实测 `schedutil` 只在散文里 |
| `duty_cycle` 路径 | `100@1000000000Hz` 只在散文里 |

`session-log/serial-session.log` 来自前身工程的真实运行记录
（`%LOCALAPPDATA%\DevBoardConsole\logs\2026-11-12\`），原样复制，未脱敏（内容只是 shell 提示符与目录列表）。

## 与契约的对拍

这些样本是实现层的**黄金测试向量**：契约评审通过后，实现层写的解析器必须对
同样的样本给出契约定义的**同样的结果**。

「语义不漂移」的唯一硬判据是**实现 vs 契约**，而不是实现 vs 实现——
所以词表与校验规则要能从 `docs/spec/` 生成或逐条核对，见 `docs/04-架构设计.md` §4.3。