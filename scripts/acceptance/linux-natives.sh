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

if [ "$(uname -s)" != "Linux" ]; then
  echo "这个脚本只在 Linux 沙箱侧用（它会删掉 build/ —— 在 Windows 上那会毁掉宿主的产物）。"
  exit 1
fi

# ── 平台专属的原生包（npm 的 optionalDependencies）──
#
# esbuild / rollup 这类包的**平台二进制是 optionalDependencies**——
# npm 只会装**当前平台**的那一份。
# 沙箱（Linux）装的，宿主（Windows）就没有 → 宿主上 tsx/vite 报
# 「@esbuild/win32-x64 could not be found」。
#
# 所以：**宿主 npm install 之前先把 Linux 的那几份备份出来**，
# 装完再拷回来。两边各有一份，互不干扰。
#
# 用法：
#   bash scripts/acceptance/linux-natives.sh backup   # 备份（宿主 install 之前）
#   bash scripts/acceptance/linux-natives.sh restore  # 还原（宿主 install 之后）

CACHE="$ROOT/.cache/linux-native"
TARBALL="$CACHE/linux-native.tgz"

backup_platform_pkgs() {
  mkdir -p "$CACHE"
  local list
  # 找**平台专属的 optionalDependency 包**（@esbuild/<platform>、@rollup/rollup-<platform>…）。
  # 排除 @serialport 与 node-pty —— 它们**一个包里带着两个平台**，不是 optional dep。
  list=$(find node_modules -type d \( -name "*linux-x64*" -o -name "*linux-arm64*" \) 2>/dev/null \
    | grep -v "node_modules/@serialport/" | grep -v "node_modules/node-pty/")
  if [ -z "$list" ]; then
    echo "  没有 Linux 平台包可备份"
    return 0
  fi
  # 注意 tar 的选项顺序：**-C 必须在 --files-from 之前**（否则它只是个普通参数）
  echo "$list" | tr "\n" "\0" | tar --null -czf "$TARBALL" -C "$ROOT" --files-from=-
  echo "  已备份 $(echo "$list" | wc -l) 个 Linux 平台包 → $TARBALL"
}

restore_platform_pkgs() {
  if [ ! -f "$TARBALL" ]; then
    echo "  没有备份（$TARBALL），跳过"
    return 0
  fi
  tar -xzf "$TARBALL" -C "$ROOT"
  echo "  已从 $TARBALL 还原 Linux 平台包"
}

case "${1:-restore}" in
  backup)  backup_platform_pkgs; exit 0 ;;
  restore) restore_platform_pkgs ;;
esac

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
for (const m of ['@serialport/bindings-cpp', 'node-pty', 'esbuild']) {
  try { require(m); console.log('  ' + m + ' 加载 ✓'); }
  catch (e) { console.log('  ' + m + ' 加载失败：' + String(e.message).split('\n')[0]); }
}
"
