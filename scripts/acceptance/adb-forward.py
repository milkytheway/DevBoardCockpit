#!/usr/bin/env python3
"""Forwards the local 127.0.0.1:5037 to the adb server of the host.

The adb client of the application connects to 127.0.0.1:5037 by default
(`adbArgs` carries no -H), so as soon as 5037 is forwarded to the host
(192.168.136.1:5037) inside the sandbox, it reaches the real board
**without changing one line of the application code**.

**The two directions have to be half closed on their own (shutdown), one side
may not close the whole socket when it ends.**
The first version closed both sides as soon as "the client closed the writing
direction after it sent the command", and then **the long-lived `adb shell`
session was killed as well when the second command came in** — that looks like
a bug of the application, while it is the fault of the forwarder.
"""
import socket, threading, sys

LISTEN = ('127.0.0.1', int(os.environ.get('LOCAL_ADB_PORT', '5037')))
# The address of the adb server of the host. **A machine specific value does
# not go into the code** (AGENTS.md §3):
# Override it with BOARD_ADB_HOST / BOARD_ADB_PORT, the default is only the
# address that this machine had at the time.
TARGET = (os.environ.get('BOARD_ADB_HOST', '192.168.136.1'),
          int(os.environ.get('BOARD_ADB_PORT', '5037')))

def handle(conn):
    try:
        up = socket.create_connection(TARGET, timeout=20)
    except OSError as e:
        print(f'the forward failed: {e}', file=sys.stderr)
        conn.close()
        return
    up.settimeout(None)
    conn.settimeout(None)
    done = threading.Semaphore(0)

    def pipe(src, dst):
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            # Only this side is half closed: the other end learns "there is
            # no data here", but the connection is not torn down
            try: dst.shutdown(socket.SHUT_WR)
            except OSError: pass
            done.release()

    def closer():
        # Only when both directions have ended is the socket really closed
        done.acquire()
        done.acquire()
        for s in (conn, up):
            try: s.close()
            except OSError: pass

    threading.Thread(target=pipe, args=(conn, up), daemon=True).start()
    threading.Thread(target=pipe, args=(up, conn), daemon=True).start()
    threading.Thread(target=closer, daemon=True).start()

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(LISTEN)
srv.listen(16)
print(f'forwarding {LISTEN} -> {TARGET}', flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
