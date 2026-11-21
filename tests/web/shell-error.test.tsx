import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * Failures have to be **visible**.
 *
 * A failure that only lives in the console is a failure the user never
 * sees: "I clicked and nothing happened". These are the judgments behind
 * that: the error bar says what went wrong, and a transfer failure is not
 * silent.
 *
 * **And the shape has to be the real one.** The host throws plain objects
 * (`makeError`), not `Error`s — after crossing IPC a real `Error` would
 * arrive as `[object Object]` while the test's hand-made `Error` would
 * still look fine.
 */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    onData() { return { dispose() { /* no-op */ } }; }
    onResize() { return { dispose() { /* no-op */ } }; }
    loadAddon() { /* no-op */ }
    open() { /* no-op */ }
    write() { /* no-op */ }
    focus() { /* no-op */ }
    dispose() { /* no-op */ }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() { /* no-op */ }
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  },
}));

import { ErrorBar } from '../../src/renderer/shell/ErrorBar';
import { FilesPage } from '../../src/renderer/shell/pages/FilesPage';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import { uploadFile, type FileTransferHost } from '../../src/renderer/shell/files';
import { makeError } from '../../src/shared/errors';

/** The capabilities of a connection that can carry files. */
const CAPS = { exec: true, pty: false, files: true, exitCode: true };

/** Install a fake host API. */
function installHost(overrides: Record<string, unknown> = {}): void {
  (window as unknown as { cockpit: unknown }).cockpit = {
    filesList: async () => [],
    filesPush: async () => ({ remotePath: '/root/a.txt' }),
    filesPull: async () => ({ localPath: 'C:\\Users\\me\\Downloads\\a.txt' }),
    getPathForFile: (file: File) => `C:\\Users\\me\\${file.name}`,
    ...overrides,
  };
}

describe('The error bar', () => {
  it('shows why it failed (with the real shape)', () => {
    const failure = makeError('PORT_BUSY', 'the serial port COM3 is busy');
    render(<ErrorBar message={failure.message} onDismiss={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('COM3');
  });

  it('takes no space when there is no error', () => {
    const { container } = render(<ErrorBar message={null} onDismiss={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('the dismiss button closes it', () => {
    let dismissed = 0;
    render(<ErrorBar message="broken" onDismiss={() => { dismissed += 1; }} />);
    fireEvent.click(screen.getByText('知道了'));
    expect(dismissed).toBe(1);
  });
});

describe('The files page', () => {
  it('an upload uses the absolute path of the host, not the file name', async () => {
    const filesPush = vi.fn(
      async (_connectionId: string, _localPath: string, _remotePath: string) => ({
        remotePath: '/root/a.txt',
      }),
    );
    installHost({ filesPush });
    const host: FileTransferHost = {
      getPathForFile: (file) => window.cockpit.getPathForFile(file),
      push: filesPush,
      pull: async () => ({ localPath: '' }),
    };

    render(
      // The Chinese branch: the page has two wordings and the locale is pinned here.
      <LocaleContext.Provider value="zh-Hans">
        <FilesPage
          endpoint={{
            id: 's1',
            profileId: 'board-adb',
            label: 'Board · ADB',
            transport: 'adb',
            capabilities: CAPS,
          }}
          busy={false}
          error={null}
          onPush={(file, remotePath) => {
            void uploadFile(host, 's1', file, remotePath);
          }}
          onPull={() => undefined}
        />
      </LocaleContext.Provider>,
    );

    const input = await screen.findByTestId('file-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt')] } });
    fireEvent.click(screen.getByTestId('push-button'));

    await waitFor(() => expect(filesPush).toHaveBeenCalled());
    // The file name alone is not enough — the host would look for a file of
    // that name in its own working directory, and might even transfer a
    // different file without a word (that is a data safety problem)
    expect(filesPush.mock.calls[0][1]).toBe('C:\\Users\\me\\a.txt');
  });

  it('with no link it says so (instead of showing an empty page)', () => {
    render(
      // The Chinese branch: the page has two wordings and the locale is pinned here.
      <LocaleContext.Provider value="zh-Hans">
        <FilesPage
          endpoint={null}
          busy={false}
          error={null}
          onPush={() => undefined}
          onPull={() => undefined}
        />
      </LocaleContext.Provider>,
    );
    // → **The page no longer waits for a terminal session** ✓ → it says
    //   that there is no link ✓ (and how the host picks one ✓).
    expect(document.querySelector('.page-empty')).toBeTruthy();
    expect(screen.getByText(/ADB/)).toBeTruthy();
  });
});
