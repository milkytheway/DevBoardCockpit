> **来源与修订**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex，提交 `c24b084`）。
> 契约层为**权威文档**。**迁入后经 `0244852` 修订过**，2026-11-12 的评审又做了一轮修订
> ——逐节来源见 `00-overview.md` §一之二。落地方式见 `docs/04-架构设计.md`。
# MCP 工具集

> GUI 实现 MCP server。宿主 AI 通过它感知软件现状、读板子状态、写卡片、自测。
> 这是「AI ↔ GUI」的契约，和「卡片 ↔ 板子」的 tag 契约对称。

---

## 一、总原则

### 1.1 能力是动态出现的

**不能靠静态文档。** 摄像头是插上的，驱动是后来装的，board pack 是运行时加载的，卡片是 agent 刚写的。

所以 MCP 的第一组工具全是「列举」，不是「查询文档」：

```
list_connections  →  现在连着什么
list_data_sources →  现在有什么数据可读
list_capabilities →  现在能做什么
```

静态文档（`get_card_sdk_docs`）只作为**写卡时的语法参考**，不作为现状来源。

### 1.2 agent 自测的眼睛

一个 agent 写完一张卡，如果不能立刻看到「这张卡跑起来对不对」，它就只能在盲写。

所以 MCP 必须提供：

- `validate_card(path)` —— 静态校验，写完立刻能查
- `get_card_runtime_log(cardId)` —— 运行时日志，卡跑起来能看错

这两条合起来，就是 agent 的「眼睛」。没有它们，「做一张卡从半天变一轮对话」不成立。

### 1.3 不准有裸 send_command

`execute_action` **取代**裸命令执行。agent 只能触发**已声明的动作**，不能发任意命令。

理由是安全 + 语义两条：

- 安全：动作带危险分级、参数范围、审计。
- 语义：`backlight.set` 比一串 shell 更有意义，而且它的回读是定义好的。

如果 agent 需要一个还没声明的动作，它应该**写一个 board pack 扩展**，而不是发裸命令。

---

## 二、工具清单

### 2.1 感知现状

#### `list_connections()`

```
→ [{ id, label, transport, board_pack, device_key, current, connected, capabilities }]
```

| 字段 | 含义 |
|---|---|
| **`device_key`** | **这块板的标识** ✓（`02` §10.2 ✓）—— **同一块板的多条连接给同一个值** ✓ |
| **`current`** | **它是当前运行时那条连接吗** ✓（**与 `connected` 的两条判据分开** ✓ —— 开着终端会话的那条**也算 `connected`** ✓，但**不是**运行时那条 ✓） |

`board_pack` 是当前这块板绑定的**板型包 id**；**没绑就是 `null`**。

> **只给 id，不给版本** ✓：版本是**包自己的属性**——同 id 的包可以有好几个版本，
> 那不是「这条连接」的属性。版本在 `list_data_sources` 里给（那里本来就在讲包）。

| 字段 | 含义 |
|---|---|
| `id` / `label` / `transport` | 连接 **profile** 的身份（**不是**某条活连接） |
| `board_pack` | 绑定的板型包 id，或 `null` |
| `connected` | **这条 profile 现在有活着的连接吗**（布尔） |
| `capabilities` | **连接级**能力位：`exec` / `pty` / `files` / `exitCode`（`spec/02` §10.3 的**连接级**那一套，**不是**板级词表） |

**`connected` 的判据**（两条**都要满足**才算「连着」）：

1. 它是**当前 tag 运行时那条连接**，**且**运行时状态是 `running`；
   —— **光看「运行时记着这个 profile」不够**：连不上或已停下时那条记录仍在。
2. **或**它**开着终端会话**。

> **「有 profileId」≠「连着」** ✓。

#### `list_data_sources()`

```
→ [{ id, board, poll_group, kind, interval_ms,
     provides: ["cpu.usage", ...], status }]
```

`status` 是 reader 本身的状态，取值与 tag 状态**同一套**：`ok` / `stale` /
`unavailable` / `error` / `pending`。

注意这返回的是 **reader 粒度**，不是 tag 粒度——因为「哪些 tag 可读」这个问题的答案天然按 reader 组织（一个 reader 挂了，它提供的 tag 全挂）。

| 字段 | 含义 |
|---|---|
| `id` | **reader 的 id**（数据源就是 reader 粒度） |
| `board` | **当前板型包的 id**（不是连接 id） |
| `poll_group` | 这个 reader 所在的轮询组 id |
| `kind` | reader 的 kind（`proc_stat` / `file_read` / …） |
| `interval_ms` | 它所在**轮询组**的周期（reader 自己没有周期） |
| `provides` | 这个 reader 提供的 **tag 具体名**（**展开后的**——包里写的是模式，见下） |
| `status` | reader 自身状态（映射表见下） |

> **`provides` 给具体名** ✓：包里写的是 `cpu.core.*.usage`（**模式**），
> 而 agent 要写卡片 → 卡片要填**具体 tag 名**。模式另由 `describe_tag` 的语义承担。

**reader 的 `status` 是映射表**（不是「取最差」）：

| 情形 | `status` |
|---|---|
| 它的 tag **一个都不在**读数里 | `pending` |
| 有 tag，且**全部** `unavailable` | `unavailable` |
| 有 tag，且**存在** `error` | `error` |
| 有 tag，且**存在** `stale`（没有 error） | `stale` |
| 全部 `ok` | `ok` |

#### `list_capabilities()`

```
→ { transports: [...], features: ["cards", "mcp", "layout_share", "record"] }
```

工作台自己有什么。给 agent 判断「这个功能有没有」。

| 字段 | 取值域 |
|---|---|
| `transports` | **连接级**能力的封闭词表：`exec` / `pty` / `files` / `exitCode`（`spec/02` §10.3 的**连接级**那一套）——**不是**板级词表 |
| `features` | 工作台自己的能力位，**封闭**：`cards` / `mcp` / `layout_share` / `record` |

> **加值要改契约** ✓（封闭词表 ✓）。

#### `list_tags(board?)`

```
→ [{ name, type, unit, range, status, value, board, source_reader }]
```

**当前实际可读**的 tag，含实时状态。这是 agent 写卡时最该先调的一个。

区别于 `list_data_sources`：

- `list_data_sources` 问「有哪些数据源」
- `list_tags` 问「有哪些具体的量，现在什么值」

agent 要写一张 CPU 卡，第一个该调的是 `list_tags()`，因为它直接告诉 agent 有哪些 tag 名可用。

