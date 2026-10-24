/**
 * The doc writer (TipTap 3 on ProseMirror): a page to write research on.
 *
 *   blocks    text, three headings, bulleted, numbered and to-do lists, quotes,
 *             code, dividers, tables (resizable columns, a header row), images,
 *             cards of other items in the folders
 *   marks     bold, italic, underline, strikethrough, code, links, text color,
 *             highlight; alignment of a paragraph or a heading
 *   writing   Markdown shortcuts (# , - , 1. , [ ] , > , ```, ---, **bold**),
 *             "/" at the start of a line for the block menu, a small toolbar
 *             over a selection, undo and redo
 *   in        images pasted or dropped are ATTACHED to the doc (uploaded,
 *             nodes.tsx); other files dropped are uploaded into the folder and
 *             shown as a card; an item dragged in from the tree is a card
 *   out       Markdown (markdown.ts)
 *
 * What is stored is the editor's JSON (DocData), never HTML; the server keeps
 * only the node and mark types this schema knows (validate.ts checkDoc). A
 * paste is parsed by ProseMirror into this schema - a script, a style, an
 * image by URL or an unknown element simply does not exist in it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import type { DocData, DocNode } from '@sign/folders/types.js';
import { notify } from '../../toast';
import { saveBlob } from '../../folders/ui';
import { DRAG_ITEM, saveFiles } from '../../folders/quick';
import { attachImage, ConflictBar, findItem, isImageFile, useEditorSave, type EditorProps } from '../editing';
import { CardPicker } from '../picker';
import { AttachedImage, ItemRef } from './nodes';
import { docToMarkdown } from './markdown';
import './doc.css';

/** The colors text and highlights take (the server keeps any #rrggbb; these are what the menu offers). */
const TEXT_COLORS = ['#e8e8ea', '#9b9ba1', '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac'];
const HIGHLIGHTS = ['#5c4a1a', '#1f4d36', '#1d3b5c', '#4a2350', '#5c2626', '#3a3a3e'];

interface SlashItem {
  key: string;
  label: string;
  hint: string;
  icon: ReactNode;
  run: (e: Editor) => void;
}

