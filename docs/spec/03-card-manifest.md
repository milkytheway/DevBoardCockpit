> **迁入说明**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex）。
> 契约层为**权威文档**，正文未改动。落地方式见 `docs/04-架构设计.md`。
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
| `requires.actions` | 否 | 这张卡**想**触发��动作 |
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

沿用板型包那三档，卡片侧只声明「我要用哪一档的动作」：

```json
"permissions": {
  "read": ["cpu.usage"],
  "write": ["backlight.set"]
}
```

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

`target` 是板型包里的动作 id。

**卡片不声明 `danger`。** 危险等级由**板型包**说了算——板子知道「重启自己是破坏性的」，
卡片不知道。卡片的 `danger` 字段如果存在，会被校验器拒绝（schema 封闭，§2.5）。

同样，卡片不声明 `readback`——回读由板型包的动作定义，运行时按板型包的来。
卡片声明自己的 `readback` 会和板型包冲突，而**板型包赢**，因为它是离板子最近的那一层。

### 5.2 闭环的四步

卡片里的开关按钮，完整流程：

```
用户点击
   ↓
卡片调 cockpit.actions.invoke("toggle-npu", {enabled: true})
   ↓
运行时检查：① 该动作在 permissions.write 里吗？
           ② 该动作的 danger 等级需要二次确认吗？
           ③ 板型包里这个动作存在吗？
   ↓
执行命令 → 回读 readback.tag
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

| | 板型动作（board pack） | 视图内动作（card manifest） |
|---|---|---|
| 是什么 | 板子接受的一次写入 | 卡片内部的一次操作 |
| 在哪声明 | `board.yaml` | `manifest.json` |
| 例 | `backlight.set` | `toggle-npu`（引用上面那个） |
| 权限 | 需要授权 | 不需要（不碰板子） |

视图内动作是**卡片自己的 UI 语义**，比如切换一张图表的显示模式。它不碰板子，所以不走授权。

---

## 六、沙箱

卡片跑在 iframe 里。

| 规则 | 内容 |
|---|---|
| 位置 | 独立 iframe，`sandbox` 属性 |
| API | 只有 `cockpit.*` 白名单方法 |
| 网络 | **默认禁，且 v1 无法申请**。要联网必须升契约版本 |
| 存储 | 只能写卡片自己的命名空间（布局、偏好） |
| 文件 | 不可读写宿主机文件系统（除布局存储的受控接口） |
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
| 7 | `actions[].target` 在 `permissions.write` 里 |
| 8 | `layout.w/h` 在合法范围，`min_w/min_h` ≤ `w/h` |
| 9 | `entry` 文件存在 |
| 10 | manifest 是合法 JSON，**每一层都没有未知字段**（防止拼错字段被忽略，§2.5） |
| 11 | 卡片**不声明** `danger` / `readback`（那两样归板型包管，§5.1） |

