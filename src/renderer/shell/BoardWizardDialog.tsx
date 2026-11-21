import { useEffect, useRef } from 'react';
import type { WizardRunResult } from '../../shared/ipc-contract';
import type { BoardDetection } from '../../shared/board-setup';
import { CloseIcon } from './Icons';
import { useT, type Localised } from './i18n';
import { WizardPage, type WizardRequest } from './pages/WizardPage';

const strings = {
  title: { 'zh-Hans': '添加开发板', en: 'Add board' },
  close: { 'zh-Hans': '关闭', en: 'Close' },
} satisfies Record<string, Localised>;

/**
 * The board wizard is an independent task surface, not another destination
 * in the primary navigation. It owns focus while it is open and returns it
 * to the board selector when the task ends.
 */
export function BoardWizardDialog({
  run,
  detect,
  onInstalled,
  onClose,
}: {
  run: (input: WizardRequest) => Promise<WizardRunResult>;
  detect?: () => Promise<BoardDetection>;
  onInstalled?: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = 'board-wizard-title';

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusables = (): HTMLElement[] => {
      if (root === null) return [];
      return [...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
    };

    const initial = root?.querySelector<HTMLElement>('[data-wizard-autofocus]');
    (initial ?? focusables()[0] ?? root)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        root?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="wizard-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="wizard-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="wizard-dialog__head">
          <div>
            <span className="wizard-dialog__eyebrow">DEVICE</span>
            <h2 id={titleId} className="wizard-dialog__title">
              {t(strings.title)}
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn--quiet"
            aria-label={t(strings.close)}
            title={t(strings.close)}
            onClick={onClose}
          >
            <CloseIcon size={15} />
          </button>
        </header>
        <div className="wizard-dialog__body">
          <WizardPage
            run={run}
            detect={detect}
            onInstalled={onInstalled}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}