| 字段 | 含义 |
|---|---|
| `name` | tag 名 |
| `type` | **核心词表**里的类型（`number` / `string` / `boolean` / `enum`）；**没有词表条目就是 `null`** |
| `unit` | 单位——**没有词表条目是 `'-'`**（无量纲），**不是 `null`** |
| `range` | **核心词表**里的取值域：**二元数组** `[min,max]` **或字符串**（如 `"开放枚举"` / `"≥0"`）；没有词表条目是 `null` |
| `status` / `value` | 当前读数（五态，原样） |
| `board` | 当前板型包的 id |
| `source_reader` | 这个 tag 是**哪个 reader** 提供的 |

**`source_reader` 怎么算**：拿 tag 名去匹配各 reader 的 `provides` 模式
（**含 `custom` 里的 reader**——否则 `custom.*` 的量全都是 `null`）。
**一个 tag 至多匹配一个 reader**——板型包规则 2 保证 reader 的 tag 模式不重叠，
不合规的包运行时根本不加载。**匹配不上就是 `null`**（不猜）。

> `board` 这个字段与 `list_connections` 的 `board_pack` **不是一回事** ✓：
> 前者是**当前生效的那块板的包 id**，后者是**这条连接绑的包 id**。

#### `describe_tag(name)`

```
→ { name, type, unit, range, semantics, status, value, board,
    source: { reader, kind, args_summary }, history: [...] }
```

`semantics` 是 tag 契约里的语义描述原文。**这是防误用的关键**——agent 看到 `npu.usage` 就该知道它是「各 NPU 核占用率的最大值」，而不是任何模糊的「NPU 负载」。

> `semantics` 是**词表原文**（**含 Markdown 强调标记**——agent 按纯文本读 ✓）；
> 没有词表条目（`custom.*` 的私有量）是 `null`。

`source.args_summary` 让 agent 知道这个量是怎么来的（哪个文件、什么 kind），但**不暴露**具体命令（避免 agent 学着去发裸命令）。

**放行表按 `(kind, 参数名)` 判定**——**不按参数名单独判定**：

| kind | 给 agent 的参数 | 挡掉的 |
|---|---|---|
| `proc_stat` | `stat_path`, `cpuinfo_path` | — |
| `meminfo` | `path` | — |
| `devfreq_load` | `path`, `measure` | — |
| `rknpu_load` | `path` | — |
| `thermal_zone` | `glob`, `type_map` | — |
| `file_read` | `path`, `glob`, `format`, `strip_trailing_null` | — |
| `exec_regex` | `pattern`, `format` | **`command`** |
| `script` | **（空）** | **`path`, `interpreter`, `format`** |

> **为什么不能按参数名单独筛**：`path` 在 `file_read` 是**板上路径**（可给），
> 在 `script` 是**宿主文件系统上的路径**（不可给——泄漏本机目录结构，
> 且 `interpreter + path` 拼起来就是一条命令）。
> **不在表里的参数一律不给**（封闭表，不是「先给再筛」）。
> `script` 的 `args_summary` **恒为空对象**——agent 只知道「这个量来自一个脚本」。

**`history`** = 最近的样本，形状与 `sample_tag` 完全一致：`[{ value, unit, status, at }]`。
`at` 是**本次采样完成的时刻**（毫秒 UTC）。

#### `sample_tag(name, n)`

```
→ [{ value, unit, status, at }, ...]
```

取最近 n 个样本。给 agent 判断「这个量是稳定的还是抖动的」，以及「刷新周期实际是多少」。

| 项 | 语义 |
|---|---|
| `n` | 最近 **n** 个样本（**不是最近 n 秒**） |
| **先采一次** | **先定向采一次** `name` 所在的轮询组（**一次往返**），**再**从样本缓冲里取最近 n 个 |
| `n` 大于已有的样本数 | **有多少给多少**（不补） |
| `n ≤ 0` | `invalid_params` |
| 这个 tag 从来没被读过 | **空数组**（不是 `null`） |

> **为什么要先采一次**：不采的话，agent 拿到的是**冻结的旧样本**（连接断了就永远不更新）——
> 那它判断的「抖动」是**过去**的抖动。
> **代价是一次往返**——agent 可以拿这个工具当「刷新一次」用。

---

### 2.2 查已有卡片

#### `list_cards()`

```
→ [{ id, name, version, path, installed_at, status, degraded, missing_tags }]
```

#### `list_cards()`

```
→ [{ id, manifest_id, name, version, path, installed_at, status,
     degraded, missing_tags, unreadable_tags }]
```

`degraded` / `missing_tags` 让 agent 知道这张卡在当前板上是不是残的。

| 字段 | 含义 |
|---|---|
| `id` | **卡片 id = 卡片目录名**——宿主侧一切按它索引（`uninstall_card` / `get_card_runtime_log` / 布局都用它） |
| `manifest_id` | manifest 里声明的 id（**可以与目录名不同**——所以要两个字段**） |
| `name` / `version` | manifest 的 |
| `path` | 卡片目录的**绝对路径** |
| `installed_at` | **卡片目录的最后修改时刻**（毫秒 UTC）——**不是「人点装上的时刻」** |
| `status` | `ok` / `degraded` / `invalid`（封闭） |
| `degraded` | 这张卡在当前板上**是不是残的**（布尔） |
| `missing_tags` | 这张卡要的、**当前板型包根本没有**的 tag |
| `unreadable_tags` | 声明了、包也提供了、但**现在读不出来**的 tag |

> **`installed_at` 的免责** ✓：宿主**从没记过安装时间**——
> 加一个字段要改所有卡的落盘流程，而 MCP 契约明写「不做文件 IO（除了 install_card 的复制）」。
> → **用目录 mtime** ✓，并**明写它是什么** ✓——
> **否则 agent 会拿它排序「最近装的卡」** ✗（那会错）✗。

**`status` 的取值域**（封闭）：

| 值 | 含义 |
|---|---|
| `ok` | manifest 合法，**且**它要的 tag 都可读 |
| `degraded` | manifest 合法，**但**有 tag 读不到 |
| `invalid` | **manifest 本身不合法** |

> **`invalid` 的卡仍然列出来** ✓——agent 要知道「我上次装的那张卡坏了」✓。

**「读不到」与「不存在」是两件事**（同 `spec/01` §2.1 的 `unavailable` vs `error`）：

| 字段 | 判据 | 粒度 |
|---|---|---|
| `missing_tags` | 对 `permissions.read` 的**每个模式** P：当前板型包的所有 reader 的 provides 模式里**没有一个覆盖 P** → **P 整条记进去** | **模式级**（记模式本身，不展开） |
| `unreadable_tags` | **该具体名在读数里存在**，**且**状态不是 `ok` | **具体名级**（只列读数里有的那些） |

> **通配 tag 的实例在读数里缺席时，不得据此判定「缺失」**——
> 采样器**按契约不猜具体实例名**。
> `degraded` = `missing_tags` 非空 **或** `unreadable_tags` 非空。

#### `get_card_sdk_docs(topic?)`

```
→ { apiVersion, topics: [...], content }
```

