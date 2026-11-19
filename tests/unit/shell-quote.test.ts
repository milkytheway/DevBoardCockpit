import { describe, it, expect } from 'vitest';
import { quotePath } from '../../src/main/util/shell-quote';

/**
 * 路径进 shell 命令前的转义。
 *
 * **它守的是一条注入边界**（AGENTS.md §6：「❌ 把参数原样拼进命令」）：
 * 路径里带 `;` 就能塞进第二条命令。
 *
 * 远端路径将来会由**卡片与 MCP** 传进来——那是外部输入。
 */
describe('quotePath', () => {
  it('单引号包裹整条路径', () => {
    expect(quotePath('/root/a.txt')).toBe("'/root/a.txt'");
  });

  it('路径里的单引号按 POSIX 方式转义', () => {
    // ' → '\''
    expect(quotePath("/root/it's.txt")).toBe("'/root/it'\\''s.txt'");
  });

  it('空格与分号不会逃出去', () => {
    const quoted = quotePath("/root/a b; rm -rf /");
    // 整条被单引号包住，分号在里面不是命令分隔符
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toContain('; rm -rf /');
  });

  it('路径里有换行就拒掉 —— 换行就是第二条命令', () => {
    expect(() => quotePath('/root/a\nrm -rf /')).toThrow(/newline/);
    expect(() => quotePath('/root/a\rrm -rf /')).toThrow(/newline/);
  });

  it('路径里有空字节也拒掉', () => {
    expect(() => quotePath('/root/a\0b')).toThrow(/NUL/);
  });

  it('错误是 AppError，带错误码', () => {
    try {
      quotePath('/a\nb');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'IPC_INVALID_PAYLOAD' });
    }
  });
});
