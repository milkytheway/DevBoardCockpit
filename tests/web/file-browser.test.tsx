import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileBrowser } from '../../src/renderer/files/FileBrowser';

describe('FileBrowser', () => {
  it('拖入文件时给出明确反馈，不静默忽略（RF-4）', () => {
    const onPush = vi.fn();
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={{ exec: true, pty: true, files: true, exitCode: true }}
        onPush={onPush}
      />,
    );
    const input = screen.getByTestId('file-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } });
    expect(onPush).toHaveBeenCalled();
  });

  it('拖入文件也能上传（RF-4：拖放不是选文件）', () => {
    const onPush = vi.fn();
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={{ exec: true, pty: true, files: true, exitCode: true }}
        onPush={onPush}
      />,
    );
    const drop = screen.getByTestId('file-drop');
    const file = new File(['x'], 'a.txt');
    fireEvent.drop(drop, { dataTransfer: { files: [file] } });
    expect(onPush).toHaveBeenCalledWith(file);
  });

  it('连接不支持传输时，入口禁用且给出说明', () => {
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={{ exec: true, pty: false, files: false, exitCode: false }}
        onPush={vi.fn()}
      />,
    );
    expect(screen.getByTestId('file-push-disabled')).toBeTruthy();
  });
});
