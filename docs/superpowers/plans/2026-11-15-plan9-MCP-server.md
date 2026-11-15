# 计划 9 · MCP server（agent 的手）

> **日期**：2026-11-15
> **性质**：**新能力**（M7 ✓）—— 契约**已经写好** ✓（`docs/spec/04-mcp-tools.md` ✓），
> 这一轮是**把它实现出来** ✓。
> **前提**：契约增量 v3 ✓（ADR-D34 ✓）· v4 ✓（ADR-D36 ✓）· 计划 7 ✓（卡片侧 ✓）· 计划 8 ✓（修复轮 ✓）
> **契约**：**一个字不改** ✓

---

## 〇 · 先把两个前提查清楚（**不查就动手 = 猜** ✓）

| # | 问题 | 答案 |
|---|---|---|
| 1 | **协议怎么实现** | 读 MCP 官方规范（2025-06-18 ✓）：**Streamable HTTP** ✓ —— 一个端点 ✓，POST 发 JSON-RPC ✓，响应可以是 `application/json` 或 SSE ✓；`initialize` → `notifications/initialized` → `tools/list` / `tools/call` ✓ |
| 2 | **用不用官方 SDK** | **不用** ✓ —— 见 §一 |

---

## 一 · 决定：**不引 SDK**（**ADR-D39** ✓）

`docs/04` §132 的选型表写着「MCP → `@modelcontextprotocol/sdk`」。
**这一轮推翻它** ✓ —— 理由三条，都实测过 ✓：

| # | 理由 | 证据 |
|---|---|---|
| 1 | **它带 91 个包 / 29MB** ✓（express · hono · cors · jose · zod 全家桶 ✓） | 实测 `npm install @modelcontextprotocol/sdk@1.32.2` → **91 packages, 29M** ✓ |
| 2 | **本工程零 web 框架依赖** ✓ —— 引入 express/hono 是一次架构风格的重排 ✓ | `package.json` 的 dependencies 只有 7 个 ✓，没有 web 框架 ✓ |
| 3 | **沙箱与宿主共用一份 `node_modules`** ✓ → 装新依赖会**把两边的平台二进制搞坏** ✓ → **MCP server 的代码在沙箱里根本没法验** ✓ | 记忆 `reference_devboard_cockpit_shared_node_modules` ✓ |

> **第三条是决定性的** ✓：这个工程的规矩是「**证据先于断言**」✓ ——
> 引了 SDK 就交一批**没验过**的代码 ✗。
> 手写则可以**在沙箱里跑真 HTTP 请求**把它验穿 ✓。

**代价（诚实说）** ✓：
- 要自己实现 JSON-RPC 的**方法分派** ✓ 与 HTTP 传输的**几个规矩** ✓；
- SDK 附带的那些能力（SSE 推送 · resumability · prompt/resource · OAuth）**本轮不做** ✓
  → **契约里也没有** ✓（`spec/04` 只要求「agent 能发现并连上」✓）。

---

## 二 · 四个任务

### Task 1 · 安全基线（`src/main/mcp/security.ts`）

契约 §7.1 的六条硬要求 ✓ —— **每一条一条判据** ✓：

| # | 规定 | 判据 |
|---|---|---|
| 1 | **只绑 `127.0.0.1`** ✓ | 监听地址断言 ✓ |
| 2 | **`Origin` 存在且不合法 → 403** ✓ | 恶意 Origin → 403 ✓；本机 Origin → 放行 ✓；**没有 Origin**（非浏览器客户端 ✓）→ 放行 ✓ |
| 3 | **`Host` 只接受 `127.0.0.1:<port>` 与 `localhost:<port>` ✓ | 别的主机名 → 403 ✓ |
| 4 | **每个请求要 `Authorization: Bearer <token>`** ✓ | 没头 → 401 ✓；token 不对 → 401 ✓；对 → 放行 ✓ |
| 5 | **token 每次启动重新生成（≥32 字节）** ✓ | 两次生成**不一样** ✓ · 长度 ≥32 ✓ |
| 6 | **不写 CORS 头** ✓ | 响应里没有 `Access-Control-Allow-Origin` ✓ |

