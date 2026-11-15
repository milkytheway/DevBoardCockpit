# 流程包（workflow pack）格式

> **契约版本**：`devboard/v1`
> **定稿状态**：已起草（2026-11-15，ADR-D34 ✓）
> **上位**：`00-overview.md`（两条总线）· `02-board-pack.md`（动作与回读）· `03-card-manifest.md`（卡片与权限）· `04-mcp-tools.md`（agent 的手）

---

## 〇 · 它回答什么

| 包 | 回答 |
|---|---|
| 板型包（`02`） | **这块板有什么**（能产生哪些量、能接受哪些写） |
| **流程包（本文）** | **这件事怎么做**（多目标、多步骤、有判据、可追责） |

> **「目标」不是契约的概念** ✓：
> 「本机编译」与「客机编译」是**两个流程包** ✓ → 卡片与 agent 只看到
> **流程 id + 输入声明** ✓ → 契约层不需要「目标」这一维 ✓。

---

## 一 · 一个包长什么样

```yaml
apiVersion: devboard/v1
kind: Workflow

id: hello-kernel.build-run
name: 编译内核模块 → 直传板子 → 装 → 跑
version: 1.0.0
description: 在客机上编译内核模块，客机直传到板子的规范位置，depmod -a 后按名字加载。

inputs:
  build_dir:
    type: path
    required: true
    maxLength: 200
    description: 构建机上的工程根目录
  project:
    type: string
    required: true
    maxLength: 200
    description: 项目目录名（相对 build_dir）

roles:
  build:
    purpose: 编译所在（客机）
    profile: ubuntu-ssh
  target:
    purpose: 板子
    profile: board-adb

steps:
  - id: compile
    kind: exec
    role: build
    cmd: "cd {input:build_dir}/{input:project} && make"
    timeout_ms: 1800000
    readback:
      kind: command_ok

  - id: artifacts
    kind: discover
    role: build
    dir: "{input:build_dir}/{input:project}"
    pattern: "*.ko"
    exclude: ["*.o", "*.cmd", "*.order", "*.mod.c"]
    out: artifacts

  - id: deliver
    kind: file.transfer
    from:
      role: build
      path: "{output:artifacts}"
    to:
      role: target
      placement: kernel-module
    cmd: "scp {from.path} {role:target.user}@{role:target.host}:{to.path}"
    timeout_ms: 1800000
    out: dest
    readback:
      kind: verify
      role: target
      command: "test -f {to.path}"
      timeout_ms: 30000

  - id: load
    kind: exec
    role: target
    cmd: "depmod -a && modprobe {output:artifacts.name}"
    timeout_ms: 120000
    readback:
      kind: command_ok
```

**顶层字段（封闭）**：`apiVersion` `kind` `id` `name` `version` `description` `inputs` `roles` `steps` ✓。
**未知字段一律报错** ✓（与 `02`/`03` 同一规矩 ✓）。

---

## 二 · `inputs`（参数）

类型表**照 `02` §4.3** ✓（不另造一套 ✓）：

| type | 额外必填 | 说明 |
|---|---|---|
| `string` | `maxLength` | 不许开口 ✓ |
| `integer` | — | 可选 `min` / `max` ✓ |
| `number` | — | 可选 `min` / `max` ✓ |
| `boolean` | — | |
| `enum` | `values`（封闭取值表 ✓） | 不在 `values` 里 → **报错** ✓ |
| `path` | `maxLength` | **等价于 `string`** ✓（编码规则一样 ✓） |

其余字段：`required`（布尔）· `default` · `pattern` · `description` ✓。

---

## 三 · `roles`（角色 → 连接）

| 字段 | 必填 | 含义 |
|---|---|---|
| `purpose` | 是 | 这个角色**是干什么的**（给人看 ✓） |
| `profile` | 是 | 宿主里**存在的**连接 profile id ✓ |

| 规矩 | 为什么 |
|---|---|
| **只许引用 profile id，不许覆写字段** | 地址、用户、凭据**全是宿主的账** ✓（`02` §5.5 的同款原则 ✓） |
| **不许引用 `local` 传输的 profile** | `local` 是**宿主自己的 shell** ✓ —— 流程在它上面跑命令 = 在宿主上跑命令 ✗ |
| **profile 不存在 → 报错** | 不许悄悄连到别的目标 ✓ |

---

## 四 · `steps`（步骤）

### 4.1 六种 kind（**封闭**）

