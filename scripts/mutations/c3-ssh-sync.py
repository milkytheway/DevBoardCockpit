"""把 SSH 的 shell() 改回同步检查（整支评审的 C3）。"""
p = 'src/main/hal/ssh.ts'
s = open(p, encoding='utf-8').read()

old = """  private openShell(cols: number, rows: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client!.shell({ term: 'xterm-256color', cols, rows }, (err, ch) => {
        if (err) {
          reject(makeError('CONN_OPEN_FAILED', `SSH 开 shell 失败：${err.message}`, {
            detail: { host: this.opts.host, cause: err.message },
          }));
          return;
        }
        resolve(ch);
      });
    });
  }"""

new = """  private openShell(cols: number, rows: number): Promise<ClientChannel> {
    let channel: ClientChannel | undefined;
    this.client!.shell({ term: 'xterm-256color', cols, rows }, (err, ch) => {
      if (err) throw makeError('CONN_OPEN_FAILED', `SSH 开 shell 失败：${err.message}`);
      channel = ch;
    });
    if (!channel) throw makeError('CONN_OPEN_FAILED', 'SSH 开 shell 失败：没有拿到通道');
    return Promise.resolve(channel);
  }"""

assert old in s, '没找到 openShell 的原文'
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('已变异：SSH shell 改回同步检查')
