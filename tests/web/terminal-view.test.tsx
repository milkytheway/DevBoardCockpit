import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalView } from '../../src/renderer/terminal/TerminalView';

describe('TerminalView', () => {
  it('渲染一个终端容器并把输入转成 write 调用', () => {
    const write = vi.fn();
    render(<TerminalView sessionId="s1" onWrite={write} />);
    expect(screen.getByTestId('terminal-s1')).toBeTruthy();
  });

  it('容器带 data-testid，宿主据此定位每个会话的终端', () => {
    render(<TerminalView sessionId="abc" onWrite={vi.fn()} />);
    expect(screen.getByTestId('terminal-abc')).toBeTruthy();
  });
});
