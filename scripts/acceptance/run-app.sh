#!/bin/bash
# 在无显示器的 Linux 沙箱里跑起应用，并用 CDP 驱动它。
#
# **为什么需要它**：验收清单里大部分是「点按钮、看屏幕」——
# 自动化不了就只剩「人肉点」。而 CDP（Chrome DevTools Protocol）
# 能从外面驱动真实渲染进程：读 DOM、点按钮、敲键盘。
#
# 依赖：
#   - Linux 版 Electron 二进制（node_modules/electron/dist/electron）
#   - Xvfb（虚拟显示）
#   - GTK 等运行库（在 LD_LIBRARY_PATH 里）
#
# 用法：bash scripts/acceptance/run-app.sh <要跑的脚本.mjs>
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

export LD_LIBRARY_PATH="${EXTRA_LD_LIBRARY_PATH:-}:$LD_LIBRARY_PATH"

DISP_NUM=$((70 + RANDOM % 20))
Xvfb ":$DISP_NUM" -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
READY_X=0
for _ in $(seq 1 40); do
  if [ -S "/tmp/.X11-unix/X$DISP_NUM" ] && DISPLAY=":$DISP_NUM" xdpyinfo >/dev/null 2>&1; then
    READY_X=1; break
  fi
  sleep 0.4
done
if [ "$READY_X" != "1" ]; then
  echo "Xvfb 没起来" >&2; cat /tmp/xvfb.log >&2
  kill "$XVFB_PID" 2>/dev/null; exit 1
fi

cd "$ROOT"
# **Linux 版 Electron 不在 node_modules 里**——
# node_modules 是与 Windows 宿主**共享**的，放 Linux 二进制会挡住
# 宿主 `npm install` 下 Windows 版（那一步在 Windows 上是必须的）。
ELECTRON_BIN="${ELECTRON_BIN:-/tmp/electron-linux/dist/electron}"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "找不到 Linux 版 Electron：$ELECTRON_BIN" >&2
  echo "从 https://npmmirror.com/mirrors/electron/ 下对应版本，解到那里即可。" >&2
  kill "$XVFB_PID" 2>/dev/null; exit 1
fi
DISPLAY=":$DISP_NUM" ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
  "$ELECTRON_BIN" . \
  --remote-debugging-port=9222 --no-sandbox --disable-gpu >/tmp/electron.log 2>&1 &
EL_PID=$!
READY=0
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1 && { READY=1; break; }
  sleep 0.5
done
if [ "$READY" != "1" ]; then
  echo "CDP 没起来：" >&2; tail -6 /tmp/electron.log >&2
  kill "$EL_PID" "$XVFB_PID" 2>/dev/null; exit 1
fi

node "$1"
RC=$?
kill "$EL_PID" "$XVFB_PID" 2>/dev/null
exit $RC
