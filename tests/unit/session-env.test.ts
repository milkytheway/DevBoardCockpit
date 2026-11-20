import { describe, it, expect } from 'vitest';
import { terminalEnvScript } from '../../src/main/hal/session-env';

describe('terminalEnvScript', () => {
  it('it exports TERM=xterm-256color (fact A2)', () => {
    expect(terminalEnvScript()).toContain('export TERM=xterm-256color');
  });
  it('it uses a shell function and not an alias (fact A3)', () => {
    const s = terminalEnvScript();
    expect(s).toContain('ls() { command ls -C --color=always "$@"; }');
    expect(s).not.toMatch(/^alias /m);
  });
});