> **为什么 Origin 与 Host 都要查** ✓：DNS rebinding ✓ —— 恶意网页把域名解析到 `127.0.0.1` ✓，
> 浏览器发的 `Host` 是那个恶意域名 ✓ → **只查 Origin 挡不住非浏览器的 fetch** ✓，
> **只查 Host 挡不住带合法 Origin 的代理** ✓ → **两个都要** ✓。

### Task 2 · 发现文件（`src/main/mcp/discovery.ts`）

契约 §7.2 的发现文件 ✓ —— `mcp.json` ✓ 字段照契约抄 ✓（`apiVersion` / `transport` / `host` / `port` / `pid` / `token` / `cards_dir` / `started_at` ✓）。

| # | 规定 | 判据 |
|---|---|---|
| 1 | **先写临时文件再原子改名** ✓ | 写的过程**读不到半个文件** ✓ |
| 2 | **权限仅当前用户可读**（POSIX 0600 ✓） | 模式是 0600 ✓ |
| 3 | **GUI 退出时删除** ✓ | 退出后文件没了 ✓ |
| 4 | **端口被占用时也要删**（不留指向死进程的发现文件 ✓） | 监听失败 → 发现文件不存在 ✓ |
| 5 | **token 不写进日志** ✓ | 日志里搜不到 token ✓ |

### Task 3 · JSON-RPC 方法分派 + 工具（`src/main/mcp/`）

**协议层**（照 2025-06-18 规范 ✓）：

| # | 做 | 判据 |
|---|---|---|
| 1 | `initialize` → 回 `protocolVersion` / `capabilities` / `serverInfo` ✓ | 形状对 ✓ |
| 2 | `notifications/initialized` → **202 空体** ✓（规范 §「Sending Messages」第 4 条 ✓） | 202 ✓ |
| 3 | `tools/list` → 工具清单 ✓（带 `inputSchema` ✓） | 清单里能看到 `run_workflow` ✓ |
| 4 | `tools/call` → 调工具 ✓ | 见 Task 4 ✓ |
| 5 | **未知方法 → JSON-RPC error（-32601）** ✓ | ✓ |
| 6 | **协议版本头 `MCP-Protocol-Version`** ✓（后续请求要带 ✓） | 不支持的版本 → **400** ✓（规范 §「Protocol Version Header」✓） |

**工具层**：契约 §2.4 的**四个流程工具** ✓（这一轮只做这四个 ✓ —— 其余 17 个下一轮 ✓）：

| 工具 | 落到哪 | 判据 |
|---|---|---|
| `list_workflows()` | `workflowService.list()` ✓ | **只给 id / name / 输入声明** ✓（**不给拓扑** ✓ —— 契约 §2.4 明写 ✓） |
| `run_workflow(id, inputs, dry_run)` | `workflowService.start()` ✓ | 返回 `{ run_id }` ✓ |
| `workflow_status(run_id)` | `workflowService.status()` ✓ | **卡片侧是缩减投影** ✓（`03` §7.7 ✓）—— **不是**原样搬过去 ✓ |
| `confirm_workflow(run_id)` | `workflowService.requestConfirmation()` ✓ | **只递请求，不使凭据生效** ✓（契约 §2.4 明写 ✓） |

> **agent 没有取消流程的工具** ✓（契约 §2.4 ✓）——「停不停」是人的判断 ✓。

### Task 4 · 接线 + 验收

| # | 做什么 | 判据 |
|---|---|---|
| 4.1 | main 里起服务 ✓（**在 `app.whenReady` 里** ✓ —— ADR-D2：同进程 ✓） | ✓ |
| 4.2 | 退出时删发现文件 ✓ | ✓ |
| 4.3 | **端到端**：真 HTTP 请求打自己的端口 ✓ | `initialize` → `tools/list` → `tools/call` ✓ **全通** ✓ |
| 4.4 | **恶意 Origin → 403** ✓ · **没 token → 401** ✓（真 HTTP ✓） | ✓ |
| 5 | 台账 + ADR-D39 ✓ + 记忆 ✓ | ✓ |

