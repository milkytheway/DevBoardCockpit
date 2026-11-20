#!/bin/bash
# Puts the native modules of the shared node_modules back into the shape in
# which the "sandbox (Linux)" can use them.
#
# ── Why this script exists ──
#
# **The sandbox and the Windows host share one `node_modules`** (the very same
# directory!). And the native modules are **compiled per platform** — the two
# sides need different things:
#
# | Package | Linux | Windows | Do they clash |
# |---|---|---|---|
# | `@serialport/bindings-cpp` | `prebuilds/linux-x64` | `prebuilds/win32-x64` | **no** (NAPI, the ABI is stable) |
# | `node-pty` | **no linux prebuild**, it has to be compiled | `prebuilds/win32-x64` | **yes** |
#
# The search order of `node-gyp-build` is `build/Release` → `build/Debug` →
# `prebuilds/<platform>`. So **whichever platform the artefact in `build/`
# was built for decides whether the other side can use it**.
#
# ── The rule ──
#
# - **The sandbox (Linux) side**: run this script → `build/` holds the Linux
#   artefact.
# - **The Windows side**: after `npm install` / `electron-rebuild`,
#   **delete `node_modules/node-pty/build/`** → it falls back to
#   `prebuilds/win32-x64` (NAPI, the ABI is stable, **no rebuild is
#   needed**).
#   (serialport does not need any of this — its `build/` is already deleted,
#   and the two sides each take their own prebuild.)
#
# The price: every time the Windows side installs a dependency, the
# `node-pty/build/` has to be deleted once more.
# That is the inherent price of "one node_modules across two platforms" —
# **the better way is one node_modules per side.**

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PTY="node_modules/node-pty"
SPT="node_modules/@serialport/bindings-cpp"

if [ "$(uname -s)" != "Linux" ]; then
  echo "this script is only for the Linux sandbox side (it deletes build/ — on Windows that would destroy the artefact of the host)."
  exit 1
fi

# ── The native packages that belong to a platform (the optionalDependencies
#    of npm) ──
#
# The **platform binary of a package like esbuild / rollup is an
# optionalDependency** — npm only installs **the one of the current
# platform**.
# What the sandbox (Linux) installed, the host (Windows) does not have → on
# the host tsx/vite reports "@esbuild/win32-x64 could not be found".
#
# So: **before the host runs npm install the Linux ones are backed up**, and
# after the install they are copied back. Each side has its own, and they do
# not disturb each other.
#
# Usage:
#   bash scripts/acceptance/linux-natives.sh backup   # back up (before the host installs)
#   bash scripts/acceptance/linux-natives.sh restore  # restore (after the host installed)

CACHE="$ROOT/.cache/linux-native"
TARBALL="$CACHE/linux-native.tgz"

backup_platform_pkgs() {
  mkdir -p "$CACHE"
  local list
  # Looks for the **optionalDependency packages that belong to a platform**
  # (@esbuild/<platform>, @rollup/rollup-<platform>…).
  # @serialport and node-pty are excluded — they **carry both platforms in one
  # package**, they are not optional dependencies.
  list=$(find node_modules -type d \( -name "*linux-x64*" -o -name "*linux-arm64*" \) 2>/dev/null \
    | grep -v "node_modules/@serialport/" | grep -v "node_modules/node-pty/")
  if [ -z "$list" ]; then
    echo "  there is no Linux platform package to back up"
    return 0
  fi
  # Watch the order of the tar options: **-C has to come before --files-from**
  # (otherwise it is only an ordinary argument)
  echo "$list" | tr "\n" "\0" | tar --null -czf "$TARBALL" -C "$ROOT" --files-from=-
  echo "  $(echo "$list" | wc -l) Linux platform packages were backed up → $TARBALL"
}

restore_platform_pkgs() {
  if [ ! -f "$TARBALL" ]; then
    echo "  there is no backup ($TARBALL), skipping"
    return 0
  fi
  tar -xzf "$TARBALL" -C "$ROOT"
  echo "  the Linux platform packages were restored from $TARBALL"
}

case "${1:-restore}" in
  backup)  backup_platform_pkgs; exit 0 ;;
  restore) restore_platform_pkgs ;;
esac

echo "=== 1) serialport: delete build/, so that the two sides each take their own NAPI prebuild ==="
if [ -d "$SPT/build" ]; then
  rm -rf "$SPT/build"
  echo "  $SPT/build was deleted"
else
  echo "  build/ was not there anyway"
fi

echo
echo "=== 2) node-pty: the sandbox needs the Linux build artefact ==="
if [ -d "$PTY/build.bak-linux" ]; then
  rm -rf "$PTY/build"
  mv "$PTY/build.bak-linux" "$PTY/build"
  echo "  it was restored from build.bak-linux (Linux ELF)"
elif [ -f "$PTY/build/Release/pty.node" ] && file "$PTY/build/Release/pty.node" | grep -q ELF; then
  echo "  build/ is already the Linux one"
elif [ -f "$PTY/build/Release/pty.node" ]; then
  echo "  build/ is the Windows one → it has to be compiled (see below)"
else
  echo "  build/ does not exist → it has to be compiled (see below)"
fi

echo
echo "=== 3) the self-check ==="
node -e "
for (const m of ['@serialport/bindings-cpp', 'node-pty', 'esbuild']) {
  try { require(m); console.log('  ' + m + ' loads'); }
  catch (e) { console.log('  ' + m + ' does not load: ' + String(e.message).split('\n')[0]); }
}
"
