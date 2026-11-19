# AGENTS.md

面向在此仓库工作的 AI agent 与开发者的工程约定。

---

## 一 · 工程结构

这是一个产品工程。产品的形态：面向嵌入式 Linux 开发者的 Windows 桌面工作台，板子的能力表达为语义位号，可视化与操控表达为卡片，扩展方式为 MCP。

| 层 | 位置 | 地位 |
|---|---|---|
| 契约层 | `docs/spec/` 五份文档 + `docs/spec/data/tag-vocabulary.yaml` | 权威。位号词表、板型包格式、卡片清单、流程包格式、MCP 工具集 |
| 实现层 | `src/` | 主进程、卡片宿主、位号运行时、流程执行器、MCP 服务 |
| 资产 | `cards/` `profiles/` | 内置卡片、板型包、流程包、连接 profile |

主进程持有全部设备 I/O、位号采集、动作执行与权限判定。渲染进程只负责绘制。卡片运行在独立 iframe 中，只能访问白名单 API。

## 二 · 三条主线

1. **契约优先。** 契约冻结在 `docs/spec/`，实现必须逐条对齐，不得另立命名或状态语义。改动契约需要评审，并相应决定 `apiVersion` 是否升级。`devboard/v1` 尚未随正式版本发布，此前的修改属于定稿前的修正，不升版本号。
2. **卡片是文件。** agent 写完即生效，改一行热插拔。卡片不依赖打包流程。
3. **驾驶舱而非遥控器。** 控制动作必须回读，界面以板子真实状态为准。

## 三 · 工作方式

- **先写测试再看它失败。** 纯函数必须有单元测试；真机样本做黄金向量。
- **契约层冻结。** 修改 `docs/spec/` 走评审。封闭码表增加条目属于契约变更。
- **契约与实测的差异记入核对清单，不擅自改包。** 修改板型包前先看差异清单。
- **改架构决策要写决策记录。** 不在代码里静默改变结构。

## 四 · 阅读顺序

```
README.md
  └─ docs/spec/00-overview.md       两条主线与各文档职责
  └─ docs/spec/01-tag-contract.md    位号词表与五种状态
  └─ docs/spec/data/tag-vocabulary.yaml  词表的机器可读权威
  └─ docs/spec/02-board-pack.md      板型包与数据源类型
  └─ docs/spec/03-card-manifest.md   卡片清单与权限
  └─ docs/spec/04-mcp-tools.md       MCP 工具集
  └─ docs/spec/05-workflow-pack.md   流程包格式
  └─ docs/02-device-facts.md         实测路径与行为约束
  └─ docs/tutorial/01-建立板型包.md  为陌生板子建立板型包
```

## 五 · 硬约定

| 约定 | 说明 |
|---|---|
| **词表只有一个源头** | 核心词表的机器可读权威是 `docs/spec/data/tag-vocabulary.yaml`。修改后运行 `npm run gen:vocabulary`，并用 `npm run gen:vocabulary:check` 确认文档表格、代码词表与 YAML 三者一致 |
| **颜色只有一个源头** | 语义色在 `src/shared/theme/seed.ts`，材质色在 `src/shared/theme/`。改完运行 `npm run gen:theme:check` |
| **路径写绝对路径** | Windows 宿主用 `C:\...`，板端路径用 POSIX 绝对路径。机器专属路径只出现在 `profiles/settings.json` 与连接 profile 中 |
| **事实标注状态** | 已核实、用户陈述、待验证三种状态要区分开 |
| **测试样本只增不改** | `fixtures/` 中的是黄金向量 |
| **未知字段报错** | 契约层封闭 schema 拒收未知字段，避免拼错的字段被静默忽略 |
| **Windows 子进程隐藏控制台** | 拉起子进程时设置 `windowsHide: true` |

## 六 · 代码规范

| 项 | 约定 |
|---|---|
| 语言 | TypeScript，`strict` 模式，禁用 `any`（确需时用 `unknown` 并收窄） |
| 主进程与渲染进程边界 | 设备 I/O、位号层、动作层、卡片注册表、MCP 服务全部在主进程 |
| 卡片沙箱 | 独立 iframe，`sandbox="allow-scripts"`，内容安全策略由宿主注入 |
| 参数编码 | 拼接进 shell 的字符串按类型编码，路径加引号并拒绝换行与空字符 |
| 未知不等于零 | 读不到与读数为零是两种状态，前者显示为不可用，不显示数字 |

## 七 · 常见错误

| 错误 | 后果 |
|---|---|
| 把「暂时没有数据」与「连不上」混成一句话 | 用户无法判断该查数据还是查连接 |
| 在渲染进程直接读位号 | 绕过主进程，破坏单一数据源 |
| 在渲染进程做权限过滤 | 权限判定必须在主进程，页面拿到的是已过滤的结果 |
| 自行实现动作执行、回读或审计 | 参数编码与权限判定是防线，重写会引入注入面 |
| 用真实数值代替状态 | 恒为零的仪表比没有仪表更危险，它看起来是真的 |
| 位号自带引号 | 引号由运行时统一编码，叠加会出错 |

## 八 · 常用命令

```bash
npm run dev                    # 开发模式
npm run build                  # 构建与产物自检
npm run dist                   # 构建安装包
npm run lint
npm run typecheck
npm test
npm run test:cards             # Playwright，真 Electron
npm run validate:profiles      # 校验板型包
npm run probe:board -- --profile board-adb   # 对真板探测
npm run check:package          # 校验打包产物
npm run gen:vocabulary:check   # 确认词表三处一致
npm run gen:theme:check        # 确认主题产物一致
```
