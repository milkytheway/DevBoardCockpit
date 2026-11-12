import { makeError } from '../../shared/errors';

/**
 * 路径进 shell 命令前的转义。
 *
 * **为什么要单引号包裹**：路径原样拼进 shell 命令时，
 * 路径里有空格就断，而 `;` 之类能让命令变成两条。
 *
 * **为什么只转义单引号还不够**：路径里如果有换行，
 * 它就是**第二条命令**——串口是「一次一行」的协议（事实 S6），
 * adb/ssh 是 shell。换行必须**拒掉**，不是转义掉：
 * 一个合法路径里不会有换行，出现了就是有人想塞第二条命令。
 *
 * 这个函数是**唯一**的一份（`hal/` 与 `files/` 都用它）——
 * 两份实现的差别只有这一行，方向错误的代价是整个分层失去意义。
 */
export function quotePath(path: string): string {
  if (/[\r\n\0]/.test(path)) {
    throw makeError('IPC_INVALID_PAYLOAD', '路径里有换行或空字符，拒绝拼进命令', {
      detail: { path },
    });
  }
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
