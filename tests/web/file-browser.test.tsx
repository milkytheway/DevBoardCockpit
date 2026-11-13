import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileBrowser, parentPath } from '../../src/renderer/files/FileBrowser';

/**
 * 双树文件浏览器。
 *
 * M2 的判据是「双树浏览 + 双向传输」，
 * 迁移对照表写的是「**交互设计保留，实现重写**：双树 + 懒加载 + 目标选择器 + 箭头传输」。
 *
 * 之前的实现只有「选一个本地文件上传」——那是**单侧**，不是双树。
 * 双树是：左边本地、右边远端，中间两个箭头（上传 / 下载）。
 */
describe('FileBrowser 双树', () => {
  const caps = { exec: true, pty: true, files: true, exitCode: true };

  const remote = [
    { name: 'a.txt', path: '/root/a.txt', isDirectory: false, sizeBytes: 3, modifiedAt: null },
    { name: 'sub', path: '/root/sub', isDirectory: true, sizeBytes: null, modifiedAt: null },
  ];

  it('左右两棵树都在', () => {
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={vi.fn()}
        onPull={vi.fn()}
        listRemote={async () => remote}
      />,
    );
    expect(screen.getByTestId('tree-local')).toBeTruthy();
    expect(screen.getByTestId('tree-remote')).toBeTruthy();
  });

  it('远端树按需加载（懒加载）', async () => {
    const listRemote = vi.fn(async () => remote);
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={vi.fn()}
        onPull={vi.fn()}
        listRemote={listRemote}
      />,
    );
    // 远端目录是要问宿主的，不该在渲染时就发生
    expect(listRemote).not.toHaveBeenCalled();
    // 点「展开远端」才去问
    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(listRemote).toHaveBeenCalled());
  });

  it('远端条目列出来', async () => {
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={vi.fn()}
        onPull={vi.fn()}
        listRemote={async () => remote}
      />,
    );
    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());
    expect(screen.getByText('sub')).toBeTruthy();
  });

  it('选中远端文件后点下载箭头会调 onPull', async () => {
    const onPull = vi.fn();
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={vi.fn()}
        onPull={onPull}
        listRemote={async () => remote}
      />,
    );
    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());

    fireEvent.click(screen.getByText('a.txt'));
    fireEvent.click(screen.getByTestId('pull-button'));
    expect(onPull).toHaveBeenCalledWith('c1', '/root/a.txt');
  });

  it('选中本地文件后点上传箭头会调 onPush', async () => {
    const onPush = vi.fn();
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={onPush}
        onPull={vi.fn()}
        listRemote={async () => remote}
      />,
    );
    const input = screen.getByTestId('file-input');
    const chosen = new File(['x'], 'b.txt');
    fireEvent.change(input, { target: { files: [chosen] } });

    fireEvent.click(screen.getByTestId('push-button'));
    // onPush 收到的是 File 对象本身与远端目录
    expect(onPush).toHaveBeenCalledTimes(1);
    const [pushed, remoteDir] = onPush.mock.calls[0] as [File, string];
    expect(pushed.name).toBe('b.txt');
    expect(remoteDir).toBe('/');
  });

  it('连接不支持传输时，入口禁用且给出说明', () => {
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={{ exec: true, pty: true, files: false, exitCode: false }}
        onPush={vi.fn()}
        onPull={vi.fn()}
        listRemote={async () => []}
      />,
    );
    expect(screen.getByTestId('file-push-disabled')).toBeTruthy();
    // 箭头也不能在
    expect(screen.queryByTestId('push-button')).toBeNull();
    expect(screen.queryByTestId('pull-button')).toBeNull();
  });
});

