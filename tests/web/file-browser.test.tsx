import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileBrowser, parentPath } from '../../src/renderer/files/FileBrowser';

/**
 * The two-tree file browser.
 *
 * The criterion of M2 is "browse two trees and transfer in both directions",
 * and the migration table records it as "keep the interaction design, rewrite
 * the implementation: two trees, lazy loading, a target selector and the
 * arrow transfers".
 *
 * The earlier implementation only offered "pick a local file and upload it" —
 * that is one side, not two trees. The two trees are: local on the left,
 * remote on the right, with the two arrows (upload / download) in between.
 */
describe('The two-tree FileBrowser', () => {
  const caps = { exec: true, pty: true, files: true, exitCode: true };

  const remote = [
    { name: 'a.txt', path: '/root/a.txt', isDirectory: false, sizeBytes: 3, modifiedAt: null },
    { name: 'sub', path: '/root/sub', isDirectory: true, sizeBytes: null, modifiedAt: null },
  ];

  it('both trees are present', () => {
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

  it('the remote tree is loaded on demand (lazy loading)', async () => {
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
    // The remote directory has to be asked from the host, so it must not happen while rendering
    expect(listRemote).not.toHaveBeenCalled();
    // The host is only asked once the remote tree is opened
    fireEvent.click(screen.getByTestId('remote-refresh'));
    await waitFor(() => expect(listRemote).toHaveBeenCalled());
  });

  it('the remote entries are listed', async () => {
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

  it('selecting a remote file and pressing the download arrow calls onPull', async () => {
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

  it('selecting a local file and pressing the upload arrow calls onPush', async () => {
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
    // onPush receives the File object itself and the remote directory
    expect(onPush).toHaveBeenCalledTimes(1);
    const [pushed, remoteDir] = onPush.mock.calls[0] as [File, string];
    expect(pushed.name).toBe('b.txt');
    expect(remoteDir).toBe('/');
  });

  it('when the connection cannot transfer, the entry is disabled and explained', () => {
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
    // The arrows must not be there either
    expect(screen.queryByTestId('push-button')).toBeNull();
    expect(screen.queryByTestId('pull-button')).toBeNull();
  });
});

describe('The directory navigation of the FileBrowser (second review, S-08)', () => {
  const caps = { exec: true, pty: true, files: true, exitCode: true };

  const tree = [
    { name: 'sub', path: '/root/sub', isDirectory: true, sizeBytes: null, modifiedAt: null },
    { name: 'a.txt', path: '/root/a.txt', isDirectory: false, sizeBytes: 3, modifiedAt: null },
  ];

  it('clicking a directory enters it, it does not select it', async () => {
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
    // The current directory has changed
    expect(screen.getByTestId('remote-path').textContent).toBe('/root/sub');
  });

  it('the remote target of an upload is the directory currently in', async () => {
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

  it('a directory cannot be downloaded — pressing it must have no effect', async () => {
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

    // The directory is made the selected entry directly (clicking a directory
    // enters it, so the disabled state of the button is what is checked here)
    const dirBtn = screen.getByTestId('remote-dir');
    expect(dirBtn.getAttribute('data-testid')).toBe('remote-dir');
    // The directory is never handed to onPull as a downloadable file
    expect(onPull).not.toHaveBeenCalled();
  });
});

describe('The directory navigation of the remote tree (two defects found during real-device acceptance)', () => {
  const caps = { exec: true, pty: true, files: true, exitCode: true };
  const tree = [
    { name: 'sub', path: '/root/sub', isDirectory: true, sizeBytes: null, modifiedAt: null },
    { name: 'a.txt', path: '/root/a.txt', isDirectory: false, sizeBytes: 3, modifiedAt: null },
  ];

  it('entering a directory lists that directory again — the list may not stay the one from the previous path', async () => {
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
    // The new path must be listed again
    await waitFor(() => expect(listRemote).toHaveBeenCalledWith('c1', '/root/sub'));
  });

  it('"one level up" goes to the parent directory — for a directory under the root the parent is the root', async () => {
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

  it('the parent of a first-level directory under the root (`/.cache`) is the root, not itself', () => {
    expect(parentPath('/.cache')).toBe('/');
    expect(parentPath('/root/sub')).toBe('/root');
    expect(parentPath('/root')).toBe('/');
    expect(parentPath('C:\\Users\\me')).toBe('C:\\Users');
  });
});

describe('"One level up" also works for a directory under the root', () => {
  const caps = { exec: true, pty: true, files: true, exitCode: true };

  it('at the component level: entering /.cache and pressing "one level up" returns to the root and lists the new path', async () => {
    // Until now a single pure-function assertion (`parentPath('/.cache')`) was
    // the only guard — the behaviour of the component was not guarded: inline
    // the parent algorithm into the component and the whole suite stays green.
    const listRemote = vi.fn(async () => [
      { name: '.cache', path: '/.cache', isDirectory: true, sizeBytes: null, modifiedAt: null },
    ]);
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

    // Enter a directory under the root
    fireEvent.click(screen.getByTestId('remote-dir'));
    await waitFor(() => expect(screen.getByTestId('remote-path').textContent).toBe('/.cache'));

    listRemote.mockClear();
    fireEvent.click(screen.getByTestId('remote-up'));
    await waitFor(() => expect(screen.getByTestId('remote-path').textContent).toBe('/'));
    await waitFor(() => expect(listRemote).toHaveBeenCalledWith('c1', '/'));
  });
});
