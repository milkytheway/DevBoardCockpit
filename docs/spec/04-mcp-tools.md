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
→ [{ id, label, transport, board_pack, connected, capabilities }]
```

`board_pack` 是当前这块板加载的包 id 与版本——agent 靠它知道「这块板是什么」。

#### `list_data_sources()`

```
→ [{ id, board, reader, kind, interval_ms, provides: ["cpu.usage", ...], status }]
```

`status` 是 reader 本身的状态（`ok` / `error` / `unavailable`）。

注意这返回的是 **reader 粒度**，不是 tag 粒度——因为「哪些 tag 可读」这个问题的答案天然按 reader 组织（一个 reader 挂了，它提供的 tag 全挂）。

#### `list_capabilities()`

```
→ { transports: [...], features: ["cards", "mcp", "layout_share", "record"] }
```

工作台自己有什么。给 agent 判断「这个功能有没有」。

#### `list_tags(board?)`

```
→ [{ name, type, unit, range, status, value, board, source_reader }]
```

**当前实际可读**的 tag，含实时状态。这是 agent 写卡时最该先调的一个。

区别于 `list_data_sources`：

- `list_data_sources` 问「有哪些数据源」
- `list_tags` 问「有哪些具体的量，现在什么值」

agent 要写一张 CPU 卡，第一个该调的是 `list_tags()`，因为它直接告诉 agent 有哪些 tag 名可用。

#### `describe_tag(name)`

```
→ { name, type, unit, range, semantics, status, value, board,
    source: { reader, kind, args_summary }, history: [...] }
```

`semantics` 是 tag 契约里的语义描述原文。**这是防误用的关键**——agent 看到 `npu.usage` 就该知道它是「各 NPU 核占用率的最大值」，而不是任何模糊的「NPU 负载」。

`source.args_summary` 让 agent 知道这个量是怎么来的（哪个文件、什么 kind），但**不暴露**具体命令（避免 agent 学着去发裸命令）。

#### `sample_tag(name, n)`

```
→ [{ value, unit, status, at }, ...]
```

取最近 n 个样本。给 agent 判断「这个量是稳定的还是抖动的」，以及「刷新周期实际是多少」。

---

### 2.2 查已有卡片

#### `list_cards()`

```
→ [{ id, name, version, path, installed_at, status, degraded, missing_tags }]
```

`degraded` / `missing_tags` 让 agent 知道这张卡在当前板上是不是残的。

#### `get_card_sdk_docs(topic?)`

```
→ { api_version, topics: [...], content }
```

写卡片时的语法参考：manifest 格式、可用 API、白名单方法、示例卡片。

`topic` 可选：`"manifest"` / `"api"` / `"examples"` / `"layout"`。省略则返回全部。

**注意**：这是**语法**参考，不是**现状**参考。现状永远用 `list_*` 拿。

---

### 2.3 写卡片与自测

#### `validate_card(path)`

```
→ { ok, errors: [...], warnings: [...], resolved: { tags, actions, layout } }
```

静态校验，**不安装**。校验规则见 `03-card-manifest.md` §八。

`resolved` 告诉 agent：这张卡实际会绑到哪些 tag 和动作，哪些会缺失。

#### `get_card_runtime_log(cardId, since?)`

```
→ [{ level, at, message, source }]
```

卡片运行时的错误。`level` ∈ `error` / `warn` / `info`。

卡片崩了、tag 读失败了、action 回读不匹配了，都在这里。

#### `install_card(path)`

```
→ { card_id, installed: true, degraded: bool, missing: [...] }
```

把卡片目录放进卡片根目录，触发热重载。

**agent 的标准回路**：

```
validate_card(path) → 改 → validate_card(path) → install_card(path)
    → get_card_runtime_log(cardId) → 看错 → 改 → install_card(path) → …
```

`install_card` 是幂等的：同一个 id 重复安装是**替换**，不是新增。

#### `uninstall_card(cardId)`

```
→ { ok }
```

---

### 2.4 执行动作

#### `execute_action(actionId, params, dry_run)`

```
→ {
    ok: true,
    readback: { value, unit, status, at },
    audit_id: "...",
  }
```

或失败时：

```
→ {
    ok: false,
    reason: "readback_mismatch" | "denied" | "not_found" | "needs_confirmation" | "timeout",
    expected: true, actual: false,
  }
```

**参数**：

| 参数 | 含义 |
|---|---|
| `actionId` | 板型包里声明的动作 id（不是卡片 id） |
| `params` | 按动作声明的参数 |
| `dry_run` | 只返回「将会执行什么」，不执行 |

**为什么要按动作 id 而不是卡片 id**：动作是板子的能力，卡片只是引用者。同一张卡可以调多个动作，同一个动作也可以被多张卡调。按动作 id 授权更精确（授权的是「改背光」这件事，不是「这张卡」）。

**行为**：

1. 查动作在当前板型包里存在吗 → 否则 `not_found`
2. 查调用方（agent）对它的授权 → 否则 `denied`
3. `danger: destructive` 且未获确认 → `needs_confirmation`
4. `dry_run: true` → 返回将要执行的命令 + 参数，**不执行**
5. 执行
6. 回读 → 返回 `readback`
7. 写审计日志

#### `confirm_action(actionId, params)`

对 `destructive` 动作的一次性确认，token 由 `execute_action` 的 `needs_confirmation` 返回。

---

### 2.5 布局

#### `promote_card(cardId)`

```
→ { ok, mode: "fullscreen" }
```

把卡片提为全屏。交互上终端这类东西必须能独占（`htop` 在小卡里没法用），但契约上它仍是一张卡。

#### `set_layout(layout)`

```
→ { ok }
```

保存布局。

#### `get_layout()`

```
→ { cards: [{ card_id, x, y, w, h }] }
```

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
| 时间 | 毫秒时间戳，UTC |
| 路径 | 绝对路径 |
| 版本 | `api_version` 字段在每个响应里都带上 |

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
| 不做文件 IO | agent 直接写文件更快 |
| 不做通用 shell | 见 §1.3 |
| 不存 agent 的状态 | 每次调用自带上下文 |
| 不猜 agent 的意图 | 显式参数 + dry-run |

MCP server 应该是**薄的**：它把 GUI 内部状态暴露出去，仅此而已。
凡是能在 MCP 里做的，都是「读 GUI 内部状态」或「触发 GUI 已声明的动作」。

---

> **迁入说明**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex）。
> 它是**语言中立的契约层**，正文未改动，是本工程的权威契约。
> 外壳与实现层的落地方式见 `docs/04-架构设计.md`。