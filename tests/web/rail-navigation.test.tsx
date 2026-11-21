import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Rail } from '../../src/renderer/shell/Rail';
import { LocaleContext } from '../../src/renderer/shell/i18n';

describe('the main navigation', () => {
  it('keeps board setup out of the primary rail', () => {
    render(
      <LocaleContext.Provider value="en">
        <Rail page="workbench" onPage={vi.fn()} onOpenPalette={vi.fn()} />
      </LocaleContext.Provider>,
    );

    expect(screen.queryByRole('button', { name: 'Wizard' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Workbench' })).toBeTruthy();
  });
});
