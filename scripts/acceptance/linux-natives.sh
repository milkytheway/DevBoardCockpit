#!/bin/bash
# 把共享 node_modules 里的原生模块，恢复成「沙箱（Linux）能用」的样子。
#
# ── 为什么需要这个脚本 ──
#
# **沙箱与 Windows 宿主共享同一个 `node_modules`**（同一个目录！）。
# 而原生模块是**按平台编译**的——两边要的东西不一样：
#
# | 包 | Linux | Windows | 冲突吗 |
# |---|---|---|---|
# | `@serialport/bindings-cpp` | `prebuilds/linux-x64` ✓ | `prebuilds/win32-x64` ✓ | **不冲突**（NAPI，ABI 稳定） |
# | `node-pty` | **没有 linux prebuild**，只能自己编 | `prebuilds/win32-x64` ✓ | **冲突** |
#
# `node-gyp-build` 的查找顺序是 `build/Release` → `build/Debug` → `prebuilds/<platform>`。
# 所以 **`build/` 里放的是哪个平台的产物，就决定了另一侧能不能用**。
#
# ── 规矩 ──
#
# - **沙箱（Linux）侧**：跑这个脚本 → `build/` 放 Linux 产物。
# - **Windows 侧**：`npm install` / `electron-rebuild` 之后，
#   **把 `node_modules/node-pty/build/` 删掉** → 它会回落到
#   `prebuilds/win32-x64`（NAPI，ABI 稳定，**不需要重编译**）。
#   （serialport 不用管——它的 `build/` 已经删了，两边各走各的 prebuild。）
#
# 代价：Windows 侧每装一次依赖，就要再删一次 `node-pty/build/`。
# 这就是「共享一个 node_modules 跨两个平台」的固有代价——
# **更好的做法是两边各有一份 node_modules。**

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PTY="node_modules/node-pty"
SPT="node_modules/@serialport/bindings-cpp"

PTTY="node_modules/node-pty"
SPT="node_modules/@serialport/bindings-cpp"

echo "=== 1) serialport：删掉 build/，让两边各走各的 NAPI prebuild ==="
if [ -d "$SPT/build" ]; then
  rm -rf "$SPT/build"
  echo "  已删 $SPT/build"
else
  echo "  build/ 本来就不在 ✓"
fi

echo
echo "=== 2) node-pty：沙箱需要 Linux 编译产物 ==="
if [ -d "$PTY/build.bak-linux" ]; then
  rm -rf "$PTY/build"
  mv "$PTY/build.bak-linux" "$PTY/build"
  echo "  已从 build.bak-linux 恢复（Linux ELF）"
elif [ -f "$PTY/build/Release/pty.node" ] && file "$PTY/build/Release/pty.node" | grep -q ELF; then
  echo "  build/ 已经是 Linux 版 ✓"
elif [ -f "$PTY/build/Release/pty.node" ]; then
  echo "  build/ 是 Windows 版 → 需要自己编（见下）"
else
  echo "  build/ 不存在 → 需要自己编（见下）"
fi

echo
echo "=== 3) 自检 ==="
node -e "
for (const m of ['@serialport/bindings-cpp', 'node-pty']) {
  try { require(m); console.log('  ' + m + ' 加载 ✓'); }
  catch (e) { console.log('  ' + m + ' 加载失败：' + String(e.message).split('\n')[0]); }
}
"
