# boardkit —— 契约的 Python 参考实现

> **迁入说明**：自前身工程 `DevBoardConsole\tools\boardkit\` + `tests\test_boardkit.py` 迁入（2026-11-12，Codex）。
> **这份代码不是新工程的一部分**，它没有被打包、不参与构建。

## 它是什么

`docs/spec/` 那五份契约的**机器可读参考实现**：

| 模块 | 对应契约 | 作用 |
|---|---|---|
| `vocabulary.py` | `01-tag-contract.md` | **核心词表的权威**：`CORE_TAGS`（名字 → 类型/单位/取值域/语义）、模式匹配、custom 前缀判定 |
| `kinds.py` | `02-board-pack.md` §2.4 | reader kind 注册表：每个 kind 声明参数 schema、产出哪些 sample、是否需要两次采样、取数用的 shell 片段 |
| `readers.py` | `02` | 各 kind 的解析器（`proc_stat`、`devfreq_load`、`rknpu_load`、`meminfo`、`thermal_zone`…），返回**带状态**的值 |
| `binding.py` | `02` | 把 kind 产出的 sample **绑定**到 tag 名（`provides` 的解析） |
| `validate.py` | `02` §七 / `03` §八 | 校验器：板型包与卡片 manifest 的十条规则 |
| `probe.py` | —— | 对着真板探测，把 reader 的实际输出打出来（验证用） |
| `test_boardkit.py` | —— | 上述模块的单元测试，样本是 ATK-DLRK3588 的真机输出 |

## 为什么要留着它

1. **它是契约的可执行解释**。`vocabulary.py` 里的 `semantics` 字段就是
   `describe_tag` 返回给 AI agent 的那段话——写错了整条协作回路都会歪。
2. **它是移植的对照物**。新工程的 TypeScript 实现（`src/main/tags/`）
   应与它**逐条对齐**：同样的 kind、同样的 sample 名、同样的状态语义。
   移植时对着这份代码和 `test_boardkit.py` 的断言写，可以保证语义不漂移。
3. **它是测试向量**。`test_boardkit.py` 里内嵌的真机样本
   （`/proc/stat`、`/proc/cpuinfo`、devfreq、rknpu、meminfo、thermal）
   与 `fixtures/` 里的样本互为印证。

## 移植到 TypeScript 时的对照表

| Python | TypeScript（计划） | 注意 |
|---|---|---|
| `vocabulary.CORE_TAGS` | `src/shared/tag-vocabulary.ts` | 逐条搬，**语义文字一字不改** |
| `kinds.KINDS` | `src/main/tags/kinds.ts` | kind 的 `fetch` 片段要能压成单行（串口限制） |
| `readers.parse*` | `src/main/tags/readers.ts` | 保持 `OK/PENDING/UNAVAILABLE/ERROR` 四种返回 |
| `binding.bind/bind_all` | `src/main/tags/binding.ts` | 模式匹配逻辑照抄 |
| `validate.*` | `src/main/tags/validate.ts` + `src/main/cards/validate.ts` | 十条规则一条不少 |
| `probe.probe*` | `scripts/probe.ts`（`npm run probe:board`） | 用来在真板上验证 TS 实现与 Python 参考一致 |

> **验收要求**：TS 实现必须能跑通 `test_boardkit.py` 里的同一批断言
> （样本相同、结果相同）。这是「语义不漂移」的唯一硬判据。