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

### `requires` 与 `permissions` 的区别

这两个字段容易混，分清了很重要：

- `requires` 是**愿望**。声明「我想读 cpu.usage」。板子没有 → 降级，缺失项被列出来。
- `permissions` 是**授权**。声明「我被允许读 cpu.usage」。运行时**只允许**这个列表里的。

愿望可以超出现实，授权不可以。两者不一致时（requires 里有、permissions 里没有）视为**配置错误**，校验器拦下。

---

## 三、权限模型

### 3.1 为什么是两层

卡片跑在沙箱里（iframe + 白名单 API），但「沙箱」只保证卡片**搞不垮工作台**，不保证卡片**不会乱动板子**。

两件事必须分开：

| 防护 | 防的是什么 | 手段 |
|---|---|---|
| 代码沙箱 | 坏卡搞垮工作台、偷读宿主机文件 | iframe + 白名单 API + 无 Node 集成 |
| 动作权限 | 卡片乱写板子 | `permissions.write` + 三档分级 + 安装时授权 |

一张卡能读 `cpu.usage` 是**读**，不危险。能写 `/sys/...` 是**写**，要授权。读权限用 tag 名声明，写权限用动作 id 声明——动作 id 比 tag 名更粗，所以写权限天然更严格。

### 3.2 三档分级

沿用板型包那三档，卡片侧只声明「我要用哪一档的动作」：

```json
"permissions": {
  "read": ["cpu.usage"],
  "write": ["backlight.set"]
}
```

授权流程：

1. 安装卡片时，扫描 `permissions.write` 里每个动作，取它在新板型包里的 `danger` 等级。
2. `readonly` → 直接放行。
3. `reversible` → 问一次「这张卡可以改背光亮度，允许吗」，记住选择。
4. `destructive` → 问一次，**且每次执行都要二次确认**。

授权是**按动作**的。装一张卡不等于装上它所有动作的权限；用户可以只允许其中一部分。

授权记录存在本地，绑定 `(卡片 id, 动作 id, 板型包 id)`。换一块板（不同 pack）要重新授权——因为新板上的同名动作可能语义不同。

### 3.3 卡片不能自己提权

卡片**不能**在运行时请求新权限。权限只在安装时确定。卡片想要更多，只能提示用户重新安装（带新 manifest）。

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
    "danger": "reversible",
    "params": { "enabled": { "type": "boolean" } },
    "readback": { "tag": "custom.rk3588-atk.pipeline.running" }
  }
]
```

`target` 是板型包里的动作 id。

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
| 网络 | 默认禁；要联网必须 manifest 显式申请，单独授权 |
| 存储 | 只能写卡片自己的命名空间（布局、偏好） |
| 文件 | 不可读写宿主机文件系统（除布局存储的受控接口） |
| 崩溃 | 单卡崩溃不影响其他卡，也不影响工作台 |

manifest 里没有 `permissions.network` 之类的字段——**没声明就是没有**。要加能力必须改 manifest 并重新安装，走一次授权。

---

## 七、目录布局

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

## 八、校验清单

`validate_card(path)` 必须检查：

| # | 规则 |
|---|---|
| 1 | `apiVersion` 是已知版本 |
| 2 | `id` 全局唯一，不与已装卡片冲突 |
| 3 | `requires` ⊆ `permissions`（愿望不得超出授权） |
| 4 | `permissions.read` 里每个 tag 名**匹配核心词表**或落在 `custom.*` 下 |
| 5 | `permissions.write` 里每个动作 id 在**当前连接的板型包**里存在（连不上板时跳过此检查，标注「未验证」） |
| 6 | `actions[].target` 在 `permissions.write` 里 |
| 7 | `actions[].readback.tag` 在 `permissions.read` 里 |
| 8 | `layout.w/h` 在合法范围，`min_w/min_h` ≤ `w/h` |
| 9 | `entry` 文件存在 |
| 10 | manifest 是合法 JSON，没有未知顶层字段（防止拼错字段被忽略） |

---

> **迁入说明**：本文自前身工程 `DevBoardConsole\docs\spec\` 迁入（2026-11-12，Codex）。
> 它是**语言中立的契约层**，正文未改动，是本工程的权威契约。
> 外壳与实现层的落地方式见 `docs/04-架构设计.md`。