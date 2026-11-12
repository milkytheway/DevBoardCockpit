import { describe, it, expect } from 'vitest';
import { terminalEnvScript } from '../../src/main/hal/session-env';

describe('terminalEnvScript', () => {
  it('导出 TERM=xterm-256color（事实 A2）', () => {
    expect(terminalEnvScript()).toContain('export TERM=xterm-256color');
  });
  it('用 shell 函数而不是 alias（事实 A3）', () => {
    const s = terminalEnvScript();
    expect(s).toContain('ls() { command ls -C --color=always "$@"; }');
    expect(s).not.toMatch(/^alias /m);
  });
});
