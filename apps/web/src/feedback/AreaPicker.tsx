/**
 * "Area": which parts of the site a message is about - several at once, from a
 * dropdown with a search box (owner, 2026-10-27). The list is the server's
 * (@sign/ops/feedbackAreas), so the form offers exactly what the server takes.
 *
 * Keyboard: the button opens it (Enter, Space, Arrow Down); typing filters;
 * Arrow Up / Down move through the list, Enter ticks or unticks the area under
 * the cursor; Escape closes it (the dialog asks it first - onLayer); Tab moves on
 * and closes it. The chosen areas stay as chips under the button, each with its
 * own remove button.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FEEDBACK_AREAS, areaLabel, searchAreas } from '@sign/ops/feedbackAreas.js';

/** Toggle one id, keeping the list's order (exported for tests). */
export function toggleArea(value: readonly string[], id: string): string[] {
  const on = value.includes(id) ? value.filter((v) => v !== id) : [...value, id];
  return FEEDBACK_AREAS.map((a) => a.id).filter((x) => on.includes(x));
}

export function AreaPicker({ value, onChange, required, invalid = false, onLayer }: {
  value: string[];
  onChange: (ids: string[]) => void;
  required: boolean;
  invalid?: boolean;
  /** While open: how the dialog closes it on Escape before closing itself. */
  onLayer: (close: (() => void) | null) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useMemo(() => searchAreas(q), [q]);

  const close = (refocus = true) => {
    setOpen(false);
    setQ('');
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    onLayer(() => close());
    search.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      onLayer(null);
      document.removeEventListener('mousedown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setActive(0), [q]);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(list.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      // Never the form's submit: Enter ticks the area under the cursor.
      e.preventDefault();
      const a = list[active];
      if (a) onChange(toggleArea(value, a.id));
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const summary = value.length ? value.map(areaLabel).join(', ') : required ? 'Choose at least one' : 'Choose (optional)';
  return (
    <div className={`fb-areas${invalid ? ' is-bad' : ''}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="fb-areas__btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`Area${required ? ' (required for a bug)' : ''}: ${value.length ? value.map(areaLabel).join(', ') : 'none chosen'}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={value.length ? '' : 'fb-areas__ph'}>{summary}</span>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="fb-areas__pop">
          <input
            ref={search}
            type="search"
            className="fb-areas__search"
            placeholder="Search areas"
            aria-label="Search areas"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={`${id}-list`}
            aria-activedescendant={list[active] ? `${id}-${list[active]!.id}` : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <ul className="fb-areas__list" id={`${id}-list`} role="listbox" aria-multiselectable="true" aria-label="Areas">
            {list.map((a, i) => {
              const on = value.includes(a.id);
              return (
                <li
                  key={a.id}
                  id={`${id}-${a.id}`}
                  role="option"
                  aria-selected={on}
                  className={`fb-areas__opt${i === active ? ' is-active' : ''}${on ? ' is-on' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onChange(toggleArea(value, a.id))}
                >
                  <span className="fb-areas__tick" aria-hidden="true">{on ? '✓' : ''}</span>
                  {a.label}
                </li>
              );
            })}
            {!list.length && <li className="fb-areas__none" role="presentation">No area matches - pick Other.</li>}
          </ul>
        </div>
      )}
      {value.length > 0 && (
        <span className="fb-areas__chips">
          {value.map((v) => (
            <span key={v} className="fb-chip">
              <span>{areaLabel(v)}</span>
              <button type="button" aria-label={`Remove ${areaLabel(v)}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