| kind | 干什么 | 必填 | **在哪跑** |
|---|---|---|---|
| `exec` | 跑一条命令 | `role` `cmd` | `role` 指的目标 ✓ |
| `discover` | 产物发现 | `role` `pattern` `out` | `role` 的目标上**列目录** ✓ |
| `file.transfer` | 搬运 | `from` `to` `cmd` | **源目标**（`from.role` ✓） |
| `action` | 引用板型包里的**已声明动作** | `role` `action` | `role` 的目标 ✓ |
| `await` | 等一个判据成立 | `readback` | 判据指定的角色 ✓ |
| `assert` | 判据 + 不符时怎么办 | `readback` | 同上 ✓ |

> **`file.transfer` 的命令跑在源角色上** ✓ ——
> 「客机编译的产物**由客机自己**送到板子」✓，**不经宿主取回** ✓。

> **`exec_script` 连「留位置」都不留** ✓（逃生门一旦写进表项，就会有人去用 ✓）。

### 4.2 步骤的其余字段

| 字段 | 用在哪 | 说明 |
|---|---|---|
| `timeout_ms` | `exec` / `file.transfer` | 这一步的执行超时 ✓ |
| `params` | `action` | 动作的参数（值里可有占位符 ✓） |
| `danger` | 全部 | `reversible`（默认）/ `destructive` ✓ |
| `on_mismatch` | `assert` | `fail`（默认）/ `continue` ✓ |
| `out` | `discover` / `file.transfer` | 这一步的产出进哪个槽 ✓ |

### 4.3 `discover` 的发现规则

| 字段 | 意思 |
|---|---|
| `dir` | 在哪个目录找（默认当前目录 ✓） |
| `pattern` | **要什么**（按**文件名**匹配 ✓） |
| `exclude` | **不要什么**（同样的匹配方式 ✓） |
| `out` | 找到的路径进哪个槽 ✓ |

> **排除表必须有意义**：编译目录里满是中间产物（`.o` / `.cmd` / `.order` / `.mod.c`），
> 漏一条就可能**把中间文件当产物送上去** ✗。
> **多个匹配 → 取第一个**（按名字排序 ✓，结果可复现 ✓）。

### 4.4 `file.transfer` 的两端

```yaml
from:
  role: build          # 源（**命令在这里跑** ✓）
  path: "{output:artifacts}"
to:
  role: target         # 目的地
  path: "/opt/x"       # ① 用户指定的路径
  # placement: kernel-module    # ② 语义默认（**封闭词表** ✓）
```

| placement | 落位 |
|---|---|
| `kernel-module` | `/usr/lib/modules/<版本>/extra/`（**版本要问目标机器** ✓） |
| `user-program` | `/usr/local/bin/` |

> **拼错 → 报错** ✓（不能默默回落到「随便放」✗ —— 那会把 `.ko` 丢在 `/tmp` 里，
> 而 `modprobe` 找不到它，流程却报成功 ✗）。
> **三形态**：① `path` ② `placement` ③ `ask`（**首版不做** ✓）。

---

## 五 · 判据（`readback`）

**词汇就是 `02` §4.4 的五种** ✓——**不新增第六种形式** ✓：

| 形式 | 首版 |
|---|---|
| ① `tag` | ❌ **首版报错**（tag 属于**板型包的核心词表** ✓，流程层没有板型包 → **查不了** ✗） |
| ② `file_equals` | ✅ |
| ③ `command_ok` | ✅（**串口上没有退出码** → 在串口上被拒 ✓） |
| ④ `verify` | ✅ |
| ⑤ `none` | ✅（**只允许在 `danger: reversible` 的步上** ✓） |

**唯一的扩展：多一个 `role`** —— 「**在哪个角色上读**」✓。

```yaml
readback:
  kind: verify
  role: target          # ← 在**目标**上读（「板子上真的有那个文件吗」✓）
  command: "test -f {to.path}"
  timeout_ms: 30000
```

| 规矩 | 为什么 |
|---|---|
| **`role` 指到没声明过的角色 → 报错** | 判据不能去读**没授权的机器** ✗ |
| **`await`/`assert` 必须说得出在哪个角色上读** | 否则「默认读哪」是猜的 ✗ |
| **判据的命令也要过危险地板** | 它是**包给的命令** ✓ → 不查就能借「验证」之名跑危险命令 ✗ |
| **判据命令不进确认通道**（首版） | 判据是**只读验证** ✓；防线是「装包时人看过」✓ + 地板 ✓ |

> **跨目标的判据由流程层跑** ✓（`02` §5.2 的执行器在**执行的那条连接**上回读 ✓）→
> **两个事实、两行账** ✓（判据那一行单独记 ✓）。

