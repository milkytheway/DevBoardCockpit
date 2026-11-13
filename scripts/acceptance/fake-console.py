#!/usr/bin/env python3
"""一块「假板子」：在 pty 的另一端扮演串口控制台。

行为照真板子（事实 S2/S4/S6）：
- **回显**收到的每一行（getty 自己回显）
- 收到 `cmd; echo MARKER` 时，先回显整行（marker 第一次出现），
  再打印命令的输出，最后打印 MARKER（第二次出现）
这样 `serial.ts` 的 marker 认领逻辑就能在**真的串口设备**上跑一遍。

用法：fake-console.py <slave-path-file>
"""
import os, pty, re, select, sys, threading

MARKER = re.compile(r';\s*echo\s+(__DBC\d+_\d+__)')

def console(master):
    buf = b''
    while True:
        try:
            r, _, _ = select.select([master], [], [], 0.5)
        except OSError:
            return
        if not r:
            continue
        try:
            data = os.read(master, 4096)
        except OSError:
            return
        if not data:
            return
        buf += data
        # **行尾是 CR 还是 LF 都要认**：
        # node-serialport 把串口设成**原始模式**（ICRNL 关掉），
        # 所以回车键发来的 `\r` **不会**被转成 `\n`——
        # 只认 `\n` 的话，假板子永远等不到一行完整的命令。
        while b'\n' in buf or b'\r' in buf:
            idx_n = buf.find(b'\n')
            idx_r = buf.find(b'\r')
            if idx_n < 0 or (0 <= idx_r < idx_n):
                cut, buf = buf[:idx_r], buf[idx_r + 1:]
            else:
                cut, buf = buf[:idx_n], buf[idx_n + 1:]
            line = cut.rstrip(b'\r')
            m = MARKER.search(line.decode('utf-8', 'replace'))
            cmd = line.decode('utf-8', 'replace')
            if not m:
                # 不是命令：只回显（真板子也是这样）
                os.write(master, line + b'\r\n')
                continue
            marker = m.group(1)
            cmd_text = cmd[:m.start()]
            # 回显整行（marker 第一次出现）
            os.write(master, line + b'\r\n')
            # 命令的输出
            os.write(master, b'fake-board-ok\r\n')
            # echo 的输出（marker 第二次出现）
            os.write(master, marker.encode() + b'\r\n')

master, slave = pty.openpty()
slave_name = os.ttyname(slave)
with open(sys.argv[1], 'w') as f:
    f.write(slave_name)
print('虚拟串口:', slave_name, flush=True)
t = threading.Thread(target=console, args=(master,), daemon=True)
t.start()
try:
    while True:
        threading.Event().wait(1)
except KeyboardInterrupt:
    pass
