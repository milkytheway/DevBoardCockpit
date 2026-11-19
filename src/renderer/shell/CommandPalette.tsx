import { useEffect, useRef, useState } from 'react';
import { pick, useLocale, useT, type Localised } from './i18n';
import { CloseIcon, SearchIcon } from './Icons';

/**
 * A command the palette can run.
 *
 * The label is a localised pair, because the palette is drawn from the
 * shell's data and cannot read the React context itself.
 */
export interface Command {
  id: string;
  label: Localised;
  hint?: Localised;
  shortcut?: string;
  run: () => void;
}

/** The wording of the palette, in both languages. */
const strings = {
  palette: { 'zh-Hans': '命令面板', en: 'Command palette' },
  placeholder: { 'zh-Hans': '搜索视图、页面、命令…', en: 'Search views, pages, commands…' },
  search: { 'zh-Hans': '命令搜索', en: 'Command search' },
  close: { 'zh-Hans': '关闭命令面板', en: 'Close the command palette' },
  noMatch: { 'zh-Hans': '没有匹配的命令', en: 'No matching command' },
} satisfies Record<string, Localised>;

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = useT();
  const locale = useLocale();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!open) return null;

  const filtered = commands.filter((command) => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return true;
    const label = pick(command.label, locale);
    const hint = command.hint === undefined ? '' : pick(command.hint, locale);
    return (label + ' ' + hint).toLowerCase().includes(q);
  });

  const execute = (command: Command | undefined): void => {
    if (!command) return;
    runClose(command.run);
  };

  const runClose = (fn: () => void): void => {
    fn();
    onClose();
  };

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t(strings.palette)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette__input">
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t(strings.placeholder)}
            aria-label={t(strings.search)}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((prev) => Math.min(prev + 1, filtered.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((prev) => Math.max(prev - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                execute(filtered[index]);
              }
            }}
          />
          <kbd>Esc</kbd>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t(strings.close)}>
            <CloseIcon size={13} />
          </button>
        </div>
        <ul className="palette__list">
          {filtered.map((command, itemIndex) => (
            <li key={command.id}>
              <button
                type="button"
                className={itemIndex === index ? 'is-active' : ''}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => execute(command)}
              >
                <span>{pick(command.label, locale)}</span>
                {command.hint ? (
                  <span className="palette__hint">{pick(command.hint, locale)}</span>
                ) : null}
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
              </button>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="palette__empty">{t(strings.noMatch)}</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
