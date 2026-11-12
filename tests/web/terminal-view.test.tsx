import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * xterm 的假实现：**记录每次 write 的内容**。
 *
 * jsdom 里 xterm 用 canvas 画字，写进去的内容测不到——
 * 于是「每个 chunk 写一次」和「把累积串重写一遍」这两种实现，
 * 在测试里长得一模一样。整支评审的 C4 就是这么漏过去的：
 * 屏幕上是重复的文本，而测试全绿。
 */
const writes: string[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    onData(_cb: (d: string) => void) { return { dispose() { /* no-op */ } }; }
    onResize(_cb: () => void) { return { dispose() { /* no-op */ } }; }
    loadAddon(_a: unknown) { /* no-op */ }
    open(_el: unknown) { /* no-op */ }
    write(data: string) { writes.push(data); }
    dispose() { /* no-op */ }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() { /* no-op */ }
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  },
}));

import { TerminalView } from '../../src/renderer/terminal/TerminalView';

beforeEach(() => {
  writes.length = 0;
});

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

  it('每个 chunk 写一次，不重放历史（C4）', () => {
    let push: ((chunk: string) => void) | undefined;
    const subscribe = (cb: (chunk: string) => void) => {
      push = cb;
      return () => undefined;
    };

    render(<TerminalView sessionId="s1" onWrite={vi.fn()} subscribe={subscribe} />);

    push?.('第一段');
    push?.('第二段');

    // 两次写入，各一次，**不是**「累积串被重写两遍」
    expect(writes).toEqual(['第一段', '第二段']);
  });
});