写卡片时的语法参考：manifest 格式、可用 API、白名单方法、示例卡片。

`topic` 可选：`"manifest"` / `"api"` / `"examples"` / `"layout"`。省略则返回全部。

**注意**：这是**语法**参考，不是**现状**参考。现状永远用 `list_*` 拿。

**`content` 是一个字符串**（agent 把它当提示词的一部分读）。

**从活代码与活数据生成**——**不是手抄的静态文本**（手抄的会漂：
API 加一个方法它不会自己更新，agent 照着写会调一个不存在的 API）：

| topic | 来源 | 生成方式 | 限制 |
|---|---|---|---|
| `manifest` | 卡片 manifest 的**封闭 schema 白名单表** | 字段名与必填性**从代码取**；**字段语义从 `03` §二取** | — |
| `api` | 卡片 API 注册表 | 方法名 / 参数 / 权限维度从代码取；**每个方法补一句说明** | — |
| `examples` | 内置卡目录 | manifest **+ 入口的 html/js** | 每张卡 ≤ 8 KB，超出截断并标注 |
| `layout` | 布局的纯数据形状 | **按本契约的词写**（`cards` / `card_id`） | 不照抄实现层的内部字段名 |

> **代码给形状，契约给语义** ✓。

---

### 2.3 写卡片与自测

#### `validate_card(path)`

```
→ { ok, errors: [...], warnings: [...],
    resolved: { tags, actions, layout, missing_tags, missing_actions } }
```

静态校验，**不安装**。校验规则见 `03-card-manifest.md` §九。

`resolved` 告诉 agent：这张卡实际会绑到哪些 tag 和动作，哪些会缺失。

| 字段 | 含义 |
|---|---|
| `resolved.tags` | 这张卡**要读、且当前板上可读**的 tag（**具体名**） |
| `resolved.actions` | 这张卡**要写、且当前板型包里确实有**的动作 id |
| `resolved.layout` | 解出来的格子尺寸（`w`/`h`/`min_w`/`min_h`）；**没有 layout 就是 `null`** |
| `resolved.missing_tags` | 要读但**当前不可读**的 tag（口径同 `list_cards` 的 `missing_tags`） |
| `resolved.missing_actions` | 要写但**当前板型包里没有**的动作 id |

> **`resolved.tags` / `resolved.actions` 是「声明 ∩ 当前可用」**——
> 不是**声明值**。agent 要知道的是「这张卡真能绑上什么」，
> 而不是「它声称要什么」。

#### `get_card_runtime_log(cardId, since?)`

```
→ [{ level, at, message, source }]
```

卡片运行时的错误。`level` ∈ `error` / `warn` / `info`。

卡片崩了、tag 读失败了、action 回读不匹配了，都在这里。

| 字段 | 含义 |
|---|---|
| `level` | `error` / `warn` / `info`（封闭） |
| `at` | 毫秒 UTC |
| `message` | 一句话 |
| `source` | `card` / `host` / `csp`（封闭） |
| `since`（参数） | 只给 `at >= since` 的（毫秒 UTC）；**缺省给全部** |

> **日志是运行时内存**（每卡最多 200 条）——**重启即失**。
> `since` 的过滤在宿主侧做。

#### `install_card(path)`

```
→ { ok: true, card_id, installed: true, degraded: bool, missing: [...] }
```

把卡片目录放进卡片根目录，触发热重载。

**如果这张卡需要新的授权**，`install_card` **不会**直接装上，而是返回：

```
→ { ok: false, reason: "needs_consent",
    card_id, installed: false, needs_consent: true,
    consent_id: "c-123",
    pending: [
      { action: "backlight.set", danger: "reversible", label: "设置背光亮度",
        guard: { value: { min: 16, max: 255 } } },
      { action: "system.reboot", danger: "destructive", label: "重启板子" }
    ] }
```

**三个返回形状**（封闭）：

| 情形 | 返回 |
|---|---|
| 装上了 | `{ ok: true, card_id, installed: true, degraded, missing }` |
| 要人授权 | `{ ok: false, reason: "needs_consent", card_id, installed: false, needs_consent: true, consent_id, pending }` |
| 用户拒绝了全部 | `{ ok: false, reason: "denied", card_id, installed: false, denied: [...] }` |

**`pending[]` 与 `denied[]` 同形**：每条是
`{ action, danger, label, guard? }`（`guard` 可省 ✓）。

> `reason: "denied"` 是**「人拒绝了」**；
> `denied[]` 是**被拒绝的那几条**——**同名，两种角色** ✓。

`degraded` 与 `missing` 的口径**同 `list_cards`**（`missing` = 缺失的 tag 名清单）。

**这不会让 agent 的回路卡死。** 流程是：

1. agent 调 `install_card` → 拿到 `consent_id` 和待授权动作清单
2. **GUI 弹出确认框**，列出这些动作，**显示参数域**（`guard`），让用户逐个批准或拒绝
3. 用户点完，GUI 把结果写进授权存储
4. agent 再调一次 `install_card`（同一个 path）→ 这次装上了

也就是说：**用户交互发生在 GUI 里，agent 只是重试。** agent 不需要弹窗，也不需要
自己去问用户「你可以吗」——它把请求递出去，然后重试。

第 2 步用户点完之后，agent 的下一次 `install_card` 会成功。如果用户拒绝了全部，
`install_card` 返回 `installed: false, denied: [...]`，agent 就知道这条路走不通。

**`consent_id` 绑定 manifest 哈希。** 它授权的是**用户当时看到的那份 manifest**：

| 项 | 规则 |
|---|---|
| 绑定 | `(manifest 的内容哈希, 目录快照)` |
| 文件变化 | manifest 或目录内容在校验与授权之间变了 → `consent_id` 失效，重新征求 |
| 一次性 | 消费即失效；重试用同一个 `consent_id` 只允许一次 |
| 有效期 | 默认 5 分钟 |

> **为什么绑哈希**：`validate_card(path)` 与 `install_card(path)` 之间，
> 文件可能被换掉——包括被另一个进程换掉。若授权只绑「卡片 id」，
> 用户批准的是 A 的 manifest，装上去的却是 B。
> 绑哈希把「人批准的那份东西」与「实际装上的那份东西」钉在一起。

**和文件监听的分工**：两条路都通，但作用不同。

| | 用途 | 语义 |
|---|---|---|
| **直接写文件** | agent 改一张**已装**的卡 | 触发热重载。**manifest 的 `permissions.write` 变了就要重新征求授权**（见 `03` §3.3） |
| **`install_card`** | 装一张**新**卡，或从别处拷进来 | 等价于「复制目录 + 重载」，幂等：同一个 id 重复安装是**替换** |

如果 agent 用 `install_card` 装一张已经装过的、但 `permissions.write` 不同的卡，
**同样要重新征求授权**。两条路在授权上没有区别——否则「换个方式就绕过授权」了。