---

## 三 · 判据怎么写（**本轮的教训** ✓）

**每条判据都要能看见它红** ✓ → **写完先撤掉实现看它红** ✓
（计划 8 的 I-1 判据第一版是**空的** ✓ —— 写完就绿、撤掉实现仍绿 ✓）。

**新增的判据全部配变异守卫** ✓（本工程的规矩 ✓）。

---

## 四 · 这一轮**不做**的事

| 不做 | 为什么 |
|---|---|
| 其余 17 个工具 ✓ | 一次做 21 个 → 判据不够密 ✓；先做四个把链路跑通 ✓ |
| **SSE 推送**（服务端 → 客户端主动推） ✓ | 契约没要求 ✓（`spec/04` §7.1 只要「能发现并连上」✓） |
| **resumability**（`Last-Event-ID` 重放） ✓ | 同上 ✓ |
| **prompt / resource / OAuth** ✓ | 契约没要求 ✓ |
| **agent 取消流程** ✓ | 契约明写不给 ✓ |
| **agent 批准确认** ✓ | 契约明写「批准不是 MCP 工具」✓ |

---

## 五 · 验收

```bash
npm run typecheck
npm run lint
npx vitest run tests/unit/mcp tests/integration   # 新增的
npm test                    # 宿主跑全量
npm run mutation:check       # 宿主跑全量
```

**真机**：MCP server 只连本机 ✓ → **不需要板子** ✓ → 沙箱里能验穿 ✓。

---

## 六 · 完成情况（2026-11-15）

| 任务 | 状态 | 去哪看 |
|---|---|---|
| **Task 1** · 安全基线 | ✅ **完成** ✓ | `src/main/mcp/security.ts` ✓ · 13 条判据 ✓ · 守卫 `M153`–`M156` ✓ |
| **Task 2** · 发现文件 | ✅ **完成** ✓ | `src/main/mcp/discovery.ts` ✓ · 6 条判据 ✓ · 守卫 `M157`–`M159` ✓ |
| **Task 3** · JSON-RPC + 四个流程工具 | ✅ **完成** ✓ | `src/main/mcp/server.ts` ✓ · `src/main/mcp/view.ts` ✓ · 14 条判据 ✓ · 守卫 `M162`–`M164` ✓ |
| **Task 4** · 接线 + 端到端 | ✅ **完成** ✓ | `src/main/mcp/http.ts` ✓ · `src/main/index.ts` ✓ · 端到端判据 ✓ · 守卫 `M165`–`M168` ✓ |

### 与计划书的三处出入（**都记在账本里** ✓）

| # | 计划说的 | 实际做的 | 为什么 |
|---|---|---|---|
| 1 | 「安全基线 + 四个流程工具」✓ | **多做了 HTTP 层** ✓ | 没有 HTTP 层就没有「agent 连得上」这件事 ✓ —— 而那是**这个计划的目的** ✓ |
| 2 | 工具失败用 `{ok:false, reason}` ✓ | **多加了 `apiVersion`** ✓ | 契约 §四：「**每个响应里都带上**」✓ —— 计划书漏了这条 ✓ |
| 3 | 守卫跟着判据走 ✓ | **两条守卫改过锚点** ✓ | M153（Origin 那条变异打在死代码上 ✓）、M167（测的是「绑到哪」而不是「不许绑别的」✓）→ **判据写完要撤掉实现看它红** ✓（计划 8 的老教训 ✓） |

### 沙箱实测

`tsc`（node + web ✓）全绿 ✓ · `eslint` 全绿 ✓ ·
**MCP + 卡片 + 流程 + 动作 + 集成：510 条全绿** ✓ ·
守卫 **M153–M168 十六项全守住** ✓（每一项都**手动撤过实现看它红** ✓）。

**宿主要再跑一次**：`npm test` / `npm run mutation:check`（本轮加了判据与守卫 ✓）。

---

*每一步按 **RED → GREEN** 走 ✓；每个判据都**先看见它红** ✓；每个判据都有**变异守卫** ✓。*
