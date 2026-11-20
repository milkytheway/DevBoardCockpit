# Terminology

The repository is written in English, but it is developed in Chinese. This file
fixes the English rendering of the domain terms, so that one concept is never
written two ways across the contract, the implementation and the documentation.

Use the right-hand column verbatim. Do not improvise a synonym.

## 1. Domain terms

| Chinese | English |
|---|---|
| 契约 | contract |
| 契约层 | contract layer |
| 板型包 | board pack |
| 板型包运行时 | board pack runtime |
| 通用包 | generic pack |
| 卡片 | card |
| 卡片清单 | card manifest |
| 卡片宿主 | card host |
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
| 连接 profile | connection profile |
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

## 2. States and values

| Chinese | English |
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

## 3. Design and judgement wording

| Chinese | English |
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

## 4. Common constructions

| Chinese | English |
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

## 5. Translation rules

1. **Keep the information density.** A three-sentence argument stays three
   sentences. Do not compress it into one and do not expand it into five.
2. **Do not translate word for word.** Chinese connective adverbs usually
   disappear in English.
3. **Keep references intact.** File paths, field names, error codes, commands
   and version numbers are never translated.
4. **Keep the emphasis.** Where the source marks a phrase, the English marks
   it with `code` or with sentence structure, not with a pile of punctuation.
5. **Add nothing.** An explanation that the source does not contain does not
   belong in the translation.
6. **Drop nothing.** Every constraint, every counterexample and every stated
   reason has to survive the translation.
