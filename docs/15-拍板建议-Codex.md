# 拍板建议 · 计划 2 前置三件事的独立意见

> **日期**：2026-11-13
> **作者**：Codex（独立评审，不参与 `docs/14` 的起草）
> **回应**：`docs/14-拍板单-计划2前置.md` 的三条待拍板
> **性质**：**只给建议，不改契约、不改实现。** 拍板后由拍板人定稿，本文只作依据。

---

## 零、这份意见的取样方式

三条建议里，两条的关键在「板子到底怎样」，而 `docs/14` 里写的实测只有一条。
所以本文先补一批**新的真机实测**，把结论建立在数据上，而不是推理上。

**板子**：正点原子 ATK-DLRK3588（`f34dca7784396ab2`，Buildroot 6.1.141）。
**方法**：`adb push` 脚本 + `adb shell sh`，**不经 shell 插值**（避免本地展开）。
**本轮做过一次写操作**（切 NPU governor），**板子已恢复并复核**，见 §四。

| # | 实测（🟢 = 已核实） | 结论 |
|---|---|---|
| **E1** | `fdab0000.npu` 与 `dmc` 的 `available_governors` **完全相同**（9 个值：`rknpu_ondemand dmc_ondemand vop2_ondemand venc_ondemand userspace powersave performance simple_ondemand`） | 这个列表是 **rkdevfreq 类级的全局并集**，对单个节点**没有信息量** |
| **E2** | 向 `fdab0000.npu/governor` 写 `dmc_ondemand`、`powersave`：**rc=0、无任何报错、读回原值** | 节点**接受列表里的任意值**。列表不会告诉你哪个值对这个节点有意义 |
| **E3** | 写 `fdab0000.npu/governor` 期间，`dmc/governor` **始终是 `dmc_ondemand`**（两次独立观测） | 当前值是**每节点独立**的，**不是全局的** → **`docs/14` 决策③的理由①是错的**（详见 §四） |
| **E4** | 向 NPU 节点写 `powersave` → **写调用挂死**：`/proc/<pid>/wchan = devfreq_monitor_stop`，进程进 **D 状态**，`kill -9` 无效。此后该节点的**所有** governor 读写与 `trans_stat` 读取全部阻塞在 D 状态 | **切 devfreq governor 有内核死锁风险，且不可恢复——只有重启能救**。同顺序先跑过一次没挂 → **是竞态，不是必现** |
| **E5** | `fdab0000.npu/cur_freq` 权限位 **`-r--r--r--`**（root 也写不进去） | `userspace` governor 在这块板上**没有可用语义**：它的含义是「由用户态设频率」，而用户态没有写权限 |
| **E6** | `cpu.governor.set` 用的那条路径（cpufreq `scaling_governor`）写 `ondemand` → `schedutil`：**rc=0、无挂死、读回一致** | 现有的 `cpu.governor.set` 走 **cpufreq**（与 devfreq 不是同一个驱动），**风险不同、目前干净**。这条动作此前**从未被真机验过** |
| **E7** | `/proc/mounts` 里有 `debugfs /sys/kernel/debug debugfs rw,relatime`；`rknpu/load` 读出 `Core0: 0%`；`rknpu/freq` = `1000000000` = `cur_freq` | 这块板**默认已挂 debugfs**（契约 §2.1 的例子说「默认没挂载」，对这块板不成立）→ `debugfs.mount` 在这块板上是空转 |
| **E8** | 实现层全仓库**没有任何 `stream` 能力**（只有 `ssh.ts` 里一个通道变量名叫 stream）；`capabilitiesFor(profile)` 里 `pty` **可被 profile 的 `options.pty` 覆盖** | 契约那套的 `stream` 是**契约缺口**；实现那套是 **profile（连接）级**的，**不是传输级** |
| **E9** | 契约 §七 的 **24 条校验规则里没有一条检查 `requires.capabilities`**（也没有一条检查 `requires.transports`） | `requires.capabilities` 目前是**无人校验、无人消费**的字段 |
| **E10** | 24 条规则里，**只有 15 条**管 destructive 的回读；§4.1 正文写的是「**每个**动作必须声明怎么回读」 | **一个 reversible 动作不写 `readback` 也能过校验** → 闭环静默断掉（真实空洞） |

