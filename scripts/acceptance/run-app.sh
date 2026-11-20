#!/bin/bash
# Starts the application in a Linux sandbox without a display and drives it
# with CDP.
#
# **Why it is needed**: most of the acceptance list is "click the button, look
# at the screen" — without automation only "a human clicking" is left. And CDP
# (Chrome DevTools Protocol) can drive the real renderer from the outside: read
# the DOM, click the buttons, type the keys.
#
# The dependencies:
#   - the Linux binary of Electron (node_modules/electron/dist/electron)
#   - Xvfb (the virtual display)
#   - the GTK runtime and the like (in LD_LIBRARY_PATH)
#
# Usage: bash scripts/acceptance/run-app.sh <the script to run.mjs>
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
  echo "Xvfb did not start" >&2; cat /tmp/xvfb.log >&2
  kill "$XVFB_PID" 2>/dev/null; exit 1
fi

cd "$ROOT"
# **The Linux binary of Electron is not in node_modules** — the node_modules
# is **shared** with the Windows host, and the Linux binary there would keep
# the host `npm install` from fetching the Windows one (that step is
# mandatory on Windows).
ELECTRON_BIN="${ELECTRON_BIN:-/tmp/electron-linux/dist/electron}"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "the Linux binary of Electron was not found: $ELECTRON_BIN" >&2
  echo "Download the matching version from https://npmmirror.com/mirrors/electron/ and unpack it there." >&2
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
  echo "CDP did not start:" >&2; tail -6 /tmp/electron.log >&2
  kill "$EL_PID" "$XVFB_PID" 2>/dev/null; exit 1
fi

node "$1"
RC=$?
kill "$EL_PID" "$XVFB_PID" 2>/dev/null
exit $RC