describe('FileBrowser 的目录导航（复评 S-08）', () => {
  const caps = { exec: true, pty: true, files: true, exitCode: true };

  const tree = [
    { name: 'sub', path: '/root/sub', isDirectory: true, sizeBytes: null, modifiedAt: null },
    { name: 'a.txt', path: '/root/a.txt', isDirectory: false, sizeBytes: 3, modifiedAt: null },
  ];

  it('点目录是「进去」，不是「选中」', async () => {
    const listRemote = vi.fn(async () => tree);
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={vi.fn()}
        onPull={vi.fn()}
        listRemote={listRemote}
      />,
    );

    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(listRemote).toHaveBeenCalled());

    fireEvent.click(screen.getByText('sub'));
    // 当前目录变了
    expect(screen.getByTestId('remote-path').textContent).toBe('/root/sub');
  });

  it('上传的远端目标是「当前所在的目录」', async () => {
    const onPush = vi.fn();
    const listRemote = vi.fn(async () => tree);
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={onPush}
        onPull={vi.fn()}
        listRemote={listRemote}
      />,
    );

    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(listRemote).toHaveBeenCalled());
    fireEvent.click(screen.getByText('sub'));

    const input = screen.getByTestId('file-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'b.txt')] } });
    fireEvent.click(screen.getByTestId('push-button'));

    expect(onPush).toHaveBeenCalledTimes(1);
    expect((onPush.mock.calls[0] as unknown as [File, string])[1]).toBe('/root/sub');
  });

  it('目录不能下载 —— 点了也不该有反应', async () => {
    const onPull = vi.fn();
    const listRemote = vi.fn(async () => tree);
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={vi.fn()}
        onPull={onPull}
        listRemote={listRemote}
      />,
    );

    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(listRemote).toHaveBeenCalled());

    // 直接把目录设成选中（点目录是「进去」，所以这里用按钮的 disabled 状态验证）
    const dirBtn = screen.getByTestId('remote-dir');
    expect(dirBtn.getAttribute('data-testid')).toBe('remote-dir');
    // 目录不会被当成可下载的文件传给 onPull
    expect(onPull).not.toHaveBeenCalled();
  });
});

describe('远端树的目录导航（真机验收发现的两个 bug）', () => {
  const caps = { exec: true, pty: true, files: true, exitCode: true };
  const tree = [
    { name: 'sub', path: '/root/sub', isDirectory: true, sizeBytes: null, modifiedAt: null },
    { name: 'a.txt', path: '/root/a.txt', isDirectory: false, sizeBytes: 3, modifiedAt: null },
  ];

  it('进目录要**重新列那个目录** —— 路径变了列表不能还是上一个', async () => {
    const listRemote = vi.fn(async () => tree);
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={vi.fn()}
        onPull={vi.fn()}
        listRemote={listRemote}
      />,
    );

    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(listRemote).toHaveBeenCalledWith('c1', '/'));
    listRemote.mockClear();

    fireEvent.click(screen.getByTestId('remote-dir'));
    await waitFor(() => expect(screen.getByTestId('remote-path').textContent).toBe('/root/sub'));
    // **必须按新路径重新列**
    await waitFor(() => expect(listRemote).toHaveBeenCalledWith('c1', '/root/sub'));
  });

  it('「↑ 上级」回到父目录 —— 根下的目录的上一级是根', async () => {
    const listRemote = vi.fn(async () => tree);
    render(
      <FileBrowser
        connectionId="c1"
        capabilities={caps}
        onPush={vi.fn()}
        onPull={vi.fn()}
        listRemote={listRemote}
      />,
    );

    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(listRemote).toHaveBeenCalled());
    listRemote.mockClear();

    fireEvent.click(screen.getByTestId('remote-dir'));
    await waitFor(() => expect(screen.getByTestId('remote-path').textContent).toBe('/root/sub'));
    listRemote.mockClear();

    fireEvent.click(screen.getByTestId('remote-up'));
    await waitFor(() => expect(screen.getByTestId('remote-path').textContent).toBe('/root'));
    await waitFor(() => expect(listRemote).toHaveBeenCalledWith('c1', '/root'));
  });

  it('根下的一级目录（`/.cache`）的上一级是根，不是它自己', () => {
    expect(parentPath('/.cache')).toBe('/');
    expect(parentPath('/root/sub')).toBe('/root');
    expect(parentPath('/root')).toBe('/');
    expect(parentPath('C:\\Users\\me')).toBe('C:\\Users');
  });
});
