#!/bin/bash
# 在**沙箱（Linux）**里加依赖，**不破坏共享的 node_modules**。
#
# ── 为什么要有这个脚本 ──
#
# 沙箱（Linux）与 Windows 宿主**共享同一个 `node_modules`**（同一个目录！）。
# 而 npm 的 `optionalDependencies` 是**按平台安装**的：
#
# | | 宿主要 | 沙箱要 |
# |---|---|---|
# | `@esbuild/win32-x64` | ✓ | ✗ |
# | `@esbuild/linux-x64` | ✗ | ✓ |
# | `@rollup/rollup-win32-x64-gnu` | ✓ | ✗ |
# | `@rollup/rollup-linux-x64-gnu` | ✗ | ✓ |
#
# → 在 Linux 上跑一次 `npm install`，npm 会把**宿主那一半当成多余的剪掉**，
# 宿主上 `vitest` / `tsx` 就起不来（反过来一样）。
# 于是每次装依赖都得**手工来回**：`backup` → install → `restore`。
#
# ── 这个脚本干什么 ──
#
# **沙箱侧永远不直接 `npm install`**：
#
# ① 在**隔离前缀**里装（`/tmp` 下的独立目录）→ **共享树一个字节都不碰**
# ② 只把**缺的**包拷进共享树（已存在的、版本够用的不动）
# ③ `npm pkg set` 把依赖写进 `package.json`
# ④ `npm install --package-lock-only` 更新 `package-lock.json`
#    （**只改 lock 文件，不动 node_modules**；lock 里两边的平台包都记着 ✓）
#
# ── 宿主侧 ──
#
# 宿主自己装（`npm install`）之后，跑：
#
# ```powershell
# bash scripts/acceptance/linux-natives.sh restore   # 把 Linux 的平台包补回来
# ```
#
# （Windows 上跑不了这个脚本的 `backup`/`restore` 分支——它会删 `node-pty/build/`，
# 那会毁掉宿主的产物。**在 Windows 上要用 PowerShell 版的**，
# 见 `docs/17-现状总账.md` §「共享 node_modules 的平台冲突」。）
#
# ── 用法 ──
#
# ```bash
# bash scripts/acceptance/add-dep.sh react-grid-layout@1.4.4
# bash scripts/acceptance/add-dep.sh --dry-run react-grid-layout@1.4.4   # 只看会做什么
# ```

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ "$(uname -s)" != "Linux" ]; then
  echo "这个脚本只在 Linux 沙箱侧用（宿主直接 npm install 即可）。"
  exit 1
fi

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

if [ $# -lt 1 ]; then
  echo "用法：bash scripts/acceptance/add-dep.sh [--dry-run] <pkg>[@version] [...]"
  exit 1
fi

PREFIX="$(mktemp -d /tmp/add-dep-XXXXXX)"
echo "== 1/4 隔离前缀安装（不碰共享树）：$PREFIX"
npm install --prefix "$PREFIX" --no-audit --no-fund --ignore-scripts "$@"

echo "== 2/4 拷进共享树（只拷缺的）"
copied=0
for dir in "$PREFIX"/node_modules/*; do
  name="$(basename "$dir")"
  [ -d "$dir" ] || continue
  # 作用域包（@types/…）：逐个处理
  if [ "${name#@}" != "$name" ]; then
    mkdir -p "node_modules/$name"
    for sub in "$dir"/*; do
      subname="$(basename "$sub")"
      if [ ! -d "node_modules/$name/$subname" ]; then
        echo "   拷入 $name/$subname"
        cp -r "$sub" "node_modules/$name/"
        copied=$((copied + 1))
      fi
    done
    continue
  fi
  if [ -d "node_modules/$name" ]; then
    echo "   已有，跳过 $name"
    continue
  fi
  echo "   拷入 $name"
  cp -r "$dir" node_modules/
  copied=$((copied + 1))
done
echo "   共拷入 $copied 个包"

if [ "$DRY_RUN" = "1" ]; then
  echo "== dry-run：不改 package.json，也不改 lock"
  rm -rf "$PREFIX"
  exit 0
fi

echo "== 3/4 写进 package.json"
for spec in "$@"; do
  name="${spec%@*}"
  version="${spec#*@}"
  if [ "$name" = "$version" ]; then
    version="$(node -p "require('$PREFIX/node_modules/$name/package.json').version")"
  fi
  npm pkg set "dependencies.$name=$version"
  echo "   dependencies.$name = $version"
done

echo "== 4/4 更新 package-lock.json（只改 lock，不动 node_modules）"
npm install --package-lock-only --ignore-scripts --no-audit --no-fund

rm -rf "$PREFIX"
echo
echo "完成。宿主那边**不用**再装（包已经在共享树里）；"
echo "但宿主若要自己 npm install，装完记得跑 scripts/acceptance/linux-natives.sh restore。"