---

## 六 · 占位符（**封闭的五种** —— 它**就是注入防线** ✓）

| 写法 | 指什么 |
|---|---|
| `{input:名字}` | 一个参数的值 |
| `{role:角色.事实}` | 角色的连接事实 |
| `{output:槽}` | **前面某一步**产出的槽 |
| `{output:槽.name}` | 文件名**去掉扩展名**（`hello.ko` → `hello` ✓） |
| `{from.path}` / `{to.path}` | **这一步自己的**源 / 目的地（**只有 `file.transfer` 步里有** ✓） |

**角色事实的封闭表**：`host` / `port` / `user` / `profile_id` ✓
（**没有 `key`** ✓ —— 凭据路径不该被插进命令 ✓：它会进审计行 ✓、会进 `dry_run` 回显 ✓，
而且它**多半没用** —— 命令跑在**源目标**上，源目标用的是**它自己的**密钥 ✓）。

**两种替换模式**：

| 模式 | 用在哪 | 输入值 | 角色事实 | 槽里的路径 |
|---|---|---|---|---|
| **命令模式** | 步骤的命令、回读的二次验证命令 | **按类型编码过**（`02` §4.6 ✓） | **字符串包引号** ✓ | **包引号** ✓ |
| **值模式** | 回读的 `expect` / `path`、发现的 `dir` / `pattern` / `exclude` | 原样 ✓ | 原样 ✓ | 原样 ✓ |

> **命令模式就是注入防线** ✓：`; reboot` 这种输入值**被当字面量** ✓。
> **模板里的占位不许自带引号** ✓（与 `02` 校验规则 21 同款 ✓）。

**静态检查**（解析时就查 ✓）：占位指向没声明过的 input / role / 输出槽 → **报错** ✓
（拼错到运行时才炸 = 流程跑到一半才失败 ✗）。

---

## 七 · 信任模型（**这一节是本文最要紧的** ✓）

### 7.1 一个流程包就是「一组要在用户机器上执行的命令」

→ 它必须有**比动作更严**的入口 ✓。

### 7.2 三本账

| 账 | 记什么 | 谁能改 |
|---|---|---|
| **注册表** | 目录里有哪些包（id → 包 + **内容摘要**） | 放文件进目录 |
| **批准账** | 哪些包**被用户批准过**（id → 摘要 + 时刻） | **只有人能改** ✓ |
| **审计** | 每次运行每一步做了什么（`02` §5.4 ✓） | 宿主 |

### 7.3 五条规矩

| # | 规矩 | 为什么 |
|---|---|---|
| **T1** | **放一个文件进目录 ≠ 批准它** | 否则「能写文件」=「能执行命令」✗ |
| **T2** | **批准绑内容摘要** | 改了内容 → **要重新批准** ✓（不然「批准 A 版、跑 B 版」✗） |
| **T3** | **卡片与 agent 只能按 id 取注册表里的包**，**给不了路径** | agent 不能自写一个包就跑 ✗ |
| **T4** | **每个写步骤都过 `02` §4.6 的编码 + §5.2.1 的危险地板**；命中地板 → **按 `destructive` 处理** | 自由命令是**第二条命令通道** ✗ —— 它必须与动作**同一条防线** ✓ |
| **T5** | **角色不许绑到 `local` 传输** | `local` 是宿主自己的 shell ✓ |

### 7.4 批准时**必须展示**「会在哪些目标上跑哪些命令」

→ 角色 → profile id、每个写步骤的命令**模板**、这一步危不危险、判据读在哪个角色上 ✓。

> 不然批准就只是「批准一个文件名」✓ → **等于没看** ✗。

### 7.5 危险命令的运行期确认

| # | 规矩 |
|---|---|
| 1 | 步骤声明 `danger: destructive` → **每次运行都要人确认** ✓ |
| 2 | **命中危险地板 → 也按 `destructive` 处理**（取更严的 ✓） |
| 3 | **确认凭据绑**：`(动作 id（含步骤 id）, 参数摘要 + 这一步的输入摘要, 这一步最终命令的摘要, 包 id, 契约版本)` |
| 4 | **凭据一次性**（用掉即废）+ **有效期 5 分钟** ✓（同 `04` §2.4.1 ✓） |
| 5 | **「签发 ≠ 有效」**：没人点，`confirm_id` 永远无效 ✓ |

### 7.6 确认链