const ic = (d: ReactNode) => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const I = {
  text: ic(<path d="M3.5 4h9M8 4v8.5" />),
  h1: ic(<><path d="M2.5 3.5v9M7.5 3.5v9M2.5 8h5" /><path d="M10.5 6l2-1.5v8" /></>),
  h2: ic(<><path d="M2.5 3.5v9M7.5 3.5v9M2.5 8h5" /><path d="M10 6.2a1.6 1.6 0 1 1 2.6 1.3L10 12.5h3" /></>),
  h3: ic(<><path d="M2.5 3.5v9M7.5 3.5v9M2.5 8h5" /><path d="M10 5h2.8l-1.6 2.3a1.7 1.7 0 1 1-1.4 2.9" /></>),
  bullet: ic(<><circle cx="3.5" cy="4.5" r=".6" fill="currentColor" /><circle cx="3.5" cy="8" r=".6" fill="currentColor" /><circle cx="3.5" cy="11.5" r=".6" fill="currentColor" /><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" /></>),
  ordered: ic(<><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" /><path d="M2.5 3.5l1-.5v3M2.4 9.2a.9.9 0 1 1 1.4.8L2.4 11.8h1.7" /></>),
  task: ic(<><rect x="2.5" y="3" width="4" height="4" rx="1" /><path d="m3.4 5 .8.8 1.4-1.6" /><rect x="2.5" y="9" width="4" height="4" rx="1" /><path d="M8.5 5h5M8.5 11h5" /></>),
  quote: ic(<><path d="M3 4.5v7" /><path d="M6 5h7M6 8h7M6 11h4.5" /></>),
  code: ic(<path d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5" />),
  hr: ic(<path d="M2.5 8h11" />),
  table: ic(<><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M2.5 9.8h11M6.2 3v10M9.8 3v10" /></>),
  image: ic(<><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.1" /><path d="m3 12 3.5-3.5 2.5 2.5 1.8-1.8L13.5 12" /></>),
  card: ic(<><rect x="2.5" y="4" width="11" height="8" rx="1.6" /><path d="M5 7h6M5 9.3h3.5" /></>),
  bold: ic(<path d="M4.5 3h4a2.5 2.5 0 0 1 0 5h-4zM4.5 8h4.8a2.5 2.5 0 0 1 0 5H4.5z" />),
  italic: ic(<path d="M9.5 3H13M3 13h3.5M10.5 3 6 13" />),
  underline: ic(<path d="M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3M3.5 13.5h9" />),
  strike: ic(<path d="M2.5 8h11M11 4.8C10.5 3.8 9.4 3 8 3 6.3 3 5 4 5 5.3M5 11.2c.5 1 1.6 1.8 3 1.8 1.7 0 3-1 3-2.3" />),
  inlineCode: ic(<path d="M6 5 3.5 8 6 11M10 5l2.5 3L10 11" />),
  link: ic(<><path d="M7 9a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.7.7" /><path d="M9 7a2.6 2.6 0 0 0-3.7 0l-2 2A2.6 2.6 0 0 0 7 12.7l.7-.7" /></>),
  color: ic(<><path d="M5 12 8 3.5 11 12M6 9.5h4" /></>),
  highlight: ic(<><path d="m9.5 3 3.5 3.5-5.5 5.5H4v-3.5z" /><path d="M3 14h10" /></>),
  left: ic(<path d="M2.5 4h11M2.5 7h7M2.5 10h11M2.5 13h7" />),
  center: ic(<path d="M2.5 4h11M4.5 7h7M2.5 10h11M4.5 13h7" />),
  right: ic(<path d="M2.5 4h11M6.5 7h7M2.5 10h11M6.5 13h7" />),
  undo: ic(<><path d="M5.5 6.5H10a3 3 0 0 1 0 6H7" /><path d="M7.5 4 5 6.5 7.5 9" /></>),
  redo: ic(<><path d="M10.5 6.5H6a3 3 0 0 0 0 6h3" /><path d="M8.5 4 11 6.5 8.5 9" /></>),
  download: ic(<><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2" /><path d="M2.8 11v1.2c0 .7.6 1.3 1.3 1.3h7.8c.7 0 1.3-.6 1.3-1.3V11" /></>),
};

export default function DocEditor({ item, data, limitBytes, onStatus, onOpenItem }: EditorProps<DocData>) {
  const editorRef = useRef<Editor | null>(null);
  const read = useCallback((): DocData => ({ v: 1, doc: (editorRef.current?.getJSON() as DocNode) ?? data.doc }), [data.doc]);
  const save = useEditorSave(item, read, limitBytes, onStatus);
  const [slash, setSlash] = useState<{ query: string; index: number; at: { left: number; top: number } } | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const [cardPicker, setCardPicker] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [linkEdit, setLinkEdit] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);

  /** Images into the doc as its attachments; other files into the folder, as cards. */
  const insertFiles = useCallback(
    async (files: File[], pos?: number) => {
      const e = editorRef.current;
      if (!e) return;
      for (const f of files) {
        setUploading(f.name);
        if (isImageFile(f)) {
          const it = await attachImage(item, f, (share) => setUploading(`${f.name} · ${Math.round(share * 100)}%`));
          if (it) e.chain().focus().insertContentAt(pos ?? e.state.selection.to, { type: 'image', attrs: { file: it.id, alt: f.name.replace(/\.[a-z0-9]+$/i, '') } }).run();
          else notify('warn', `${f.name} could not be added.`);
        } else {
          const r = await saveFiles([f], item.folderId, (name, share) => setUploading(`${name} · ${Math.round(share * 100)}%`));
          if (r?.id) e.chain().focus().insertContentAt(pos ?? e.state.selection.to, { type: 'itemRef', attrs: { id: r.id } }).run();
        }
      }
      setUploading(null);
    },
    [item],
  );
  const insertFilesRef = useRef(insertFiles);
  insertFilesRef.current = insertFiles;

  const slashItems = useMemo<SlashItem[]>(
    () => [
      { key: 'text', label: 'Text', hint: 'A paragraph', icon: I.text, run: (e) => e.chain().focus().setParagraph().run() },
      { key: 'h1', label: 'Heading 1', hint: '#', icon: I.h1, run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
      { key: 'h2', label: 'Heading 2', hint: '##', icon: I.h2, run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
      { key: 'h3', label: 'Heading 3', hint: '###', icon: I.h3, run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
      { key: 'bullet', label: 'Bulleted list', hint: '-', icon: I.bullet, run: (e) => e.chain().focus().toggleBulletList().run() },
      { key: 'ordered', label: 'Numbered list', hint: '1.', icon: I.ordered, run: (e) => e.chain().focus().toggleOrderedList().run() },
      { key: 'todo', label: 'To-do list', hint: '[ ]', icon: I.task, run: (e) => e.chain().focus().toggleTaskList().run() },
      { key: 'quote', label: 'Quote', hint: '>', icon: I.quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
      { key: 'code', label: 'Code', hint: '```', icon: I.code, run: (e) => e.chain().focus().toggleCodeBlock().run() },
      { key: 'divider', label: 'Divider', hint: '---', icon: I.hr, run: (e) => e.chain().focus().setHorizontalRule().run() },
      { key: 'table', label: 'Table', hint: '3 × 3', icon: I.table, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { key: 'image', label: 'Image', hint: 'Upload', icon: I.image, run: () => fileInput.current?.click() },
      { key: 'card', label: 'Item card', hint: 'A chart, a post, a sheet…', icon: I.card, run: () => setCardPicker(true) },
    ],
    [],
  );
  const matches = slash ? slashItems.filter((s) => `${s.label} ${s.key}`.toLowerCase().includes(slash.query.toLowerCase())) : [];
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const runSlash = (s: SlashItem) => {
    const e = editorRef.current;
    if (!e) return;
    const { $from } = e.state.selection;
    // The "/…" typed goes; the block it was typed in becomes what was picked.
    e.chain().focus().deleteRange({ from: $from.start(), to: $from.pos }).run();
    setSlash(null);
    s.run(e);
  };
  const runSlashRef = useRef(runSlash);
  runSlashRef.current = runSlash;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          protocols: ['http', 'https', 'mailto'],
          isAllowedUri: (url) => /^(https?:\/\/|mailto:)/i.test(url),
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : 'Write, or type / for headings, lists, tables, images…') }),
      CharacterCount,
      AttachedImage,
      ItemRef.configure({ open: (id) => onOpenItem(id) }),
    ],
    content: data.doc,
    enableContentCheck: true,
    onContentError: () => setBroken(true),
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'kd-page', spellcheck: 'true', 'aria-label': 'Document' },
      handlePaste: (_view, ev) => {
        const files = Array.from(ev.clipboardData?.files ?? []);
        if (!files.length) return false;
        ev.preventDefault();
        void insertFilesRef.current(files);
        return true;
      },
      handleDrop: (view, ev, _slice, moved) => {
        if (moved) return false;
        const pos = view.posAtCoords({ left: ev.clientX, top: ev.clientY })?.pos;
        const id = ev.dataTransfer?.getData(DRAG_ITEM);
        if (id) {
          ev.preventDefault();
          editorRef.current?.chain().focus().insertContentAt(pos ?? view.state.selection.to, { type: 'itemRef', attrs: { id } }).run();
          return true;
        }
        const files = Array.from(ev.dataTransfer?.files ?? []);
        if (!files.length) return false;
        ev.preventDefault();
        void insertFilesRef.current(files, pos);
        return true;
      },
      handleKeyDown: (_view, ev) => {
        const s = slashRef.current;
        if (!s) return false;
        const list = matchesRef.current;
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          const n = list.length || 1;
          setSlash({ ...s, index: (s.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n });
          return true;
        }
        if (ev.key === 'Enter' && list.length) {
          ev.preventDefault();
          runSlashRef.current(list[Math.min(s.index, list.length - 1)]!);
          return true;
        }
        if (ev.key === 'Escape') {
          setSlash(null);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      save.touched();
      readSlash(e);
    },
    onSelectionUpdate: ({ editor: e }) => readSlash(e),
  });
  editorRef.current = editor;

  /** "/" at the start of an empty paragraph opens the block menu; what follows filters it. */
  function readSlash(e: Editor) {
    const { $from, empty } = e.state.selection;
    const text = $from.parent.textContent;
    const at = $from.parentOffset;
    if (!empty || $from.parent.type.name !== 'paragraph' || !text.startsWith('/') || at !== text.length || /\s/.test(text.slice(1)) || text.length > 24) {
      if (slashRef.current) setSlash(null);
      return;
    }
    const c = e.view.coordsAtPos($from.pos);
    const box = page.current?.getBoundingClientRect();
    setSlash((cur) => ({ query: text.slice(1), index: cur?.query === text.slice(1) ? cur.index : 0, at: { left: c.left - (box?.left ?? 0), top: c.bottom - (box?.top ?? 0) + 6 } }));
  }

  // The marks and blocks under the cursor, for the toolbar (re-rendered only when they change).
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      h: ([1, 2, 3] as const).find((l) => e.isActive('heading', { level: l })) ?? 0,
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      table: e.isActive('table'),
      align: (['center', 'right'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      empty: e.state.selection.empty,
      words: e.storage.characterCount?.words?.() ?? 0,
      from: e.state.selection.from,
      to: e.state.selection.to,
    }),
  });

  if (!editor || !st) return null;

  const setLink = () => setLinkEdit((editor.getAttributes('link').href as string | undefined) ?? '');
  const applyLink = (href: string) => {
    setLinkEdit(null);
    const h = href.trim();
    if (!h) return void editor.chain().focus().extendMarkRange('link').unsetLink().run();
    const url = /^(https?:\/\/|mailto:)/i.test(h) ? h : `https://${h}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const exportMd = () => {
    const md = docToMarkdown(editor.getJSON() as DocNode, (id) => findItem(id)?.title ?? null);
    saveBlob(new Blob([`# ${item.title}\n\n${md}`], { type: 'text/markdown;charset=utf-8' }), `${item.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'doc'}.md`);
  };

  // The selection toolbar, over the selected text.
  let bubble: { left: number; top: number } | null = null;
  if (!st.empty && !st.codeBlock && page.current && editor.isFocused) {
    try {
      const a = editor.view.coordsAtPos(st.from);
      const b = editor.view.coordsAtPos(st.to);
      const box = page.current.getBoundingClientRect();
      bubble = { left: Math.max(0, (a.left + b.left) / 2 - box.left), top: Math.min(a.top, b.top) - box.top - 8 };
    } catch {
      bubble = null;
    }
  }

  const btn = (label: string, icon: ReactNode, on: boolean, run: () => void, disabled = false) => (
    <button type="button" className={`kd-tool${on ? ' is-on' : ''}`} aria-label={label} title={label} aria-pressed={on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {icon}
    </button>
  );

  return (
    <div className="kd">
      <div className="kd-bar" role="toolbar" aria-label="Formatting">
        {btn('Undo (Ctrl+Z)', I.undo, false, () => editor.chain().focus().undo().run(), !st.canUndo)}
        {btn('Redo (Ctrl+Shift+Z)', I.redo, false, () => editor.chain().focus().redo().run(), !st.canRedo)}
        <span className="kd-sep" />
        <select
          className="kd-block"
          aria-label="Text style"
          value={st.h ? `h${st.h}` : 'p'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'p') editor.chain().focus().setParagraph().run();
            else editor.chain().focus().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
          }}
        >
          <option value="p">Text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>
        <span className="kd-sep" />
        {btn('Bold (Ctrl+B)', I.bold, st.bold, () => editor.chain().focus().toggleBold().run())}
        {btn('Italic (Ctrl+I)', I.italic, st.italic, () => editor.chain().focus().toggleItalic().run())}
        {btn('Underline (Ctrl+U)', I.underline, st.underline, () => editor.chain().focus().toggleUnderline().run())}
        {btn('Strikethrough', I.strike, st.strike, () => editor.chain().focus().toggleStrike().run())}
        {btn('Code', I.inlineCode, st.code, () => editor.chain().focus().toggleCode().run())}
        <Swatches label="Text color" icon={I.color} colors={TEXT_COLORS} onPick={(c) => (c ? editor.chain().focus().setColor(c).run() : editor.chain().focus().unsetColor().run())} />
        <Swatches label="Highlight" icon={I.highlight} colors={HIGHLIGHTS} onPick={(c) => (c ? editor.chain().focus().setHighlight({ color: c }).run() : editor.chain().focus().unsetHighlight().run())} />
        {btn('Link', I.link, st.link, setLink)}
        <span className="kd-sep" />
        {btn('Bulleted list', I.bullet, st.bullet, () => editor.chain().focus().toggleBulletList().run())}
        {btn('Numbered list', I.ordered, st.ordered, () => editor.chain().focus().toggleOrderedList().run())}
        {btn('To-do list', I.task, st.task, () => editor.chain().focus().toggleTaskList().run())}
        {btn('Quote', I.quote, st.quote, () => editor.chain().focus().toggleBlockquote().run())}
        {btn('Code block', I.code, st.codeBlock, () => editor.chain().focus().toggleCodeBlock().run())}
        <span className="kd-sep" />
        {btn('Align left', I.left, st.align === 'left', () => editor.chain().focus().setTextAlign('left').run())}
        {btn('Align center', I.center, st.align === 'center', () => editor.chain().focus().setTextAlign('center').run())}
        {btn('Align right', I.right, st.align === 'right', () => editor.chain().focus().setTextAlign('right').run())}
        <span className="kd-sep" />
        {btn('Insert a table', I.table, st.table, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        {btn('Insert an image', I.image, false, () => fileInput.current?.click())}
        {btn('Insert a card of an item', I.card, false, () => setCardPicker(true))}
        {btn('Divider', I.hr, false, () => editor.chain().focus().setHorizontalRule().run())}
        <span className="kd-fill" />
        {btn('Download as Markdown', I.download, false, exportMd)}
      </div>
      {linkEdit !== null && (
        <form
          className="kd-linkbar"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink(linkEdit);
          }}
        >
          <span>Link</span>
          <input
            autoFocus
            className="fx-input"
            value={linkEdit}
            placeholder="https://… (empty removes the link)"
            onChange={(e) => setLinkEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setLinkEdit(null);
                editor.commands.focus();
              }
            }}
          />
          <button type="submit">Apply</button>
          {st.link && <button type="button" onClick={() => applyLink('')}>Remove</button>}
        </form>
      )}
      {st.table && (
        <div className="kd-tablebar" role="toolbar" aria-label="Table">
          <span>Table</span>
          <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</button>
          <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Column</button>
          <button type="button" onClick={() => editor.chain().focus().deleteRow().run()}>− Row</button>
          <button type="button" onClick={() => editor.chain().focus().deleteColumn().run()}>− Column</button>
          <button type="button" onClick={() => editor.chain().focus().toggleHeaderRow().run()}>Header row</button>
          <button type="button" onClick={() => editor.chain().focus().mergeOrSplit().run()}>Merge / split</button>
          <button type="button" className="is-danger" onClick={() => editor.chain().focus().deleteTable().run()}>Delete table</button>
        </div>
      )}
      <ConflictBar
        status={save.status}
        message={save.message}
        onKeep={save.keepMine}
        onLoad={() =>
          void save.loadTheirs().then((fresh) => {
            if (fresh) editor.commands.setContent((fresh.data as DocData).doc, { emitUpdate: false });
          })
        }
      />
      {broken && <p className="kn-conflict" role="alert">Part of this doc could not be read; what could be is shown. Saving keeps what you see.</p>}
      <div className="kd-paper" ref={page}>
        <EditorContent editor={editor} />
        {bubble && (
          <div className="kd-bubble" style={{ left: bubble.left, top: bubble.top }} onMouseDown={(e) => e.preventDefault()}>
            {btn('Bold', I.bold, st.bold, () => editor.chain().focus().toggleBold().run())}
            {btn('Italic', I.italic, st.italic, () => editor.chain().focus().toggleItalic().run())}
            {btn('Underline', I.underline, st.underline, () => editor.chain().focus().toggleUnderline().run())}
            {btn('Strikethrough', I.strike, st.strike, () => editor.chain().focus().toggleStrike().run())}
            {btn('Code', I.inlineCode, st.code, () => editor.chain().focus().toggleCode().run())}
            {btn('Link', I.link, st.link, setLink)}
            {btn('Highlight', I.highlight, editor.isActive('highlight'), () => editor.chain().focus().toggleHighlight({ color: HIGHLIGHTS[0]! }).run())}
          </div>
        )}
        {slash && matches.length > 0 && (
          <div className="kd-slash" role="listbox" aria-label="Blocks" style={{ left: slash.at.left, top: slash.at.top }}>
            {matches.map((m, i) => (
              <button key={m.key} type="button" role="option" aria-selected={i === slash.index} className={`kd-slash__item${i === slash.index ? ' is-on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => runSlash(m)}>
                <span className="kd-slash__ic">{m.icon}</span>
                <span className="kd-slash__t">{m.label}</span>
                <span className="kd-slash__h">{m.hint}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <footer className="kd-foot">
        <span>{st.words} {st.words === 1 ? 'word' : 'words'}</span>
        {uploading && <span className="kd-foot__busy"><span className="fx-spin" aria-hidden="true" />Adding {uploading}</span>}
        <span className="kd-foot__tip">Type / for blocks · Markdown works (# , - , 1. , [ ] , &gt; , ```)</span>
      </footer>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => {
          if (e.target.files?.length) void insertFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
      {cardPicker && (
        <CardPicker
          exclude={item.id}
          onPick={(id) => {
            setCardPicker(false);
            editor.chain().focus().insertContent({ type: 'itemRef', attrs: { id } }).run();
          }}
          onClose={() => setCardPicker(false)}
        />
      )}
    </div>
  );
}

/** A row of colors in a small menu; the first choice takes the color off. */
function Swatches({ label, icon, colors, onPick }: { label: string; icon: ReactNode; colors: string[]; onPick: (c: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', down);
    return () => window.removeEventListener('pointerdown', down);
  }, [open]);
  return (
    <span className="kd-swatch" ref={ref}>
      <button type="button" className="kd-tool" aria-label={label} title={label} aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
        {icon}
      </button>
      {open && (
        <span className="kd-swatch__menu" role="menu" onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className="kd-swatch__none" aria-label="None" title="None" onClick={() => { onPick(null); setOpen(false); }} />
          {colors.map((c) => (
            <button key={c} type="button" className="kd-swatch__c" style={{ background: c }} aria-label={c} title={c} onClick={() => { onPick(c); setOpen(false); }} />
          ))}
        </span>
      )}
    </span>
  );
}
