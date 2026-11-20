#!/usr/bin/env python3
"""A "fake board": it plays the serial console at the other end of a pty.

It behaves like the real board (the facts S2/S4/S6):
- it **echoes** every line it receives (getty echoes on its own)
- on `cmd; echo MARKER` it first echoes the whole line (the marker appears
  for the first time), then it prints the output of the command, and at last
  it prints the MARKER (it appears for the second time)
That way the marker claiming logic of `serial.ts` can run once on a **real
serial device**.

Usage: fake-console.py <slave-path-file>
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
        # **A line ending is recognised whether it is CR or LF**:
        # node-serialport puts the serial port into **raw mode** (ICRNL off),
        # so the `\r` that the return key sends is **not** turned into `\n` —
        # if only `\n` is recognised, the fake board never gets a whole command.
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
                # not a command: only the echo (the real board does the same)
                os.write(master, line + b'\r\n')
                continue
            marker = m.group(1)
            cmd_text = cmd[:m.start()]
            # echo the whole line (the marker appears for the first time)
            os.write(master, line + b'\r\n')
            # the output of the command
            os.write(master, b'fake-board-ok\r\n')
            # the output of the echo (the marker appears for the second time)
            os.write(master, marker.encode() + b'\r\n')

master, slave = pty.openpty()
slave_name = os.ttyname(slave)
with open(sys.argv[1], 'w') as f:
    f.write(slave_name)
print('the virtual serial port:', slave_name, flush=True)
t = threading.Thread(target=console, args=(master,), daemon=True)
t.start()
try:
    while True:
        threading.Event().wait(1)
except KeyboardInterrupt:
    pass