**直接写文件这条路也要过同一道校验**：文件监听触发热重载时，
运行时必须重新校验 manifest（§`03` §九 的 13 条）与重新计算权限集，
不能因为「是文件监听触发的」就跳过。这就是两条路等价的具体含义。

**agent 的标准回路**：

```
validate_card(path) → 改 → validate_card(path) → install_card(path)
    → (若 needs_consent: 用户在 GUI 里点，agent 重试)
    → get_card_runtime_log(cardId) → 看错 → 改 → install_card(path) → …
```

`install_card` 是幂等的：同一个 id 重复安装是**替换**，不是新增。

#### `uninstall_card(cardId)`

```
→ { ok }
```

删掉用户卡片根下的那个目录。**内置卡删不掉**（`denied`——它在应用目录里）。

| 情形 | `reason` |
|---|---|
| 卡不存在 | `not_found` |
| 是内置卡 | `denied` |
| 删掉了 | 无（`ok: true`） |

**副作用**：删目录，**该卡的授权账一并清掉**——
否则装回来就带着旧的授权（那不是「重新装」，那是「装回来」）。
**卡片存储保留**（`03` §六·2）。

---

### 2.4 执行动作

#### `execute_action(actionId, params, dry_run, device_key?)`

```
→ {
    ok: true,
    readback: { value, unit, status, at },
    verified: true,
    audit_id: "...",
  }
```

或失败时：

```
→ {
    ok: false,
    reason: "readback_mismatch" | "denied" | "not_found"
          | "needs_confirmation" | "timeout" | "invalid_params" | "failed"
          | "unsupported_transport" | "guard_exceeded" | "cancelled",
    expected: true, actual: false,
  }
```

**`cancelled` 是什么**（2026-11-15 新增，依据 **ADR-D36** ✓）：
**这次执行被叫停了** ✓ —— 不是「跑失败了」✓。
→ 它的退出码是 `null` ✓（**不是 0、也不是 124** ✓）；
→ **不报 `readback_mismatch`** ✓（那是在说「板子不听话」✗ —— 人叫停 ≠ 板子不听话 ✓）；
→ **超时与取消是两件事** ✓（`timeout` vs `cancelled` ✓ —— 事实 G1 ✓）。

**`verified` 字段**（2026-11-13 新增，依据 `docs/05` ADR-D25）：

| 值 | 含义 |
|---|---|
| `true`（默认） | 动作执行了，**并且回读确认了**板子确实进入了目标状态 |
| `false` | 动作执行了，**但没有回读**——这个动作声明的是 `readback: {kind: none}`（`02` §4.4.1 形式 5） |

**为什么不是一个 `reason` 码**：`reason` 是**失败**的原因。
`verified: false` **不是失败**——命令确实执行了、效果也确实有（点 LED 亮了）。
报 `ok: false` 是**另一种撒谎**；报 `ok: true` 什么都不说又是**把「没验证」藏起来**。

> **`unverified` 不在这张 `reason` 表里，也不在 `01` §2.1.1 的 tag `reason` 表里。**
> 两张表是两回事：`01` 的 `reason` 是 **tag 读数**的原因码（`not_found` /
> `device_absent` / …），本节的 `reason` 是**动作执行**的原因码。
> **但「你问的那个东西不存在」两边同名同义**（都是 `not_found`）——
> **不给 AI 两套要互相翻译的方言**（ADR-D27）。
> **`unverified` 不是 tag 状态**——加进去会污染所有 tag 消费者。

**UI 口径（写死）**：`verified: false` → 卡片**必须**显示「**已执行，未验证**」，
**不得**显示成「已生效」。
这与 `02` §4.1 已有的那句「命令已发出，未确认生效」是同一件事——
**驾驶舱不能把没验证的东西显示成生效了。**

**参数**：

| 参数 | 含义 |
|---|---|
| `actionId` | 板型包里声明的动作 id（不是卡片 id） |
| `params` | 按动作声明的参数 |
| `dry_run` | 只返回「将会执行什么」，不执行 |
| `confirm_id` | 用户已确认的那一次执行的凭据（`§2.4.1`） |

**为什么要按动作 id 而不是卡片 id**：动作是板子的能力，卡片只是引用者。同一张卡可以调多个动作，同一个动作也可以被多张卡调。按动作 id 授权更精确（授权的是「改背光」这件事，不是「这张卡」）。

**行为**：

0. **给了 `device_key` → 它必须是当前运行时那条连接的 `device_key`** ✓
   → 否则 **`not_found`** ✓（detail 写清「没有这个设备：X」✓）。
   → **绝不允许「忽略 `device_key` 然后打当前那块」** ✓ —— **那是「静默地做另一件事」** ✗。
1. 查动作在当前板型包里存在吗 → 否则 `not_found`
2. 查调用方的授权 → 否则 `denied`
3. 校验参数（类型、范围、枚举）→ 否则 `invalid_params`
4. **`dry_run: true` → 直接返回将要执行的命令 + 参数**（**不执行、不回读、不写审计**）
   —— **它在第 5/6 步之前** ✓：否则 agent 永远拿不到 `destructive` 动作的预览 ✗
5. 参数超出该动作的 `guard` 域 → `needs_confirmation`（**另带 `guard_exceeded: true`** ✓）
6. `danger: destructive` 且未获确认 → `needs_confirmation`
7. 执行 → 失败则 `failed`（命令非零退出）；串口上不支持依赖退出码的动作则 `unsupported_transport`
8. 回读 → 不符则 `readback_mismatch`。
   **若该动作声明的是 `readback: {kind: none}`（`02` §4.4.1 形式 5）→ 跳过回读，
   返回 `ok: true` + `verified: false`**
9. 写审计日志（用 `none` 的动作必须在审计里标出「未验证」，`02` §5.4）

> **`dry_run` 不写审计** ✓：审计记的是「**每一次尝试**」——
> 而 dry_run **连尝试都不是**（它是一次**预览**）→ 写进去会污染「谁动过板子」这本账 ✓。

**`not_found` 与 `denied` 的顺序**：先查存在性，再查授权。这样一个未授权的调用方能知道
「这个动作存在」，但**不能知道它会做什么**——动作的 `command` 只在通过授权后才返回。
这条顺序是有意的：它让「板子上有没有这个能力」是可发现的，而「这个能力怎么实现」不是。

**`dry_run` 返回的 `command` 是**编码后**的最终命令**（`02` §4.6），
不是模板。这样 agent 在预览时看到的与实际执行的完全一致。

**`dry_run` 的返回形状**（`02` §5.3 的形状 **+ 本节 §四 的 `ok`** ✓）：

```
→ { ok: true, dry_run: true, command: "...", readback_tag: "..." }
```

