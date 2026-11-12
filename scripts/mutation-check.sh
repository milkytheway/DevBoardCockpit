#!/usr/bin/env bash
# 变异测试：证明这些回归测试**真的在守**着修好的东西。
#
# 为什么需要它：整支评审修完 6 条 Critical 后，其中 2 条（C1 串口端口不开、
# C4 终端输出重复渲染）**没有任何测试守着**——把修复改回去，整个套件仍然全绿。
# 「测试通过」和「测试能抓住这个 bug」是两件事，只有变异能区分。
#
# 做法：把修复改回坏的样子 → 跑对应的测试 → **必须变红** → 还原 → 必须变绿。
#
# 用法（在仓库根目录）：
#   bash scripts/mutation-check.sh
#
# 退出码 0 = 全部守住；非 0 = 有测试形同虚设。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
BACKUP="$(mktemp -d)"
trap 'rm -rf "$BACKUP"' EXIT

# 把文件改坏 → 跑测试 → 还原
mutate() {
  local name="$1" file="$2" testfile="$3" mutation_script="$4"

  cp "$file" "$BACKUP/$(basename "$file")"
  if ! python3 "$mutation_script"; then
    echo "✗ $name：变异脚本本身出错"
    FAIL=$((FAIL + 1))
    return
  fi

  local out rc
  out="$(npx vitest run "$testfile" 2>&1)"
  rc=$?

  # 还原
  cp "$BACKUP/$(basename "$file")" "$file"

  if [ "$rc" -eq 0 ]; then
    echo "✗ $name：改坏之后测试**仍然全绿** —— 这个测试形同虚设"
    FAIL=$((FAIL + 1))
  else
    echo "✓ $name：改坏之后测试变红（守住了）"
    PASS=$((PASS + 1))
  fi
}

echo "=== 变异测试：验证回归测试真的在守 ==="
echo

# C1 · 串口端口不开 → 第一次按键崩主进程
mutate "C1 串口端口真的打开" \
  "src/main/hal/serial.ts" \
  "tests/unit/serial-real-factory.test.ts" \
  "scripts/mutations/c1-serial-no-open.py"

# C2 · marker 协议写三行 → exec 返回命令文本而非输出
mutate "C2 marker 单行协议" \
  "src/main/hal/serial.ts" \
  "tests/unit/serial.test.ts" \
  "scripts/mutations/c2-serial-three-lines.py"

# C3 · SSH 的 shell() 当成同步的 → SSH 终端开不起来
mutate "C3 SSH shell 异步" \
  "src/main/hal/ssh.ts" \
  "tests/unit/ssh.test.ts" \
  "scripts/mutations/c3-ssh-sync.py"

# C4 · 终端输出累积重放 → 屏幕上是重复文本
mutate "C4 终端输出不重放历史" \
  "src/renderer/terminal/TerminalView.tsx" \
  "tests/web/terminal-view.test.tsx" \
  "scripts/mutations/c4-terminal-replay.py"

# C5 · 文件互传跑远端 pull → 板子上没这个命令
mutate "C5 文件互传按传输分派" \
  "src/main/files/transfer.ts" \
  "tests/unit/file-transfer.test.ts" \
  "scripts/mutations/c5-transfer-remote-cmd.py"

# C6 · renderer 吞掉错误 → 「串口被占用」用户看不到
mutate "C6 renderer 呈现错误" \
  "src/renderer/App.tsx" \
  "tests/web/app-error.test.tsx" \
  "scripts/mutations/c6-no-error-display.py"

echo
echo "=== 结果：守住 $PASS 项，形同虚设 $FAIL 项 ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