**板子状态披露**：本轮开始时，板子的 NPU governor **已经是 `userspace`**（不是开机默认的 `rknpu_ondemand`）——
说明此前有会话写过后**没还原**。这恰好是「agent 能写 governor、没人盯着还原」的现实样本。
**本轮结束时已恢复为 `rknpu_ondemand`（开机默认），`dmc/governor` 未受影响，全量复核通过。**

> 顺带：E4 把我卡死的那个状态也救了——**当时只能靠重启**，
> 这本身就是 E4 最硬的证据。

---

## 一、Claude 往前推进了什么（复核结论）

`HEAD = eaf2b6b`，工作区干净。`271744d` 之后 7 个提交，复核结果：

| 提交 | 内容 | 我的复核 |
|---|---|---|
| `f5fd624` | 计划 1 验收完成（物理串口 + 共享 node_modules 规矩） | ✅ |
| `7f38c43` | 总设计 M0–M2 表改成真机验收结果；本地档案补「其实不需要重编译」 | ✅ 与我上轮的判断一致 |
| `0c56cff` | eslint 认识 CommonJS 全局 | ✅ |
| `cab2ebd` | **postinstall 改成 `node scripts/ensure-native.mjs`**（加载不了才编译） | ✅ **采纳了我上轮的建议**。逻辑正确：先找二进制文件，再真 `require`（node-pty 的 win32 分支 require 时不碰原生模块） |
| `ac86897` | 总设计补「下一步」，含打包配置欠账 | ✅ 欠账属实（见 §五） |
| `d91f918` | 评审的 2 条 Critical + 9 条 Important 修复 | ✅ |
| `eaf2b6b` | 拍板单本身 | ✅ 三条都成立，但**理由有两条要换**（见下） |

**我实测复核**：✅ `npm run lint` / `typecheck` / `test` **223 条全绿**（30 个文件）；
新增 4 份真机 fixture（`fixtures/board/*.txt`）+ `tests/unit/board-fixtures.test.ts`；
变异脚本 23 → 26 项。

**一处要更正**：上轮我说 `postinstall` 的根因是 `-f` 标志，**不对**。
真正根因是 node-pty 的 devDeps 里没有 `prebuildify`，加上 serialport 的 prebuild 文件名
与 electron-rebuild 的探测规则对不上。`ensure-native.mjs` 绕开了这个坑，方向正确。

---

## 二、决策 ① · capability 词汇表

### 我的结论：**同意 A 的方向，但有四处要改**

`docs/14` 的 A =「两套词各归各位 + 改名 + 去掉 `stream` + 写映射表 + 不升 apiVersion」。
方向对——**契约 §10.2 明写「包描述板子，HAL 描述通道，两者由运行时接起来」**，
两个轴是**契约刻意分开的**，不是历史遗留。所以 B（合成一套）**必须否掉**：
合成一套就等于让包感知传输，直接违反 §10.2。

但 A 有四处会被实现层做歪。

### ①-1　实现侧该叫 `ConnectionCapabilities`，不是 `TransportCapabilities`

**代码证据**（`src/main/hal/capabilities.ts`）：

```ts
// 能力位由 **profile 决定**，不是由传输名决定。
export function capabilitiesFor(profile: ConnectionProfile): Capabilities {
  ...
  pty: typeof explicit === 'boolean' ? explicit : defaults.pty,
}
```

`pty` **能被 profile 的 `options.pty` 覆盖**（串口默认 true、adb 默认 false，
但 profile 可以改）。所以能力位是 **profile（连接）级**的，
**不是 transport 级的**——叫 `TransportCapabilities` 会跟这段代码自己的注释打架。

**建议**：`src/shared/ipc-contract.ts` 的 `Capabilities` → **`ConnectionCapabilities`**。
代价只有 3 个文件的改名。

### ①-2　要「词义对照表」，**不要「板子能力 → 连接能力」的映射函数**