`readback_tag` 是这个动作的回读要读哪个 tag；**回读不是「读 tag」形式时是 `null`** ✓。

#### 2.4.1 agent 的授权

**agent 不是卡片，它有一套自己的授权。**

卡片授权是「装卡时按动作问一次」，agent 授权是另一回事：agent 可以直接调任何动作，
不需要先装一张卡。

规则：

| 档 | agent 怎么做 |
|---|---|
| `reversible`，参数在 `guard` 域内 | agent 直接可以执行，**记审计日志** |
| `reversible`，参数**超出** `guard` 域 | 走一次确认（同 `destructive` 的流程） |
| `destructive` | **必须有人在 GUI 里点确认**。agent 提交请求，然后等 |

**三条细则**：

| # | 细则 |
|---|---|
| 1 | agent 的授权集 = **当前板型包声明的全部动作**——**且这个包已经由人确认过**（§2.4.2 ✓ · `02` §5.6 ✓）。**未经人确认的包根本不生效** ✓ |
| 2 | 参数域用**动作自己声明的 `guard`** ✓——卡片那份「人授过的更窄的域」**对 agent 不适用** ✓（那是卡片的事 ✓） |
| 3 | **先查存在性、再查授权** ✓（上面的行为表 ✓）——动作的 `command` 只在通过授权后才返回 ✓ |

> **`denied` 在 v1 几乎不会发生** ✓（除了「没有包」✓）→ **但它必须存在** ✓：
> 它是**这个位置的护栏** ✓——将来若加「按连接/按用户的更窄授权」✓，这个理由码已经在那儿了 ✓。
> **说清楚**：不要以为它一直在生效 ✗。

**破坏性动作的确认需要人。** agent 不能自己造确认凭据。

流程：

1. agent 调 `execute_action(actionId, params)`，动作是 `destructive`（或参数超出 `guard`）
2. 返回 `ok: false, reason: "needs_confirmation"`，带一个 `confirm_id`
3. **GUI 弹出模态框**，显示这个动作要做什么、参数是什么
4. 用户点「确认」或「取消」
5. 用户点完后，agent **再调一次** `execute_action`，这次带上 `confirm_id`
6. 这次才真的执行

也就是说：**人机交互发生在 GUI 里，agent 只是重试。** 和 `install_card` 的
`needs_consent` 是同一个模式。

**为什么不让 agent 自己确认**：agent 是概率性的，它可能误解意图。
重启板子这种动作不可逆，值得多一次确认——而「多一次确认」只有在**人**参与时才有意义。
一个能自己给自己发确认的确认框，等于没有确认框。

**确认界面必须显示最终命令与参数域。** 光显示动作名不够：
「重启板子」背后是 `reboot`，而「把背光调到 30」背后是
`echo 30 > /sys/class/backlight/backlight/brightness`。
用户要看到的是**将要发生什么**，不是动作的标签。

**agent 不能做的事**：agent 不能改授权本身。它不能给自己提权，
也不能修改任何卡片的授权。它只能执行已声明的动作。

#### 2.4.2 板型包的信任

**包一律生效**——但「生效」的前提是**人确认过这个包**。

| 谁写的 | 能不能直接生效 |
|---|---|
| 用户自己写的、内置的 | 能 |
| agent 起草的 | **不能**：写文件可以（那是 agent 的本职工作），**装包要人点头** |

**为什么加这一条**：板型包里的 reader 可以执行任意命令
（`exec_regex` / `script`），而**危险地板只管动作**（`02-board-pack.md` §5.2）。
「包一律生效 + agent 可以写包」合起来就是一条绕过确认的通道——
这与 §1.3「不准有裸 send_command」是同一个东西换了入口。

所以：**卡片的创作面是 agent 的，设备的权限面是人的。**
agent 可以起草包，但启用它需要用户在 GUI 里确认——确认界面必须展示
这个包会执行哪些命令、声明哪些动作、每个动作多危险（`02-board-pack.md` §5.6）。

**为什么这样选**：这个产品的核心价值就是「AI 照着手册批量制造仪表和开关」。
如果 agent 写的每一张**卡**都要人批准，协作回路就断了——
所以卡片不审批（`03` §3.3），而**包**审批。
区别在于：卡片只能读 tag、调已声明的动作（受分级约束）；
包能定义新的、能执行任意命令的读数来源。

**那危险等级怎么办**：靠**地板**（`02-board-pack.md` §5.2）。

包自己声明 `danger`，但有一张固定的操作模式表属于契约：
`reboot`、`mkfs`、`dd` 到块设备、`flash`……这些命令**永远**按 `destructive` 处理，
不管包怎么声明。

所以 agent 确实被信任了，但它**不能自己把「重启板子」降级成可逆动作**。
被信任的是「agent 可以自己写东西」，不是「agent 可以绕过人的确认」。

（这条张力是真实的：如果完全不管，agent 写一个 `danger: reversible` 的 reboot 动作，
分档就没意义了。地板是让这两个意图同时成立的最小机制。）

#### `list_workflows()`

```
→ [{ id, name, inputs: { … } }]
```

列**用户批过的**流程（`05` §7.2 的批准账 ✓）。

> **只给 id / name / 输入声明** ✓ —— **不给拓扑** ✓
> （哪个角色连哪台机器、跑什么命令 → **那是未授权方不该看到的** ✗）。

#### `run_workflow(id, inputs, dry_run)`

```
→ { run_id: "wf-…" }
```

跑一个流程。**立刻返回** ✓（编译是分钟级 ✓）→ 进度用 `workflow_status` 轮询 ✓。

**`dry_run: true` → 预览** ✓（**不跑** ✓）：

```
→ { ok: true, steps: [{ id, kind, role?, command?, action?, readback?, danger, timeout_ms? }] }
```

| 项 | 规则 |
|---|---|
| **跑什么** | **一步都不跑** ✓ —— 它是**预览** ✓ |
| **写审计吗** | **不写** ✓ —— 审计记的是「每一次尝试」✓；**预览连尝试都不是** ✓ |
| **有 `run_id` 吗** | **没有** ✓ —— 没有运行 → 没有运行 id ✓ |
| **占位符** | **输入值按类型编码后替换** ✓（字符串带引号 ✓ —— 同 `02` §4.6 ✓）；**角色事实与输出槽留占位** ✓ —— **没连接、没跑，不知道** ✓ |
| **危险等级** | 每步都要给 ✓（默认 `reversible` ✓）—— agent 要知道**哪一步会毁东西** ✓ |
| **没批过的流程** | **不给预览** ✓（`not_approved` ✓）—— 预览会泄出「这个包会干什么」✓ —— **那是没授权方不该知道的** ✗ |

#### `workflow_status(run_id)`

