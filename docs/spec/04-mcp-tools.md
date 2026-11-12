> **迁入说明**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex）。
> 契约层为**权威文档**，正文未改动。落地方式见 `docs/04-架构设计.md`。
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
→ [{ id, board, poll_group, reader, kind, interval_ms,
     provides: ["cpu.usage", ...], status }]
```

`status` 是 reader 本身的状态，取值与 tag 状态**同一套**：`ok` / `stale` /
`unavailable` / `error` / `pending`。

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

**如果这张卡需要新的授权**，`install_card` **不会**直接装上，而是返回：

```
→ { card_id, installed: false, needs_consent: true,
    consent_id: "c-123",
    pending: [
      { action: "backlight.set", danger: "reversible", label: "设置背光亮度" },
      { action: "system.reboot", danger: "destructive", label: "重启板子" }
    ] }
```

**这不会让 agent 的回路卡死。** 流程是：

1. agent 调 `install_card` → 拿到 `consent_id` 和待授权动作清单
2. **GUI 弹出确认框**，列出这些动作，让用户逐个批准或拒绝
3. 用户点完，GUI 把结果写进授权存储
4. agent 再调一次 `install_card`（同一个 path）→ 这次装上了

也就是说：**用户交互发生在 GUI 里，agent 只是重试。** agent 不需要弹窗，也不需要
自己去问用户「你可以吗」——它把请求递出去，然后重试。

第 2 步用户点完之后，agent 的下一次 `install_card` 会成功。如果用户拒绝了全部，
`install_card` 返回 `installed: false, denied: [...]`，agent 就知道这条路走不通。

**和文件监听的分工**：两条路都通，但作用不同。

| | 用途 | 语义 |
|---|---|---|
| **直接写文件** | agent 改一张**已装**的卡 | 触发热重载。**manifest 的 `permissions.write` 变了就要重新征求授权**（见 `03` §3.3） |
| **`install_card`** | 装一张**新**卡，或从别处拷进来 | 等价于「复制目录 + 重载」，幂等：同一个 id 重复安装是**替换** |

如果 agent 用 `install_card` 装一张已经装过的、但 `permissions.write` 不同的卡，
**同样要重新征求授权**。两条路在授权上没有区别——否则「换个方式就绕过授权」了。

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
    reason: "readback_mismatch" | "denied" | "not_found"
          | "needs_confirmation" | "timeout" | "invalid_params" | "failed",
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
2. 查调用方的授权 → 否则 `denied`
3. 校验参数（范围、枚举）→ 否则 `invalid_params`
4. `danger: destructive` 且未获确认 → `needs_confirmation`
5. `dry_run: true` → 返回将要执行的命令 + 参数，**不执行**
6. 执行 → 失败则 `failed`（命令非零退出）
7. 回读 → 不符则 `readback_mismatch`
8. 写审计日志

**`not_found` 与 `denied` 的顺序**：先查存在性，再查授权。这样一个未授权的调用方能知道
「这个动作存在」，但**不能知道它会做什么**——动作的 `command` 只在通过授权后才返回。
这条顺序是有意的：它让「板子上有没有这个能力」是可发现的，而「这个能力怎么实现」不是。

#### 2.4.1 agent 的授权

**agent 不是卡片，它有一套自己的授权。**

卡片授权是「装卡时按动作问一次」，agent 授权是另一回事：agent 可以直接调任何动作，
不需要先装一张卡。

规则：

| 档 | agent 怎么做 |
|---|---|
| `reversible` | agent 直接可以执行，**记审计日志** |
| `destructive` | **必须有人在 GUI 里点确认**。agent 提交请求，然后等 |

**破坏性动作的确认需要人。** agent 不能自己造确认凭据。

流程：

1. agent 调 `execute_action(actionId, params)`，动作是 `destructive`
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

**agent 不能做的事**：agent 不能改授权本身。它不能给自己提权，
也不能修改任何卡片的授权。它只能执行已声明的动作。

#### 2.4.2 板型包的信任

**包一律生效。** 不管这个包是用户写的、内置的，还是 agent 写的。

agent 可以写板型包扩展（见 §1.3），写完直接用，不需要用户批准。

**为什么这样选**：这个产品的核心价值就是「AI 照着手册批量制造仪表和开关」。
如果 agent 写的每一张卡、每一个包都要人批准，协作回路就断了——
agent 的价值恰恰在于它能自己往前跑。

**那危险等级怎么办**：靠**地板**（`02-board-pack.md` §5.2）。

包自己声明 `danger`，但有一张固定的操作模式表属于契约：
`reboot`、`mkfs`、`dd` 到块设备、`flash`……这些命令**永远**按 `destructive` 处理，
不管包怎么声明。

所以 agent 确实被信任了，但它**不能自己把「重启板子」降级成可逆动作**。
被信任的是「agent 可以自己写东西」，不是「agent 可以绕过人的确认」。

（这条张力是真实的：如果完全不管，agent 写一个 `danger: reversible` 的 reboot 动作，
分档就没意义了。地板是让这两个意图同时成立的最小机制。）

#### `confirm_action(actionId, params)`

```
→ { confirm_id: "...", expires_at: 1762910060 }
```

请求对 `destructive` 动作的一次确认。

**注意**：这个工具**不返回可直接使用的凭据**——它只是把请求递到 GUI 的确认队列，
并给 agent 一个 `confirm_id`。真正的确认要等**人**点了之后，`confirm_id` 才有效。
没有人点，`confirm_id` 永远无效。

`execute_action` 带 `confirm_id` 重试时，若用户已点确认则执行，否则仍返回
`needs_confirmation`。

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

MCP 标准传输有两种：stdio 和 HTTP/SSE。

| | 怎么用 | 问题 |
|---|---|---|
| **stdio** | agent **启动** MCP server 子进程，通过管道说话 | 一个正在被用户使用的桌面应用，让 agent 去启动它，很别扭；而且 GUI 得能同时被 agent 和用户操作 |
| **HTTP（127.0.0.1）** | GUI 起一个本地端口，agent 连上去 | 需要一个端口；Windows 上第一次可能弹防火墙 |

**倾向 HTTP + 本地端口**，理由：GUI 本来就是一个用户会打开并一直开着的东西，
agent 是**连到已经在跑的 GUI**，而不是把它启动起来。

**具体形态由 `docs/04-架构设计.md` 决定**，本契约只要求「agent 能发现并连上」。

### 7.2 发现

agent 怎么知道端口和路径？

GUI 在本地写一个**发现文件**：

```
%LOCALAPPDATA%/DevBoardCockpit/mcp.json
{
  "version": "devboard/v1",
  "transport": "http",
  "host": "127.0.0.1",
  "port": 51234,
  "pid": 12345,
  "cards_dir": "...",
  "started_at": "..."
}
```

agent 读这个文件就知道怎么连。这个文件是**唯一**的耦合点：
换了传输方式，agent 只需要改读文件的方式。

（另一种常见做法是固定端口 + 固定路径。固定端口在多开时会撞，发现文件没这个问题。）

### 7.3 谁可信

**agent 是可信主体，但受动作分级约束。**

- agent 可以读全部状态（`list_*`、`describe_*`、`sample_*`）。
- agent 可以写卡片（`install_card`）——这就是产品设计的目的。
- agent **不能**执行 `destructive` 动作而不经人确认（§2.4.1）。

「agent 能装任意卡片」这件事需要正视：装一张卡 = 在工作台里跑一段 HTML/JS。
所以卡片的沙箱是认真的（`03` §六），而 `destructive` 动作要人确认。

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

