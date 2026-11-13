# 验收工具（无头驱动真实应用）

> **为什么有这三个脚本**：验收清单里大部分判据是「点按钮、看屏幕」。
> 人肉点只能验一次、且不可复跑。
> **CDP（Chrome DevTools Protocol）能从外面驱动真实渲染进程**——
> 读 DOM、点按钮、敲键盘，于是判据变成**可复跑的脚本**。
>
> 这些脚本是 2026-11-13 的真机验收用的（`docs/superpowers/plans/2026-11-12-plan1-真机验收清单.md`）。

## 五个脚本

| 文件 | 干什么 |
|---|---|
| `cdp.mjs` | 极简 CDP 驱动：连上本地 Electron 的渲染进程，评估 JS 表达式（读 DOM、点按钮） |
| `run-app.sh` | 在无显示器的 Linux 沙箱里用 **Xvfb** 起真实 Electron，带 `--remote-debugging-port` |
| `fake-console.py` | 一块「假板子」：在 pty 另一端扮演串口控制台（**回显**每一行 + 回 marker），用来验串口的 marker 协议 |
| `adb-forward.py` | 把本机 `127.0.0.1:5037` 转发到**宿主**的 adb server——让沙箱里的应用能连到 USB 上的真板子，**应用代码一行不用改** |
| `linux-natives.sh` | 共享 `node_modules` 里的原生模块恢复成 Linux 能用的样子（**两边共享一个 node_modules，原生模块按平台编译，会打架**） |

## 怎么用

```bash
# 依赖：Linux 版 Electron 二进制、Xvfb、GTK 运行库（LD_LIBRARY_PATH）
bash scripts/acceptance/run-app.sh 你的脚本.mjs
```

`run-app.sh` 会起 Xvfb + Electron，然后跑你的脚本；脚本结束后收摊。

## 前提与限制（**别把它当成万能的**）

- **只适用于 Linux 沙箱**。Windows 上 `npm run dev` 直接开窗口，不需要这套。
- Electron 的 **Linux 二进制不在 npm 包里**（`postinstall` 才下载）。
  没下载过就 `node node_modules/electron/install.js`（或用 `npmmirror.com/mirrors/electron/` 镜像，慢很多）。
- `fake-console.py` 认 **CR 与 LF 两种行尾**——node-serialport 会把串口设成原始模式
  （`ICRNL` 关掉），所以回车键发来的 `\r` **不会**被转成 `\n`。
- `adb-forward.py` 的两个方向**各自半关**（`shutdown`），不能有一边结束就把整个 socket 关掉——
  否则**长驻的 `adb shell` 会话会在第二条命令进来时被连带杀掉**
  （看起来像应用的 bug，其实是转发器的锅）。

## 判定「验收真的过了」的标准

**驱动脚本必须读到真实状态**，不是「没报错就算过」。
2026-11-13 那次就是这么抓到一个评审没看出来的 bug：
板子的 shell 是 bash，而会话环境脚本里多带了一个 CR →
`/bin/bash: line 3: $'\r': command not found`。
—— 评审读代码读不出来，只有真机跑才看得见。