```
→ { state: "running" | "awaiting_confirmation" | "done" | "failed" | "cancelled",
    current: { stepId, kind, at } | null,
    stages: [ { stepId, kind, ok, verified, reason?, audit_id } ] }
```

> **`current` = 当前这一步**（`05` §八·B ✓）：**正在跑** ✓ **或** **停下等人点头** ✓；
> 运行已结束 → `null` ✓。
> → `at` = **那一步开始的时刻** ✓（界面据此算「已经用了多久」✓）。
> → **`current` 是活快照**（会变 ✓），`stages` 是**只增不改** ✓（两者幂等性不同 ✓，`05` §八·B·B3 ✓）。
> → **`current` 不给角色** ✓（不给拓扑 ✓）。
> → **卡片侧看到的是一份缩减投影** ✓（`03` §7.7 ✓）—— **不是**这个形状原样搬过去 ✓。

#### 取消

**agent 没有取消流程的工具** ✓ —— **「停不停」是人的判断** ✓（`05` §八·A·A4 ✓）：
「行不行」不给 agent ✓（§2.4.1 ✓），「停不停」也不给 ✓。

#### `confirm_workflow(run_id)`

```
→ { confirm_id: "...", expires_at: 1762910000000 }
```

**递一次确认请求**（人点了才有效 ✓）。

> **`expires_at` 是毫秒 UTC 的绝对时刻** ✓（同 §四 的「时间」那条 ✓）。

> **⚠️ 这个工具不使凭据生效** ✓ —— 它只是把请求递到 GUI 的确认队列 ✓
> （同 `confirm_action` ✓）。**「批准」这个动作不是 MCP 工具** ✓——
> 它在 GUI 那一侧 ✓。**agent 调不到它** ✓。

#### `confirm_action(actionId, params, device_key?)`

```
→ { confirm_id: "...", expires_at: 1762910000000 }
```

请求对 `destructive` 动作的一次确认。

**注意**：这个工具**不返回可直接使用的凭据**——它只是把请求递到 GUI 的确认队列，
并给 agent 一个 `confirm_id`。真正的确认要等**人**点了之后，`confirm_id` 才有效。
没有人点，`confirm_id` 永远无效。

`execute_action` 带 `confirm_id` 重试时，若用户已点确认则执行，否则仍返回
`needs_confirmation`。

> **`expires_at` 是毫秒 UTC 的绝对时刻** ✓（同 §四 的「时间」那条 ✓）。
> —— 本节早前写的 `1762910060` 是**笔误**（那是秒级）✓。

##### `confirm_id` 的生命周期（**动作与流程同一套** ✓）

`confirm_id` 是「人已经批准了**这一次**特定执行」的凭据，所以它必须绑得很死：

| 项 | 规则 |
|---|---|
| 绑定 | `(动作 id, 参数的规范化摘要, 板型包 id, 契约版本, **这一步最终命令的摘要**, **device_key**)` |
| 参数变化 | **参数一变，凭据立即失效**。用户批准的是「把背光调到 30」，不是「把背光调到任意值」 |
| 一次性 | **消费即失效**。用一次就作废，不能重放 |
| 有效期 | 默认 5 分钟（`expires_at`）。过期后要重新请求 |
| 确认界面 | 必须显示动作名、**参数与最终命令**、参数域，以及这次执行的后果 |
| 用户拒绝 | `confirm_id` 立即作废，不再有效；agent 收到 `denied` |
| 数量 | 同一动作可以同时挂多个待确认请求（agent 并行提问），但各自独立 |

> **为什么要绑「最终命令的摘要」** ✓：最终命令是**消费时现算**的 ✓ ——
> 不绑它 ✓ → 同一张凭据可能认得**两条不同的命令** ✗（同 `05` §7.5-3 的同款理由 ✓）。

**流程层的扩展**（`05` §7.5 ✓）：

| 项 | 流程层的规则 |
|---|---|
| **绑定** | `(动作 id（含**步骤 id**）, 参数摘要 + **这一步的输入摘要**, **这一步最终命令的摘要**, 包 id, 契约版本)` |
| **谁能批** | **只有人点的路径**（GUI 确认界面 / 宿主命令行 ✓）—— **agent 只能递请求** ✓ |
| **批完怎么续** | 流程**从停住的那一步继续**（**前面的步不重跑** ✓），**同一个 `run_id`** ✓ |
| **重新触发** | **= 从头再跑** ✓（与「续跑」是**两条互斥的路** ✓） |

> **为什么绑参数摘要**：如果凭据只绑动作 id，agent 完全可以先要一次
> 「把背光调到 30」的批准，再拿同一个 `confirm_id` 去执行「把背光调到 0」——
> 人批准的那一次和实际执行的那一次不是同一件事。
> 绑定参数摘要 + 一次性消费，是让「人确认过」这句话有确切所指的两条最小机制。

##### 参数域与确认的关系

`execute_action` 的参数若**超出该动作的 `guard` 域**（`02` §5.5），
即使动作是 `reversible`，也要走同一条确认通道：

| 情形 | 返回 |
|---|---|
| 动作 `destructive` | `needs_confirmation` |
| 参数超出 `guard` 域 | `needs_confirmation`（`reason` 同为 `needs_confirmation`，另带 `guard_exceeded: true`） |
| 动作 `reversible` 且参数在域内 | 直接执行 |

> **`guard_exceeded` 是一个标志位，不是 `reason` 码** ✓——
> `reason` **恒为 `needs_confirmation`** ✓。

---

### 2.5 布局

#### `promote_card(cardId, connectionId?)`

```
→ { ok, mode: "fullscreen" }
```

把卡片提为全屏。交互上终端这类东西必须能独占（`htop` 在小卡里没法用），但契约上它仍是一张卡。

**它改的是布局** ✓ —— **全屏是布局的一个状态** ✓（`promoted` ✓），不是一次性的渲染指令 ✓。

| 项 | 规则 |
|---|---|
| **记什么** | **只记「哪一格要全屏」** ✓（`{card_id, connection_id, x, y, w, h}` ✓ —— **它原来的位置与连接** ✓） |
| **铺几行** | 「**铺满当前主区可视高度**」的格数——**由渲染层按视口算** ✓ |
| **其它格** | **宿主不动它们** ✓ —— 「让开」也是**渲染层**的事 ✓ |
| 连接 | `connectionId` 缺省 = 该卡**唯一**的实例；**多于一个时报错**（不猜） |

