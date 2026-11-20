#!/bin/bash
# Adds a dependency in the **sandbox (Linux)** without **breaking the shared
# node_modules**.
#
# ── Why this script exists ──
#
# The sandbox (Linux) and the Windows host **share one `node_modules`** (the
# very same directory!). And the `optionalDependencies` of npm are
# **installed per platform**:
#
# | | the host needs it | the sandbox needs it |
# |---|---|---|
# | `@esbuild/win32-x64` | ✓ | ✗ |
# | `@esbuild/linux-x64` | ✗ | ✓ |
# | `@rollup/rollup-win32-x64-gnu` | ✓ | ✗ |
# | `@rollup/rollup-linux-x64-gnu` | ✗ | ✓ |
#
# → One `npm install` on Linux makes npm **prune the half that the host
# needs**, and then `vitest` / `tsx` do not start on the host (and the other
# way round).
# So every install has to **go back and forth by hand**: `backup` → install →
# `restore`.
#
# ── What this script does ──
#
# **The sandbox side never runs `npm install` directly**:
#
# ① it installs into an **isolated prefix** (a separate directory under
#   `/tmp`) → **not a single byte of the shared tree is touched**
# ② it copies only the **missing** packages into the shared tree (the ones
#   that are there with a good enough version stay)
# ③ `npm pkg set` writes the dependency into `package.json`
# ④ `npm install --package-lock-only` updates `package-lock.json`
#    (**only the lock file changes, node_modules is left alone**; the lock
#    records the platform packages of both sides)
#
# ── The host side ──
#
# After the host installed on its own (`npm install`), run:
#
# ```powershell
# bash scripts/acceptance/linux-natives.sh restore   # put the Linux platform packages back
# ```
#
# (The `backup`/`restore` branches of that script cannot run on Windows —
# they delete `node-pty/build/`, and that would destroy the artefact of the
# host. **On Windows the PowerShell version has to be used**.)
#
# ── Usage ──
#
# ```bash
# bash scripts/acceptance/add-dep.sh react-grid-layout@1.4.4
# bash scripts/acceptance/add-dep.sh --dry-run react-grid-layout@1.4.4   # only show what it would do
# ```

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ "$(uname -s)" != "Linux" ]; then
  echo "this script is only for the Linux sandbox side (the host just runs npm install)."
  exit 1
fi

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

if [ $# -lt 1 ]; then
  echo "Usage: bash scripts/acceptance/add-dep.sh [--dry-run] <pkg>[@version] [...]"
  exit 1
fi

PREFIX="$(mktemp -d /tmp/add-dep-XXXXXX)"
echo "== 1/4 the install into the isolated prefix (the shared tree is not touched): $PREFIX"
npm install --prefix "$PREFIX" --no-audit --no-fund --ignore-scripts "$@"

echo "== 2/4 copy into the shared tree (only what is missing)"
copied=0
for dir in "$PREFIX"/node_modules/*; do
  name="$(basename "$dir")"
  [ -d "$dir" ] || continue
  # a scoped package (@types/…): every sub package on its own
  if [ "${name#@}" != "$name" ]; then
    mkdir -p "node_modules/$name"
    for sub in "$dir"/*; do
      subname="$(basename "$sub")"
      if [ ! -d "node_modules/$name/$subname" ]; then
        echo "   copying in $name/$subname"
        cp -r "$sub" "node_modules/$name/"
        copied=$((copied + 1))
      fi
    done
    continue
  fi
  if [ -d "node_modules/$name" ]; then
    echo "   it is there, skipping $name"
    continue
  fi
  echo "   copying in $name"
  cp -r "$dir" node_modules/
  copied=$((copied + 1))
done
echo "   $copied packages were copied in"

if [ "$DRY_RUN" = "1" ]; then
  echo "== dry-run: neither package.json nor the lock is changed"
  rm -rf "$PREFIX"
  exit 0
fi

echo "== 3/4 write it into package.json"
for spec in "$@"; do
  name="${spec%@*}"
  version="${spec#*@}"
  if [ "$name" = "$version" ]; then
    version="$(node -p "require('$PREFIX/node_modules/$name/package.json').version")"
  fi
  npm pkg set "dependencies.$name=$version"
  echo "   dependencies.$name = $version"
done

echo "== 4/4 update package-lock.json (only the lock changes, node_modules is left alone)"
npm install --package-lock-only --ignore-scripts --no-audit --no-fund

rm -rf "$PREFIX"
echo
echo "Done. The host does **not** have to install anything (the packages are in the shared tree already);"
echo "but if the host runs its own npm install, run scripts/acceptance/linux-natives.sh restore afterwards."