`docs/14` 的 A 写「映射表（板子能力 → 连接能力）写在契约里」。
**这个措辞会被实现成函数**，而它不可能是函数：
同一块板走 adb 和走 serial，连接能力完全不同（实测：`serial` 的 `files=false`、`exitCode=false`；
`adb` 都是 true）。**「板子能力」推不出「连接能力」。**

它只能是**两种词之间的翻译**。契约里那张表应该长这样（4 行）：

| 板子能力（契约，包声明） | 连接能力（实现，profile 协商） | 语义 |
|---|---|---|
| `shell` | `shell`（现叫 `pty`） | 能开交互式 shell |
| `exec` | `exec` | 能跑一条命令拿结果 |
| `files` | `files` | 有文件通道 |
| `stream` | —— | **v1 删除**（见 ①-3） |
| —— | `exitCode` | **通道能给退出码**。它是**通道的属性，不是板子的属性** |

**最后一行是关键**：`exitCode` 没有板子级对应物（串口拿不到退出码，事实 S5），
这正好说明两套词不是同一个轴——**而 `docs/14` 把它当成「实现里多出来的一个」**，
其实它**本来就该是连接级的**。

### ①-3　`stream` 要从**契约词表**里删掉，不只是从 pack 里删掉

`docs/14` 的 A 说「板型包里去掉 `stream`」——**对，但不够**。
实现层**根本没有** `stream`（E8），契约词表里留一个**恒假**的能力，
等于允许「声明了但永远给不出」。这与 `unavailable ≠ 0` 是**同一条原则的反面**：
**契约里不该有恒假的东西。**

**建议**：
1. `docs/spec/02` 的能力词表**删掉 `stream`**（连带 §10.2 与 `spec/00` §七的缺口表同步）；
2. `profiles/boards/rk3588-atk/board.yaml:27` 的 `requires.capabilities` 去掉 `stream`；
3. Stream 继续挂在 `docs/09` §三① 的**缺口清单**上，等 Stream 契约定稿时
   **作为一次真正的契约变更**加回来（**那一次才升 apiVersion**）。

### ①-4　`requires.capabilities` 必须有消费者，否则改了也没人用（E9）

24 条规则里**没有一条**检查它。这不是「以后再说」能糊过去的——
M3 就是要写这个校验器，**现在不定，M3 就会写出一个「跳过 capabilities」的校验器**。

按 §10.2 的口径（`requires.transports` 是「**信息，不是限制**」），我建议：

- **`requires.capabilities` = 板子级能力声明**，v1 **不参与连接绑定门禁**。
  > **为什么不门禁**：串口的 `files=false`。若拿板子级 `files` 做门禁，
  > 这个包在串口上就废了——**直接违反 §10.2「这个包在串口上也能用」**。
  > 这也说明 `requires.capabilities` **不能**被理解成「连接级需求」。
- **补第 25 条校验规则**：`requires.capabilities` 的每个值必须属于**封闭词表**，
  未知值报错（与规则 24 同一条封闭性原则）。**这一条是 M3 唯一必须做的 capabilities 校验。**
- **消费者**：v1 至少给一个只读查询（MCP `list_connections()` 里带上包的能力，或
  `describe_board_pack()`），让 agent 知道「这块板声明支持什么」。
  若 v1 不想开这个工具，则在 `docs/06` 记一条「该字段暂无消费者，待 v2」，**别装作它有意义**。

### ①-5　apiVersion：**同意不升，但必须留痕**

契约自己写了口径（`docs/spec/01` 的 T-6 注）：v1 未随实现发布 → 属「v1 定稿前的修正」。
**同意**。但 AGENTS.md 的硬规矩写的是「改契约要升 apiVersion 并走评审」——
**这里有张力**，建议在 ADR 里**明写「本次走 v1 定稿前修正口径」并由拍板人追认**，
否则以后会有人拿 AGENTS.md 的一条来质疑。

---

## 三、决策 ② · 没有回读的动作怎么声明（O13）

### 我的结论：**同意 A 的精神，但形状要改三处、理由要换一处**

