/**
 * A note, edited in place: a contentEditable page with a toolbar (headings,
 * bold, italic, underline, strike, code, quote, lists, a divider, a link,
 * clear), saved as you type (autosave.ts).
 *
 * What goes in and out is note.ts's: the page is written from the stored
 * blocks with noteToHtml, and read back with readNote - so whatever the
 * browser's editing leaves in the DOM, only text and known formatting is kept.
 * A paste is read the same way BEFORE it reaches the page: the clipboard's HTML
 * is parsed in a detached document (nothing in it runs or loads), reduced to
 * spans and written back out, so a pasted <img onerror> or <script> never
 * exists in the page at all.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from 'react';
import type { FolderItem, NoteData } from '@sign/folders/types.js';
import { noteText, noteToHtml, readNote, safeLink, type NodeLike } from './note';
import { STATUS_LABEL, useAutosave } from './autosave';
import { useFolders } from './state';

const tool = (d: ReactNode) => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

type Cmd = { label: string; key?: string; icon: ReactNode; run: () => void; active?: () => boolean };

const exec = (cmd: string, value?: string) => document.execCommand(cmd, false, value);
const block = (tag: string) => () => exec('formatBlock', tag);
const state = (cmd: string) => () => {
  try {
    return document.queryCommandState(cmd);
  } catch {
    return false;
  }
};
const inBlock = (tag: string) => () => {
  try {
    return String(document.queryCommandValue('formatBlock')).toLowerCase() === tag;
  } catch {
    return false;
  }
};

export function NoteEditor({ item, data }: { item: FolderItem; data: NoteData }) {
  const s = useFolders();
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef<NoteData>(data);
  const [, redraw] = useState(0);
  const [link, setLink] = useState<{ range: Range | null; value: string } | null>(null);
  const read = useCallback(() => latest.current, []);
  const auto = useAutosave(item, read, s.list?.limits.jsonBytes.note ?? 200 * 1024);

  /** The placeholder shows while the note holds no text. */
  const markEmpty = () => {
    if (ref.current) ref.current.dataset.empty = noteText(latest.current).trim() ? '' : '1';
  };

  useLayoutEffect(() => {
    if (ref.current) ref.current.innerHTML = noteToHtml(data);
    markEmpty();
    // Written once per opening; after that the page is the source until it is saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changed = () => {
    if (ref.current) latest.current = readNote(ref.current as unknown as NodeLike);
    markEmpty();
    auto.touched();
  };

  /** A button shows its state only for a selection inside this note (the page has lists of its own). */
  const inside = (): boolean => {
    const n = window.getSelection()?.anchorNode;
    return !!n && !!ref.current?.contains(n);
  };

  const run = (fn: () => void) => {
    ref.current?.focus();
    fn();
    changed();
    redraw((n) => n + 1);
  };

  const cmds: Array<Cmd | 'sep'> = [
    { label: 'Heading', icon: tool(<path d="M3.5 3.5v9M10.5 3.5v9M3.5 8h7M13 7v5.5" />), run: block('h1'), active: inBlock('h1') },
    { label: 'Subheading', icon: tool(<path d="M3.5 4v8M9.5 4v8M3.5 8h6M11.5 8.5a1.3 1.3 0 1 1 2.3.9L11.5 12h2.6" />), run: block('h2'), active: inBlock('h2') },
    { label: 'Text', icon: tool(<path d="M3.5 4h9M8 4v8.5" />), run: block('p'), active: inBlock('p') },
    'sep',
    { label: 'Bold', key: 'B', icon: tool(<path d="M4.5 3h4.2a2.4 2.4 0 0 1 0 4.8H4.5zM4.5 7.8h5a2.6 2.6 0 0 1 0 5.2h-5z" />), run: () => exec('bold'), active: state('bold') },
    { label: 'Italic', key: 'I', icon: tool(<path d="M9.5 3H13M3 13h3.5M10.8 3 5.2 13" />), run: () => exec('italic'), active: state('italic') },
    { label: 'Underline', key: 'U', icon: tool(<path d="M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3M3.5 13.5h9" />), run: () => exec('underline'), active: state('underline') },
    { label: 'Strikethrough', icon: tool(<path d="M3 8h10M10.8 4.6c-.5-1-1.6-1.6-2.8-1.6-1.6 0-2.8.9-2.8 2.2 0 .7.3 1.2.9 1.6M5.2 11c.5 1.2 1.6 2 3 2 1.7 0 2.9-.9 2.9-2.3 0-.5-.1-.9-.4-1.2" />), run: () => exec('strikeThrough'), active: state('strikeThrough') },
    'sep',
    { label: 'Bulleted list', icon: tool(<><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" /><circle cx="3.5" cy="4.5" r=".5" /><circle cx="3.5" cy="8" r=".5" /><circle cx="3.5" cy="11.5" r=".5" /></>), run: () => exec('insertUnorderedList'), active: state('insertUnorderedList') },
    { label: 'Numbered list', icon: tool(<path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7M3 3.5h.8v2.5M2.7 9.2c0-.5.4-.8.9-.8s.8.3.8.7c0 .7-1.7 1.3-1.7 2.4h1.8" />), run: () => exec('insertOrderedList'), active: state('insertOrderedList') },
    { label: 'Quote', icon: tool(<path d="M3.5 4v8M6.5 5.5h6M6.5 8h6M6.5 10.5h4" />), run: block('blockquote'), active: inBlock('blockquote') },
    { label: 'Code', icon: tool(<path d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5" />), run: block('pre'), active: inBlock('pre') },
    { label: 'Divider', icon: tool(<path d="M2.5 8h11" />), run: () => exec('insertHorizontalRule') },
    'sep',
    {
      label: 'Link',
      key: 'K',
      icon: tool(<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />),
      run: () => {
        const sel = window.getSelection();
        setLink({ range: sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null, value: 'https://' });
      },
    },
    { label: 'Clear formatting', icon: tool(<path d="M4 3.5h8M8 3.5 6.5 12.5M3 13l10-10" />), run: () => exec('removeFormat') },
  ];

  const applyLink = () => {
    const href = link ? safeLink(link.value) : null;
    const range = link?.range;
    setLink(null);
    if (!href || !range || range.collapsed) return;
    const sel = window.getSelection();
    ref.current?.focus();
    sel?.removeAllRanges();
    sel?.addRange(range);
    exec('createLink', href);
    changed();
  };

  const onPaste = (e: ReactClipboardEvent) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const note = readNote(doc.body as unknown as NodeLike);
      const only = note.blocks.length === 1 && note.blocks[0]!.type === 'p' ? noteToHtml(note).replace(/^<p>|<\/p>$/g, '') : noteToHtml(note);
      exec('insertHTML', only);
    } else if (text) exec('insertText', text);
    changed();
  };

  return (
    <div className="kf-note">
      <div className="kf-tools" role="toolbar" aria-label="Formatting">
        {cmds.map((c, i) =>
          c === 'sep' ? (
            <span key={`sep${i}`} className="kf-tools__sep" aria-hidden="true" />
          ) : (
            <button
              key={c.label}
              type="button"
              className={`kf-tools__btn${c.active && inside() && c.active() ? ' is-on' : ''}`}
              aria-label={c.label}
              title={c.key ? `${c.label} (Ctrl+${c.key})` : c.label}
              aria-pressed={c.active ? inside() && c.active() : undefined}
              // Keeps the selection in the page while the button is pressed.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(c.run)}
            >
              {c.icon}
            </button>
          ),
        )}
        <span className={`kf-save-state is-${auto.status}`} role="status">{STATUS_LABEL[auto.status]}</span>
      </div>
      {link && (
        <div className="kf-linkbar">
          <input
            className="fx-input"
            autoFocus
            value={link.value}
            aria-label="Link address"
            onChange={(e) => setLink({ ...link, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setLink(null);
              }
            }}
          />
          <button type="button" className="kf__addbtn" onClick={applyLink}>Link</button>
          {link.range?.collapsed !== false && <span className="fx-note">Select the words to link first.</span>}
        </div>
      )}
      {(auto.status === 'conflict' || auto.status === 'error' || auto.status === 'too-large') && auto.message && (
        <div className="kf-conflict" role="alert">
          <span>{auto.message}</span>
          {auto.status === 'conflict' && (
            <>
              <button
                type="button"
                className="kf__addbtn"
                onClick={async () => {
                  const fresh = await auto.loadTheirs();
                  if (fresh && ref.current) {
                    ref.current.innerHTML = noteToHtml(fresh.data as NoteData);
                    latest.current = fresh.data as NoteData;
                  }
                }}
              >
                Load that version
              </button>
              <button type="button" className="kf__addbtn" onClick={auto.keepMine}>Keep mine</button>
            </>
          )}
          {auto.status === 'error' && <button type="button" className="kf__addbtn" onClick={() => void auto.save()}>Try again</button>}
        </div>
      )}
      <div
        ref={ref}
        className="kf-note__page"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Note"
        spellCheck
        onInput={changed}
        onPaste={onPaste}
        // New lines as paragraphs, not the browser's default <div>s.
        onFocus={() => document.execCommand('defaultParagraphSeparator', false, 'p')}
        onDrop={(e) => {
          // Files go to the folder (the pane takes them); dropped markup never reaches the page.
          if (!Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          const k = e.key.toUpperCase();
          if (k === 'S') {
            e.preventDefault();
            void auto.save();
          } else if (k === 'K') {
            e.preventDefault();
            cmds.find((c): c is Cmd => c !== 'sep' && c.key === 'K')?.run();
          } else if (k === 'B' || k === 'I' || k === 'U') setTimeout(changed, 0);
        }}
        onKeyUp={() => redraw((n) => n + 1)}
        onMouseUp={() => redraw((n) => n + 1)}
      />
    </div>
  );
}
