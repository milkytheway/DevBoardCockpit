#!/usr/bin/env python3
"""把本机 127.0.0.1:5037 转发到宿主机的 adb server。

应用的 adb 客户端默认连 127.0.0.1:5037（`adbArgs` 不带 -H），
所以只要在沙箱里把 5037 转发到宿主（192.168.136.1:5037），
**应用代码一行不用改**就能连到真板子。

**两个方向必须各自半关（shutdown），不能有一边结束就把整个 socket 关掉。**
第一版在「客户端发完命令后关掉写方向」时就关了两边，
于是**长驻的 `adb shell` 会话在第二条命令进来时被连带杀掉**——
看起来像应用的 bug，其实是转发器的锅。
"""
import socket, threading, sys

LISTEN = ('127.0.0.1', int(os.environ.get('LOCAL_ADB_PORT', '5037')))
# 宿主的 adb server 地址。**机器专属的值不进代码**（AGENTS.md §3）：
# 用 BOARD_ADB_HOST / BOARD_ADB_PORT 覆盖，默认值只是这台机器当时的地址。
TARGET = (os.environ.get('BOARD_ADB_HOST', '192.168.136.1'),
          int(os.environ.get('BOARD_ADB_PORT', '5037')))

def handle(conn):
    try:
        up = socket.create_connection(TARGET, timeout=20)
    except OSError as e:
        print(f'转发失败: {e}', file=sys.stderr)
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
            # 只半关这一侧：让对端知道「这边没数据了」，但不拆连接
            try: dst.shutdown(socket.SHUT_WR)
            except OSError: pass
            done.release()

    def closer():
        # 两个方向都结束，才真的关 socket
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
print(f'转发 {LISTEN} -> {TARGET}', flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