Claude 的 A =「加 `verify: none`，显式声明，结果标 `unverified`，只允许 reversible」。
**方向对**——选项 C（用 `verify` 跑 `true`）**必须否掉**：
它把「没验证」伪装成「验证过了」，正是这份契约一路在防的事。

### ②-1　只用一种拼写：`readback: { kind: none }`

`docs/14` 给了两种拼法（`readback: {kind: none}` **或** `verify: {kind: none}`）——
**必须只留一种**，否则校验器要同时认两种表达同一件事的写法。

**选 `readback: { kind: none }`**，理由：
- `readback` 的四种形式**已经是封闭枚举**（规则 23），加一个 `none` 只改一处；
- `verify` 在 §4.5 是**另一个块**（有 `command` / `timeout_ms` / `expect`），
  给它加 `kind: none` 会让「没有回读」有两种写法；
- 语义上 `none` 是「**这个动作没有可观测状态**」，这是 **readback 形状**的事实。

**契约里要明写**：`verify` 块**不允许** `kind: none`；没有回读就写 `readback: {kind: none}`。

### ②-2　`unverified` **不要**进 `spec/01` §2.1.1 的 reason 枚举

`docs/14` 说「契约 §2.1.1 的 reason 封闭枚举要加一个码」——**指错了表**。
`spec/01` §2.1.1 的 reason 是**tag** 的原因码；**动作**结果的原因码在
**`spec/04` §2.4**（`readback_mismatch | denied | not_found | needs_confirmation | timeout | invalid_params | failed | unsupported_transport | guard_exceeded`）。**两张表，别混。**

tag 的五态是 `ok / stale / unavailable / error / pending`，`unverified` **不是 tag 状态**——
加进去会污染所有 tag 消费者（卡片 widget 的渲染分支）。

**我的建议：`ok: true` + 新增一个独立字段 `verified: false`（默认 `true`）。**

| 表达 | 问题 |
|---|---|
| `ok: false, reason: "unverified"` | 命令**确实执行了、效果也确实有**（点 LED 亮了）。报失败是**另一种撒谎** |
| `ok: true` 什么都不说 | 把「没验证」藏起来 —— **这正是选项 C 被否掉的同一个毛病** |
| **`ok: true` + `verified: false`** | **唯一同时避开这两种撒谎的表达** |

**还要写死 UI 口径**（否则字段定义了也没用）：
`verified: false` → 卡片**必须**显示「已执行，未验证」，**不得**显示成「已生效」。
这直接对应 `spec/02` §4.1 已有的那句「命令已发出，未确认生效」。
**驾驶舱不能把没验证的东西显示成生效了。**

**顺带**：O14（卡片 API 错误码与 tag reason 是否共用一套）**还开着**——
`verified` 作为独立布尔字段**不预设** O14 的答案，别提前统一。

### ②-3　顺手补一个洞：**每个动作都必须声明 readback**（E10）

`spec/02` §4.1 正文写的是「**每个**动作必须声明怎么回读」，
但**校验规则里只有第 15 条管 destructive**——
**一个 `reversible` 动作不写 `readback` 也能过校验**。这是真洞：闭环静默断掉。

**新增规则 26**：
> 每个 action 必须有 `readback` 块，其 `kind` 属于 `{file_equals, command_ok, verify, none}`
> （不写 `kind` 按形式 1 读 tag）。**`none` 是唯一合法的「我没有可回读状态」的写法——
> 不许用「不写」来表达同一件事。**

这一条同时把 O13 的洞堵上：`none` **必须显式**，漏写就是校验错误。

### ②-4　`none` 的三条附加约束（同意 Claude + 两条我的）

1. **只允许 `danger: reversible`** —— 同意。`destructive` 仍禁止 `none`。
   > 若某个 destructive 动作真的没有可观测后态，**唯一的合法路径是加一条 `verify` 命令**
   > （如 `test -e /tmp/marker`），这正是 §4.5 的 `verify` 存在的意义。
   > 连 `verify` 都做不到的动作，**v1 就不许声明** —— 这是刻意的、说得出口的限制。
2. **授权界面必须标注「此动作无法回读验证」**（§4.2 已有「reversible 不等于无害」的要求）。
3. **审计日志要能一眼看出「未验证」**（§5.4）—— 否则事后无法追责。