> **为什么「铺几行」由渲染层算** ✓：
> **行高与视口高度只有 renderer 知道** ✓（`ROW_HEIGHT` 是渲染层的常量 ✓）→
> **宿主算就是猜** ✗ → **宿主记「谁要全屏」✓，渲染层算「铺几行」✓** —— **两边都不猜** ✓。
>
> **为什么「让开」也是渲染层的事** ✓：
> 布局模型**没有「隐藏」这个概念** ✓（`LayoutUnit` 只有 6 个字段 ✓）→
> 宿主擅自挪别人的格 = **毁用户的排布** ✗ → **宿主只记状态** ✓。
>
> **为什么用「改布局」而不是「新增一个 mode 字段」** ✓：
> 新增 mode → 布局模型要长出第二套形状（格式版本要升 ✓ · 渲染器要改 ✓）；
> 改布局**复用已有的那套** ✓（持久化 ✓ · 渲染 ✓）。
> **代价**：全屏会**占掉用户的布局** ✓（要靠 `set_layout` 恢复 ✓）—— **明说这个代价** ✓。

#### `set_layout(layout)`

```
→ { ok, dropped: [...] }
```

保存布局（**整份替换**——不是增量）。

**写之前先归一** ✓：

| 项 | 规则 |
|---|---|
| `x` / `y` | 非负整数 |
| `w` | `1 ≤ w ≤ 12` |
| `h` | `h ≥ 1` |
| **重叠** | **不判**（交给渲染器） |
| 越界的格子 | **整条丢掉** ✓，并在 `dropped[]` 里报它的 `card_id` ✓ |

#### `get_layout()`

```
→ { cards: [{ card_id, connection_id, x, y, w, h }] }
```

| 字段 | 含义 |
|---|---|
| `card_id` | 卡片 id（**与 `list_cards[].id` 同名同义** ✓） |
| `connection_id` | 这个格子绑的是哪条连接（`null` = 没有连接上下文） |

> **布局的键是 `(card_id, connection_id)`** ✓ —— 一张卡在多条连接上各有一个格子 ✓。

---

## 三、工具集之外的接口

MCP 覆盖的是 **AI ↔ GUI**。另外两条通道不走 MCP：

| 通道 | 用途 | 为什么不是 MCP |
|---|---|---|
| **文件系统** | agent 直接编辑卡片目录 | MCP 不做文件 IO。agent 写文件比走 MCP 快得多，而且是它最擅长的 |
| **文件监听** | 卡片目录变化 → 热重载 | 运行时内部机制 |

这意味着 agent 的实际工作流是：

```
在文件系统里写卡片文件        ← 直接写文件
    ↓
validate_card(path)          ← MCP：检查
    ↓
install_card(path)           ← MCP：装上（或者放对目录，监听自动装）
    ↓
get_card_runtime_log(id)     ← MCP：看运行结果
```

**MCP 是 AI 的眼睛和手，不是 AI 的硬盘。**

---

## 四、返回值的共同约定

| 约定 | 内容 |
|---|---|
| 错误 | 用 `ok: false` + `reason`，不抛异常 |
| 未知 | `status: "unavailable"`，不返回 `null` 也不返回 0 |
| 时间 | 毫秒时间戳，UTC。`at` = **本次采样完成**的时刻，不是广播时刻<br>**（流程那一侧是例外 ✓：`05` 的 `at` = **那一步开始**的时刻 ✓ —— 同一个字段名在流程里指的是「那一步什么时候起的」✓）** |
| 路径 | 绝对路径 |
| 版本 | `apiVersion` 字段在每个响应里都带上（**列表是每一项都带** ✓） |

> **版本字段的拼写统一为 `apiVersion`**（与 manifest、板型包一致）。
> 历史上出现过 `api_version` 与 `version` 三种写法，
> 现在只有 `apiVersion` 一种——响应里的 `apiVersion` 表示**契约版本**，
> 不是工具集自己的版本。

> **「值是 null」与「这一项没有」是两件事** ✓：
> `status: "unavailable"` 说的是**读数** ✓；
> 而 `range` / `semantics` / `type` 这类**元数据字段**在词表里查不到时给 `null` ✓
> （意思是「**这一项没有**」✓）——不矛盾 ✓。

### 4.1 失败理由码（**一张表，所有工具共用** ✓）

**封闭** ✓ —— **所有 MCP 工具的失败都从这里取** ✓：

| 码 | 什么时候 | 谁用 |
|---|---|---|
| `invalid_params` | 参数不合（类型/范围/枚举/取值非法） | **全部** ✓ |
| `not_found` | 东西不存在（动作/流程/卡片/读数**同名同义** ✓ ADR-D27 ✓） | **全部** ✓ |
| `denied` | 不许做（用户拒绝 / 无授权） | 写侧 ✓ |
| `needs_confirmation` | 要人点头（**带 `confirm_id`** ✓） | 写侧 ✓ |
| `not_approved` | 这个包/流程**用户还没批过** | 流程 ✓ |
| `busy` | 同一件事正在跑，不能并发 | 流程 ✓ |
| `no_pending_confirmation` | 这次运行**没有待确认的步骤** | `confirm_workflow` ✓ |
| `invalid` | 内容不合法（manifest 本身不合法） | 卡片侧 ✓ |
| `failed` | 别的失败 | **全部** ✓ |
| `readback_mismatch` | 回读到的值与期望不符 | `execute_action` ✓ |
| `timeout` | 命令或回读超时 | `execute_action` ✓ |
| `unsupported_transport` | 回读要退出码而这条连接没有（串口） | `execute_action` ✓ |
| `cancelled` | **被叫停**（不是失败 ✓） | `execute_action` ✓ |

> **`guard_exceeded` 不在这张表里** ✓ —— 它是一个**标志位** ✓，
> `reason` **恒为 `needs_confirmation`** ✓（§2.4 ✓）。

> **码表加项 = 契约变更** ✓ —— 与 `danger_floor_version`（`02` §5.2.1 ✓）、
> `reason_code_version`（`01` §2.1.1 ✓）是**同一套治理** ✓：
> 封闭词表改了就要走评审 ✓。

### 4.2 `apiVersion` 什么时候升（**口径** ✓）

| 情形 | 升不升 |
|---|---|
| **`devboard/v1` 尚未随任何实现发布** | **不升** ✓ —— 这是「**v1 定稿前的修正**」✓（先例 `docs/05` ADR-D24 / D25 / D26 ✓） |
| **v1 已发布之后** | **一律升** ✓ |

> **理由不能写成「加字段不算破坏性变更」** ✓ —— 本工程**没有**这条通则 ✓：
> 封闭 schema 管的是**产物**（manifest / pack / workflow 的输入 ✓），
> **MCP 响应不是产物** ✓ → 加字段不违反已声明的规则 ✓，
> 但**依据是「v1 未发布」** ✓ —— **换个依据就站不住了** ✓。


**`sample_tag(name, n)` 的 `n` 是「最近 n 个样本」**，不是「最近 n 秒」。
窗口长度由各 tag 所在 poll group 的周期决定（`01` §3.2），
所以同一个 `n` 在不同 tag 上覆盖的时间跨度不同——agent 要判断「抖动」时
应该先看 `list_data_sources` 里的 `interval_ms`。

