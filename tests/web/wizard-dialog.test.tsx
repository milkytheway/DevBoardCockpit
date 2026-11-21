import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { BoardWizardDialog } from '../../src/renderer/shell/BoardWizardDialog';
import { LocaleContext } from '../../src/renderer/shell/i18n';
import type { WizardRunResult } from '../../src/shared/ipc-contract';

const OK: WizardRunResult = {
  ok: true,
  kind: 'ok',
  message: 'done',
  hints: [],
  greenCount: 1,
  redCount: 0,
};

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <LocaleContext.Provider value="en">
      <button type="button" onClick={() => setOpen(true)}>
        Add board
      </button>
      {open ? (
        <BoardWizardDialog
          run={() => Promise.resolve(OK)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </LocaleContext.Provider>
  );
}

describe('the board wizard dialog', () => {
  it('opens as a modal, focuses inside it and closes with Escape', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Add board' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Add board' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