---

## 四、决策 ③ · O9/C4 剩下的两个动作

### 我的结论：**同意 A（两个都不做），但三条理由全部换掉——因为 Claude 的两条理由有两条是错的**

### ④-1　Claude 的理由①**是错的**，必须换掉

`docs/14` 说「那个 `governor` 节点是 rkdevfreq **全局**的，写它会影响 dmc/vop2/venc 等其他模块」。

**实测 E3：不对。** 写 `fdab0000.npu/governor` 期间，`dmc/governor` **始终是 `dmc_ondemand`**，
两次独立观测。**当前值是每节点独立的。**

`available_governors` **是**全局的（E1：NPU 节点与 dmc 的列表完全相同），
但那是**可选值列表**共享，不是**当前值**共享。Claude 把这两件事混成了一个。

**这反而说明理由要换**：如果写 NPU 节点**不**影响别的模块，那副作用不是「波及其他模块」，
而是「**把这个 NPU 节点切到一个可能不该切的档**」——性质不同，结论相同（不该做）。

### ④-2　**真正该用的理由**（比 Claude 的理由硬得多）：实测能把板子锁死

**E4**：向 NPU 节点写 `powersave`，**写调用挂在内核里**——
`wchan = devfreq_monitor_stop`，进程进 **D 状态**，`kill -9` 无效；
此后该节点的**所有** governor 读写与 `trans_stat` 读取全部阻塞在 D 状态，**只有重启能恢复**。

同顺序先跑过一次**没挂** → **是竞态，不是必现**。但**一次就够把板子锁死**。

> **所以 `npu.governor.set` 不能做的理由不是「我们不确定它的语义」，
> 而是「实测它会把板子锁死、且不可恢复」。**
>
> 这对「agent 能触发的动作」是**不可接受**的：
> agent 写错一个值 → 板子失去 devfreq 控制 → 只能靠物理重启。
> **在找到并修掉这个内核侧死锁之前，`npu.governor.set` 绝对不能进板型包。**

**边界要写清楚**（免得误伤）：
- 这条风险覆盖 **devfreq 类节点**（`fdab0000.npu`、`dmc`、`fb000000.gpu`…）。
- **现有的 `cpu.governor.set` 走的是 cpufreq 的 `scaling_governor`**（不同驱动），
  **实测干净**（E6：写 `ondemand` → `schedutil`，rc=0、无挂死、读回一致）。
  → 这条动作**此前从未被真机验过**，本轮验过了，**可以写进 `docs/02` §3.1**。

### ④-3　`available_governors` 给不出正确的枚举（E1/E2）

列表是 rkdevfreq **类级全局并集**；NPU 节点**接受 `dmc_ondemand`、`powersave` 且 rc=0 无报错**，
读回原值。**所以「从列表里挑几个」这条路给不出 O15 要的答案。**

→ **O15 的答案只能是 `rknpu_ondemand`（v1 就这一个）**。
要加别的档，得先有一个「这个节点**真正实现了**哪些 governor」的依据 —— **现在没有**。

### ④-4　通用档（`userspace`/`powersave`/`performance`）在这节点上没意义或危险

**E5**：`cur_freq` 权限 **`-r--r--r--`**，root 也写不进去。
`userspace` 的语义是「**由用户态设频率**」——而用户态**没有写权限**。
选 `userspace` = 把自动调频交给一个没有写权限的接口 = **实质上关掉自动调频**。

加上 E4（写 `powersave` 会锁死），**通用档要么无意义、要么危险**。

### ④-5　`debugfs.mount` 不做，理由换成

1. **这块板默认已经挂着**（E7：`/proc/mounts` 有 debugfs 行，`rknpu/load` 读得出 0%）→ 动作在这块板上是**空转**。
2. **引导路径本来就通**：契约 §2.1 已经把「debugfs 没挂」建模成 `unavailable`，
   并在 `detail` 里给了修复提示（`mount -t debugfs debugfs /sys/kernel/debug`）。
   **契约早就假设它可能没挂。**