---

## 五、给 agent 的三条硬规则

写进 SDK 活文档里：

1. **不要发裸命令。** 要一个新能力，就写一个 board pack 扩展或一个卡片 action。
2. **不要乐观更新 UI。** 动作之后一律用 `readback` 的值渲染。
3. **写完卡一定要 `validate_card` + `get_card_runtime_log`。** 盲写出来的卡大概率是坏的。

第 3 条是整个协作回路的成败点。

---

## 六、MCP 自身的边界

| 不做 | 理由 |
|---|---|
| 不做文件 IO（除了 `install_card` 的复制） | agent 直接写文件更快 |
| 不做通用 shell | 见 §1.3 |
| 不存 agent 的状态 | 每次调用自带上下文 |
| 不猜 agent 的意图 | 显式参数 + dry-run |

MCP server 应该是**薄的**：它把 GUI 内部状态暴露出去，仅此而已。
凡是能在 MCP 里做的，都是「读 GUI 内部状态」或「触发 GUI 已声明的动作」。

---

## 七、怎么接上去

这一节不锁实现，但**必须**说清楚，否则 agent 没法用。

### 7.1 传输

**定稿：HTTP 回环（127.0.0.1）+ 发现文件 + bearer token。**

MCP 标准传输有两种：stdio 和 HTTP（Streamable HTTP，取代了旧的 HTTP+SSE）。

| | 怎么用 | 为什么不用 |
|---|---|---|
| **stdio** | agent **启动** MCP server 子进程，通过管道说话 | agent 要启动的是「一个正在被用户使用的桌面应用」——别扭；而且 GUI 得能同时被 agent 和用户操作。**独立进程还违反「MCP 与 GUI 同进程」这条硬约束**（`docs/05` ADR-D2） |
| **HTTP（127.0.0.1）** | GUI 起一个本地端口，agent 连上去 | ✅ 采用。代价是端口与本机安全基线（见下） |

**理由**：GUI 本来就是一个用户会打开并一直开着的东西，
agent 是**连到已经在跑的 GUI**，而不是把它启动起来。
HTTP 回环让 MCP server 仍然住在 Electron main 进程内（ADR-D2 成立），
同时给 agent 一条「连过去」的路。

**本机安全基线**（契约的一部分，不是实现建议）：

| 项 | 要求 |
|---|---|
| 监听地址 | **只绑 `127.0.0.1`**，不绑 `0.0.0.0` |
| `Origin` 校验 | 对所有入站请求校验 `Origin`；**存在且不合法时返回 403** |
| `Host` 校验 | 只接受 `127.0.0.1:<port>` 与 `localhost:<port>` |
| 认证 | 每个请求必须带 `Authorization: Bearer <token>`，token 来自发现文件 |
| token | 每次 GUI 启动**重新生成**（随机 ≥ 32 字节）；不写进日志 |
| 发现文件权限 | 仅当前用户可读（POSIX 0600 / Windows 当前用户 ACL） |
| 无 CORS | 不发 `Access-Control-Allow-Origin`，不做跨域放行 |

> **为什么这几条是契约而不是实现建议**：本地 HTTP MCP server 若不校验 `Origin`/`Host`，
> 任何用户访问过的恶意网页都能通过 DNS rebinding 向 `127.0.0.1` 发请求，
> 直接驱动 `execute_action` 改用户的板子。MCP 规范对此有明确要求
> （「servers MUST validate the `Origin` header」），本产品把它当作**硬约束**写进契约。

**不锁的部分**：具体库、端口分配策略、SSE 或 Streamable HTTP 的具体变体，
由 `docs/04-架构设计.md` 决定。本契约只要求「agent 能发现并连上，且连上的一定是本机用户自己启动的那个 GUI」。

### 7.2 发现

agent 怎么知道端口和路径？

GUI 在本地写一个**发现文件**：

```
%LOCALAPPDATA%/DevBoardCockpit/mcp.json
{
  "apiVersion": "devboard/v1",
  "transport": "http",
  "host": "127.0.0.1",
  "port": 51234,
  "pid": 12345,
  "token": "<本次启动生成的 bearer token>",
  "cards_dir": "...",
  "started_at": "..."
}
```

agent 读这个文件就知道怎么连。这个文件是**唯一**的耦合点：
换了传输方式，agent 只需要改读文件的方式。

（另一种常见做法是固定端口 + 固定路径。固定端口在多开时会撞，发现文件没这个问题。）

**发现文件的规则**：

| 项 | 规则 |
|---|---|
| 写入时机 | GUI 启动并**成功监听端口之后** |
| 写入方式 | 先写临时文件再原子改名，避免 agent 读到半个文件 |
| 权限 | 仅当前用户可读 |
| 清理 | GUI 退出时删除；端口被占用时也要删（不能留一个指向死进程的发现文件） |
| 陈旧文件 | agent 连不上时**不重试其他端口**，直接报错——避免连到别的进程 |
| `pid` | 用于 agent 确认这个发现文件对应当前活着的 GUI |

> **token 为什么放在发现文件里**：发现文件本身就受权限保护（仅当前用户可读），
> 它同时承担「地址」与「凭据」两件事。token 每次启动重生成，
> 所以上次会话留下的 token 立刻失效。

### 7.3 谁可信

**agent 是可信主体，但受动作分级约束。**

- agent 可以读全部状态（`list_*`、`describe_*`、`sample_*`）。
- agent 可以写卡片（`install_card`）——这就是产品设计的目的。
- agent **不能**执行 `destructive` 动作而不经人确认（§2.4.1）。

「agent 能装任意卡片」这件事需要正视：装一张卡 = 在工作台里跑一段 HTML/JS。
所以卡片的沙箱是认真的（`03` §六 —— 含 CSP 与 `cockpit.storage.*`），
而 `destructive` 动作要人确认。

**agent 的可信是「在已授权范围内可信」**：agent 能读的板子状态 = 用户已经连上的板子；
agent 能执行的动作 = 已授权的动作；参数超出 `guard` 域的要另行确认（`02` §5.5）。
agent **不能**读用户的文件系统、不能改授权、不能连别的板子。

### 7.4 一次运行

```
用户：装一张卡，显示 NPU 占用率
agent: list_tags()                    → 看到 npu.usage 存在，status=unavailable
agent: describe_tag("npu.usage")      → 看到语义：「各核利用率的最大值」
agent: list_cards()                   → 看有没有现成的
agent: 写卡片文件
agent: validate_card(path)            → 静态检查通过
agent: install_card(path)             → 热插拔生效
agent: get_card_runtime_log(cardId)   → 无报错
用户：（屏幕上出现了那张卡）
```

这条回路里 agent 用了三个「列举/自省」工具才动手写——这就是为什么它们必须实时、
必须准。**能力是动态出现的，不能靠静态文档。**