```
某个写步骤要确认
   → 执行器签发 confirm_id（**待确认**，还不能用 ✓）
   → 流程**停在那一步**（状态 = awaiting_confirmation ✓，**不是 failed** ✓）
   → **人点头**（GUI 确认界面 / 宿主命令行 ✓）
      → 凭据**变成可用** ✓
   → 流程**从停住的那一步继续**（**前面的步不重跑** ✓）
   → 同一个 run_id、同一份时间线 ✓
```

> **⚠️「批准」不是 MCP 工具** ✓：
> **agent 唯一能做的是「递一次确认请求」**（`confirm_workflow(run_id)` ✓）——
> 那只是把请求递进 GUI 的队列 ✓，**凭据仍然无效** ✓。
> 「批准」这个动作**在 GUI 那一侧** ✓（同 `04` §2.4.1 的 `confirm_action` ✓）。

### 7.7 流程的授权有**两层**

① **流程包已批准**（宿主侧 ✓）② **这张卡被授过这个流程**（卡级 ✓）→ **两层都要过** ✓。

> 流程**不是动作**（不在板型包里 ✓），但它**一样能在用户机器上执行命令** ✗
> → 它**必须**有自己的授权层 ✓（`03` §3.3 的同款模型 ✓）。

---

## 八 · 长任务的运行语义

| # | 规定 |
|---|---|
| 1 | **触发立刻返回 `run_id`**（编译是分钟级 ✓ → 同步返回不成立 ✓） |
| 2 | **`status(run_id)` 轮询取时间线** ✓（首版 poll ✓） |
| 3 | **状态机**：`running` / `awaiting_confirmation` / `done` / `failed` ✓ |
| 4 | **幂等**：同一个 `run_id` 重复查 → **同一份时间线** ✓ |
| 5 | **重新触发** = **从头再跑** ✓（**前面已完成的写步骤会重复执行** ✓ → `destructive` 的步**不要放在有副作用的写步之后** ✓） |
| 6 | **续跑**（人点头后）= **从停住的那一步继续** ✓（§7.6 ✓） |
| 7 | **并发**：**同一个流程包同时只允许一次运行** ✓（两个流程同时抢一条串口会串台 ✓） |
| 8 | **取消**：**首版不支持** ✓（执行原语不可中断 ✓）→ **契约里明写不支持** ✓ |

---

## 九 · 校验清单

`validate_workflow(path)` 必须检查：

| # | 规则 |
|---|---|
| 1 | `apiVersion` 是已知版本 |
| 2 | `kind` 是 `Workflow` |
| 3 | **每一层都没有未知字段** |
| 4 | `id` 格式合法（`名字.名字`） |
| 5 | `inputs` 的类型在封闭表里；`enum` 有 `values`；`string`/`path` 有 `maxLength` |
| 6 | `roles` 的每个 role 有 `purpose` 与 `profile`；**profile 存在**且**不是 `local` 传输** |
| 7 | `steps` 非空；`id` 唯一；`kind` 在六种里 |
| 8 | 每种 kind 的必填字段都在（§4.1） |
| 9 | `placement` 在封闭词表里 |
| 10 | **占位指向的东西都存在**（input / role / 输出槽 / 角色事实） |
| 11 | **`danger: destructive` 的步不许用 `readback.kind: none`**（同 `02` §4.4.1 ✓） |
| 12 | **`await`/`assert` 说得出在哪个角色上读** ✓ |

> 规则 **11** 是 `02` §4.4.1 的同款（「`destructive` 仍禁止 `none`」✓）——
> 跨目标的判据**不算豁免** ✓。

---

## 十 · 契约里**不做**的事

| 不做 | 为什么 |
|---|---|
| **「目标」作为契约概念** | §〇 ✓ |
| **卡片自己拼多步** | 组合属于流程包 ✓ |
| **流程的推送通道** | 首版 poll ✓（`00` §七 的连续流契约还没定死 ✓） |
| **流程包自己携带凭据** | 只许引用 profile id ✓ |
| **`exec_script`** | §4.1 ✓ |
| **判据的形式 1** | §五 ✓ |
| **取消** | §八·8 ✓ |
| **落地的第三形态 `ask`** | §4.4 ✓ |
| **分支与循环** | 首版是**一条直线** ✓ |

---

*依据：`docs/05` 的 **ADR-D31 / ADR-D32 / ADR-D34**；
`docs/36-契约增量-v3-流程包与卡片触发.md`（提案）✓；
`docs/superpowers/spikes/2026-11-16-流程直传.md`（真机实测）✓。*
