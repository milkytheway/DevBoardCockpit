# 注释英文化 · 术语表

> **用途**：机器初译 + 人工审校时的**统一译法** ✓。
> **为什么必须有它**：同一个词出现三种英文，是「AI 味」最明显的来源 ✓。
> **规则**：左列是原文词，右列是**唯一**译法 ✓ —— 初译时不得自由发挥 ✓。

## 一 · 领域名词

| 中文 | 英文 |
|---|---|
| 契约 | contract |
| 契约层 | contract layer |
| 板型包 | board pack |
| 卡片 | card |
| 卡片清单 | card manifest |
| 流程包 | workflow pack |
| 流程 | workflow |
| 步骤 | step |
| 位号 / 语义位号 | tag |
| 词表 / 词汇表 | vocabulary |
| 数据源 | data source |
| 动作 | action |
| 参数 | parameter |
| 回读 | readback |
| 判据 | criterion |
| 权限区 | permission area |
| 危险地板 | danger floor |
| 板卡 | board card |
| 沙箱 | sandbox |
| 宿主 | host |
| 宿主 AI | host-side agent |
| 探针 | probe |
| 真相表 | truth table |
| 校验器 | validator |
| 校验规则 | validation rule |
| 部署 / 落盘 | install |
| 轮询分组 | poll group |
| 采样间隔 | sampling interval |
| 读数 | reading |
| 实例 | instance |
| 序列化 | serialisation |

## 二 · 状态与取值

| 中文 | 英文 |
|---|---|
| 五态 | the five states |
| 不可用 | unavailable |
| 待定 | pending |
| 过期 | stale |
| 错误 | error |
| 正常 | ok |
| 封闭 | closed |
| 开放 | open |
| 空 | empty |

## 三 · 设计与判断用语

| 中文 | 英文 |
|---|---|
| 不猜 | never guess |
| 事实 | fact |
| 实测 | measured |
| 契约优先 | contract first |
| 唯一事实源 | single source of truth |
| 假数 | false reading |
| 恒为 0 的仪表 | a gauge pinned at zero |
| 就地 | in place |
| 独占 | exclusive |
| 惰性 | lazy |
| 兜底 | fallback |
| 旁路 | bypass |
| 收敛 | converge |
| 落位 | placement |

## 四 · 常见句式

| 中文 | 英文 |
|---|---|
| 不是 X，而是 Y | not X but Y |
| X 与 Y 不同 | X differs from Y |
| 换句话说 | in other words |
| 也就是说 | that is |
| 反过来 | conversely |
| 与此同时 | meanwhile |
| 因此 | therefore |
| 于是 | so |
| 但是 | but |
| 然而 | however |
| 总之 | in short |

## 五 · 翻译规则

1. **保留信息密度。** 原文用三句话讲清一个理由的，译文也用三句话。不压缩成一句，也不拆成五句。
2. **不逐字翻译。** 原文的口语连接词（因此、于是、总之）在英文里通常删掉。
3. **保留引用。** 文件路径、字段名、错误码、命令、版本号一律不译。
4. **保留强调。** 原文用「**」标出的强调，译文用 `code` 或句式强调，不依赖符号堆砌。
5. **不新增内容。** 原文没有的解释，译文里不能出现。
6. **不删内容。** 原文的每一条约束、每个反例、每处「为什么」都要在译文里。