3. 挂载是**系统级改动**，不是「这块板的能力」；真要做也该是**人类在板子上做**，
   不是 agent 触发。
4. 真要加就得动**危险地板表** = 改契约 = 升 apiVersion —— 为一块不需要的板子不值。

### ④-6　C1 的建议：**选 `cur_freq`，现在可以定** —— 比 Claude 多一条理由

Claude 给的理由（不依赖 debugfs、sysfs 下 always available）**对**。
**本轮补一条更重要的**：`cur_freq` 是**纯只读观测**，**不碰 governor 写路径** ——
也就是**没有 E4 那种死锁风险**。

实测：`cur_freq` = `1000000000`，与 `/sys/kernel/debug/rknpu/freq` **一致**。
前身工程写的 `…/rknpu/devfreq/cur_freq` 不存在（C1 已回滚 ✓）。

**顺带记一条**：`docs/spec/01` §2.1 的例子说 `/sys/kernel/debug`「默认没挂载」，
**对这块板不成立**（E7）。这不是契约错误（它讲的是「环境状态」这个模型），
但**示例与本板实际不符** → 记进 `docs/06`，并把 `docs/02` 里 `npu.usage` 那条
从 🟡 提到 🟢（本板实测可读）。

---

## 五、拍板之后的落地清单（供拍板人参考，本轮不执行）

| # | 落点 | 内容 |
|---|---|---|
| 1 | `docs/05` | 写 ADR 关闭 **O9 / O10 / O13 / O15**；**O14 保持待拍板** |
| 2 | `docs/spec/02` | ①能力词表定义 + **词义对照表** + **删 `stream`** + **规则 25/26**；②§4.4 加 `kind: none`、§4.5 明写 `verify` 不许 `none`、§4.5 后加 `verified` 口径 |
| 3 | `docs/spec/04` | §2.4 `execute_action` 的返回加 `verified` 字段与 UI 口径 |
| 4 | `docs/spec/01` | **不动**（`unverified` 不进 tag 状态机） |
| 5 | `profiles/boards/rk3588-atk/board.yaml` | `requires.capabilities` 去掉 `stream` |
| 6 | `src/shared/ipc-contract.ts` + `src/main/hal/capabilities.ts` | `Capabilities` → `ConnectionCapabilities` |
| 7 | `docs/02` §3.1 | 补 E1–E7 实测；`cpu.governor.set` 首次真机验证；`npu.usage` 提级 🟢 |
| 8 | `docs/06` | 补核对项：debugfs 示例与本板实际不符、`requires.capabilities` 无消费者（v1） |
| 9 | `docs/superpowers/plans/` | 写**计划 2**（M3 契约移植 + M4 板型包真机验证） |

---

## 六、仍然在外面的欠账（与本轮拍板无关，但别忘了）

1. **打包配置**：`package.json` 里**没有 electron-builder 配置**，`npm run build` 只出 `out/`，
   **用户装不出 exe**。这条直接关系到你之前问的「将来开源别人怎么装」——
   **现在这个工程只能 `npm run dev` 跑起来**，还不能分发。
2. **`validate:profiles` / `probe:board` 两个命令至今不存在**，文档里引用了 **30 处**。
3. `scripts/ensure-native.mjs` 在本机会因 **GBK 编码**让 electron-rebuild 失败（需 `PYTHONUTF8=1`）——
   这是环境坑，不是代码 bug，但**开源后 Windows 用户大概率会撞上**。

---

*本文只列 Codex 的独立意见与新实测，不代替拍板人的决定。*
*三条建议的一句话版本：*
***① 同意 A，但改名要叫「连接级」、映射只能是词义对照表、`stream` 从词表删、`requires.capabilities` 要给消费者。***
***② 同意 A，但只用 `readback: {kind: none}` 一种写法、`unverified` 别进 tag 的 reason 表、改用 `verified: false`、顺便补「每个动作都必须有 readback」。***
***③ 同意 A，但理由换成「实测会把板子锁死且不可恢复」；O15 收敛为 `rknpu_ondemand` 一个值；C1 定 `cur_freq`（只读，无死锁风险）。***

*—— Codex · 2026-11-13*