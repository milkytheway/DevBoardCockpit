import { useEffect, useRef, useState } from 'react';
import { CloseIcon, SearchIcon } from './Icons';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  run: () => void;
}

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
    return (command.label + ' ' + (command.hint ?? '')).toLowerCase().includes(q);
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
        aria-label="命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette__input">
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索视图、页面、命令…"
            aria-label="命令搜索"
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
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭命令面板">
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
                <span>{command.label}</span>
                {command.hint ? <span className="palette__hint">{command.hint}</span> : null}
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
              </button>
            </li>
          ))}
          {filtered.length === 0 ? <li className="palette__empty">没有匹配的命令</li> : null}
        </ul>
      </div>
    </div>
  );
}
