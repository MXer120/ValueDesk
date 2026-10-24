/**
 * The doc's own two nodes (the rest are TipTap's):
 *
 *   image    an image ATTACHED to the doc (an upload whose parent is the doc,
 *            by id): its bytes are fetched with the wallet's token and shown
 *            from a blob URL. Never an image by URL - a pasted <img> is not
 *            parsed at all, so nothing in a doc makes the browser load
 *            anything from anywhere else.
 *   itemRef  a card of another item in the wallet's folders (a chart, a post,
 *            a sheet…): its title and line from the list; a click opens it.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useFolders } from '../../folders/state';
import { KindIcon, KIND_LABEL, itemLine, useFileUrl } from '../views';

function ImageView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const file = node.attrs.file as string | null;
  const url = useFileUrl(file);
  const box = useRef<HTMLDivElement>(null);
  const width = node.attrs.width as number | null;

  // Drag the right edge to size it; the doc keeps the width.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const from = box.current?.getBoundingClientRect().width ?? 400;
    const max = box.current?.parentElement?.getBoundingClientRect().width ?? 900;
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.max(80, Math.min(max, from + ev.clientX - start)));
      if (box.current) box.current.style.width = `${w}px`;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      updateAttributes({ width: Math.round(Math.max(80, Math.min(max, from + ev.clientX - start))) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <NodeViewWrapper className={`kd-image${selected ? ' is-selected' : ''}`} data-drag-handle="">
      <div ref={box} className="kd-image__box" style={width ? { width } : undefined}>
        {url ? <img src={url} alt={(node.attrs.alt as string) || ''} draggable={false} /> : <span className="kd-image__wait"><span className="fx-spin" aria-hidden="true" />Loading image…</span>}
        <span className="kd-image__handle" aria-hidden="true" onPointerDown={startResize} />
      </div>
    </NodeViewWrapper>
  );
}

export const AttachedImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { file: { default: null }, alt: { default: '' }, width: { default: null } };
  },
  // Not from pasted or dropped HTML: an image comes in as a file and is attached (DocEditor).
  parseHTML() {
    return [];
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes({ 'data-attachment': HTMLAttributes.file ?? '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

export interface ItemRefOptions {
  open: (id: string) => void;
}

function ItemRefView({ node, extension, selected }: ReactNodeViewProps) {
  const s = useFolders();
  const id = node.attrs.id as string;
  const it = s.list?.folders.flatMap((f) => f.items).find((i) => i.id === id) ?? null;
  const open = (extension.options as ItemRefOptions).open;
  return (
    <NodeViewWrapper className={`kd-ref${selected ? ' is-selected' : ''}`} data-drag-handle="">
      <button type="button" className="kd-ref__card" contentEditable={false} disabled={!it} onClick={() => it && open(id)}>
        {it ? <KindIcon item={it} size={16} /> : <KindIcon kind="doc" size={16} />}
        <span className="kd-ref__body">
          <b>{it ? it.title : 'An item that is no longer in your folders'}</b>
          <span>{it ? `${KIND_LABEL[it.kind]} · ${itemLine(it)}` : 'Deleted'}</span>
        </span>
        {it && <span className="kd-ref__go" aria-hidden="true">Open</span>}
      </button>
    </NodeViewWrapper>
  );
}

export const ItemRef = Node.create<ItemRefOptions>({
  name: 'itemRef',
  group: 'block',
  atom: true,
  draggable: true,
  addOptions() {
    return { open: () => {} };
  },
  addAttributes() {
    return { id: { default: null } };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-item': HTMLAttributes.id ?? '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ItemRefView);
  },
});
