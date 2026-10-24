/**
 * The board: an endless canvas to lay research out on, the way Figma's or
 * FigJam's is.
 *
 *   things    sticky notes, text, rectangles, ellipses, diamonds, lines and
 *             arrows (an end dropped on a thing stays attached to it), pen
 *             strokes, frames (what lies inside moves with them), images (the
 *             board's attachments) and cards of other items (a chart with its
 *             picture, a post, a doc…; double-click opens it)
 *   tools     V select · H hand · S sticky · T text · R rectangle · O ellipse ·
 *             D diamond · L line · A arrow · P pen · F frame
 *   moving    drag (things line up with the others: guides show where), arrows
 *             1 px (Shift: 10), handles to resize (Shift keeps proportions),
 *             a drag on empty canvas selects what it touches
 *   view      scroll or two fingers to pan, Ctrl/⌘ + scroll or a pinch to zoom,
 *             Space or the middle button to drag the canvas, Shift+1 to fit
 *   editing   double-click a note, a shape or a text to write in it, Enter for
 *             the one selected; Ctrl/⌘ Z, Shift+Z, C, X, V, D, A; Delete; [ and ]
 *   in        files dropped or pasted (an image is attached to the board, any
 *             other file goes into the folder and onto the board as its card),
 *             items dragged in from the tree, a link to a post on X (saved,
 *             then shown as a card), text (a sticky note)
 *
 * What is stored is the list of elements (BoardData), every number inside what
 * the server keeps (model.ts forSaving); the view (where you looked, how far
 * in) is this browser's own.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { BoardData, BoardEnd } from '@sign/folders/types.js';
import { findTweetUrl } from '@sign/folders/tweetUrl.js';
import { MENU_ICONS, TabMenu, type TabMenuItem } from '../../dashboard/tabExtras';
import { notify } from '../../toast';
import { DRAG_ITEM, canKeep, readDrop, saveFiles, saveNews, saveTweet, type Dropped } from '../../folders/quick';
import { useFolders } from '../../folders/state';
import { attachImage, ConflictBar, isImageFile, useEditorSave, type EditorProps } from '../editing';
import { CardPicker } from '../picker';
import { KindIcon, KIND_LABEL, itemLine, useFileUrl } from '../views';
import {
  HANDLES,
  boxFrom,
  boxOf,
  clampZ,
  duplicate,
  fitView,
  forSaving,
  intersects,
  isAttachable,
  isLine,
  isShape,
  lineEnds,
  lineThrough,
  moveBy,
  movedWith,
  newId,
  penFrom,
  r1,
  resizeBox,
  scaleGroup,
  settleLines,
  snap,
  thin,
  unionBox,
  zoomAt,
  type Box,
  type El,
  type Guide,
  type Handle,
  type P,
  type View,
} from './model';
import './board.css';

type Tool = 'select' | 'hand' | 'sticky' | 'text' | 'rect' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'pen' | 'frame';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; v: View }
  | { kind: 'move'; start: P; base: El[]; ids: Set<string>; box: Box; moved: boolean }
  | { kind: 'resize'; handle: Handle; start: Box; base: El[]; ids: Set<string>; single: El | null }
  | { kind: 'marquee'; a: P; b: P; add: Set<string> }
  | { kind: 'create'; id: string; a: P; base: El[] }
  | { kind: 'pen'; id: string; pts: P[]; base: El[] }
  | { kind: 'end'; id: string; end: 'a' | 'b'; base: El[] };

const STICKY = ['#ffe58f', '#ffadd2', '#b7eb8f', '#91caff', '#d3adf7', '#ffc069'];
const COLORS = ['#f2f2f2', '#9a9aa3', '#3a3a40', '#1e1e22', '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac'];
const NONE = '#00000000';
const FONT_SIZES: Array<[string, number]> = [['S', 14], ['M', 20], ['L', 30], ['XL', 48]];
const ENDS: BoardEnd[] = ['none', 'arrow', 'triangle', 'dot', 'bar'];
const TOOL_KEYS: Record<string, Tool> = { v: 'select', h: 'hand', s: 'sticky', t: 'text', r: 'rect', o: 'ellipse', d: 'diamond', l: 'line', a: 'arrow', p: 'pen', f: 'frame' };

/** A board copied in this tab (Ctrl+C), for Ctrl+V on this board or another. */
let clipboard: El[] = [];

const viewKey = (id: string) => `kb.view.${id}`;
const readView = (id: string): View | null => {
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(id)) ?? 'null') as View | null;
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? { ...v, z: clampZ(v.z) } : null;
  } catch {
    return null;
  }
};

/** Dark text on a light fill, light text on a dark one. */
function inkOn(fill: string | undefined): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(fill ?? '');
  if (!m || (m[4] && parseInt(m[4], 16) < 96)) return '#f2f2f2';
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#1b1b1f' : '#f5f5f7';
}

const hasText = (e: El): boolean => e.type === 'sticky' || e.type === 'text' || isShape(e);

export default function BoardEditor({ item, data, limitBytes, onStatus, onOpenItem }: EditorProps<BoardData>) {
  const [els, setEls] = useState<El[]>(() => settleLines(data.elements));
  const elsRef = useRef(els);
  elsRef.current = els;
  const [bg, setBg] = useState<NonNullable<BoardData['bg']>>(data.bg ?? 'dots');
  const bgRef = useRef(bg);
  bgRef.current = bg;
  const read = useCallback((): BoardData => ({ v: 1, elements: forSaving(elsRef.current), bg: bgRef.current }), []);
  const save = useEditorSave(item, read, limitBytes, onStatus);

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<View>(() => readView(item.id) ?? { x: 0, y: 0, z: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [guides, setGuides] = useState<Guide[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [space, setSpace] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: TabMenuItem[] } | null>(null);
  const [picker, setPicker] = useState<P | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stickyColor, setStickyColor] = useState(STICKY[0]!);
  const past = useRef<El[][]>([]);
  const future = useRef<El[][]>([]);
  const host = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingImageAt = useRef<P | null>(null);
  const byId = useMemo(() => new Map(els.map((e) => [e.id, e])), [els]);

  /* -------------------------------------------------------------- changes ----- */

  /** A change that is kept: one step of undo, then saved. */
  const commit = useCallback(
    (next: El[], base: El[] = elsRef.current) => {
      past.current.push(base);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      elsRef.current = next;
      setEls(next);
      save.touched();
    },
    [save],
  );
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(elsRef.current);
    setEls(prev);
    elsRef.current = prev;
    setSel((s) => new Set([...s].filter((id) => prev.some((e) => e.id === id))));
    save.touched();
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(elsRef.current);
    setEls(next);
    elsRef.current = next;
    save.touched();
  };
  const patch = (ids: Iterable<string>, f: (e: El) => Partial<El> | null) => {
    const set = new Set(ids);
    commit(settleLines(elsRef.current.map((e) => (set.has(e.id) ? { ...e, ...(f(e) ?? {}) } : e))));
  };
  const remove = (ids: Iterable<string>) => {
    const set = new Set(ids);
    if (!set.size) return;
    commit(settleLines(elsRef.current.filter((e) => !set.has(e.id))));
    setSel(new Set());
  };
  const add = (made: El[], select = true) => {
    if (elsRef.current.length + made.length > 4000) return void notify('warn', 'A board holds 4,000 things at most.');
    commit([...elsRef.current, ...made]);
    if (select) setSel(new Set(made.map((e) => e.id)));
  };

  // Remember where this board was looked at.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(viewKey(item.id), JSON.stringify(view));
      } catch {
        /* private window */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [view, item.id]);

  // A board opened for the first time on this browser shows all of itself.
  useEffect(() => {
    if (readView(item.id)) return;
    const r = host.current?.getBoundingClientRect();
    if (!r) return;
    setView(els.length ? fitView(els.map(boxOf), r.width, r.height) : { x: r.width / 2, y: r.height / 2, z: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------- coordinates ----- */

  const toWorld = (cx: number, cy: number): P => {
    const r = host.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
  };
  const viewportCenter = (): P => {
    const r = host.current!.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  };
  const fit = () => {
    const r = host.current?.getBoundingClientRect();
    if (r) setView(fitView((sel.size ? els.filter((e) => sel.has(e.id)) : els).map(boxOf), r.width, r.height));
  };
  const zoomBy = (k: number) => {
    const r = host.current!.getBoundingClientRect();
    setView((v) => zoomAt(v, v.z * k, r.width / 2, r.height / 2));
  };

  // Wheel: pan; with Ctrl/⌘ (a pinch on a trackpad sends that too): zoom at the pointer.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey ? 2.4 : 1));
        setView((v) => zoomAt(v, v.z * k, e.clientX - r.left, e.clientY - r.top));
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  /* --------------------------------------------------------------- making ----- */

  const make = (type: El['type'], at: P, size?: { w: number; h: number }): El => {
    const base: El = { id: newId(), type, x: r1(at.x), y: r1(at.y), w: size?.w ?? 0, h: size?.h ?? 0 };
    switch (type) {
      case 'sticky':
        return { ...base, w: size?.w || 200, h: size?.h || 200, fill: stickyColor, fs: 20 };
      case 'text':
        return { ...base, w: size?.w || 240, h: size?.h || 32, fs: 20, stroke: '#f2f2f2' };
      case 'rect':
      case 'ellipse':
      case 'diamond':
        return { ...base, w: size?.w || 160, h: size?.h || 110, fill: '#2a2a30', stroke: '#8d8d96', sw: 2, fs: 18, radius: type === 'rect' ? 10 : undefined };
      case 'frame':
        return { ...base, w: size?.w || 640, h: size?.h || 420, fill: '#ffffff08', stroke: '#ffffff26', name: 'Frame' };
      case 'line':
      case 'arrow':
        return { ...base, points: [0, 0, 0, 0], stroke: '#c9c9d1', sw: 2, head: type === 'arrow' ? 'arrow' : 'none', tail: 'none' };
      case 'pen':
        return { ...base, points: [0, 0, 0, 0], stroke: '#f2f2f2', sw: 3 };
      default:
        return base;
    }
  };

  /** Things that came in - files, a post, an item, text - onto the board at `at`. */
  const receive = async (d: Dropped, at: P) => {
    if (d.kind === 'item') {
      if (d.id === item.id) return;
      return add([{ id: newId(), type: 'item', x: r1(at.x - 140), y: r1(at.y - 60), w: 280, h: 128, ref: d.id }]);
    }
    if (d.kind === 'news') {
      setBusy('Saving the story…');
      const r = await saveNews(d.news, item.folderId);
      setBusy(null);
      if (r?.id) add([{ id: newId(), type: 'item', x: r1(at.x - 140), y: r1(at.y - 60), w: 280, h: 128, ref: r.id }]);
      return;
    }
    if (d.kind === 'text') {
      const tweet = findTweetUrl(d.text);
      if (tweet && d.text.trim().length < tweet.url.length + 60) {
        setBusy('Reading the post…');
        const r = await saveTweet(tweet.url, item.folderId);
        setBusy(null);
        if (r?.id) add([{ id: newId(), type: 'item', x: r1(at.x - 160), y: r1(at.y - 90), w: 320, h: 180, ref: r.id }]);
        return;
      }
      const el = make('sticky', { x: at.x - 100, y: at.y - 100 });
      return add([{ ...el, text: d.text.slice(0, 2000) }]);
    }
    // Files: images onto the board as its own, anything else into the folder and onto the board as a card.
    let x = at.x;
    const made: El[] = [];
    for (const f of d.files) {
      setBusy(`Adding ${f.name}…`);
      if (isImageFile(f)) {
        const size = await imageSize(f);
        const it = await attachImage(item, f, (share) => setBusy(`Uploading ${f.name} · ${Math.round(share * 100)}%`));
        if (!it) continue;
        const w = Math.min(480, size.w || 480);
        const h = size.w ? (w * size.h) / size.w : 320;
        made.push({ id: newId(), type: 'image', x: r1(x), y: r1(at.y - h / 2), w: r1(w), h: r1(h), file: it.id });
        x += w + 24;
      } else {
        const r = await saveFiles([f], item.folderId, (name, share) => setBusy(`Uploading ${name} · ${Math.round(share * 100)}%`));
        if (!r?.id) continue;
        made.push({ id: newId(), type: 'item', x: r1(x), y: r1(at.y - 60), w: 280, h: 128, ref: r.id });
        x += 304;
      }
    }
    setBusy(null);
    if (made.length) add(made);
  };

  /* -------------------------------------------------------------- pointer ----- */

  const onCanvasDown = (e: ReactPointerEvent) => {
    host.current?.focus({ preventScroll: true });
    if (editing) setEditing(null);
    const p = toWorld(e.clientX, e.clientY);
    if (e.button === 1 || space || tool === 'hand') {
      e.preventDefault();
      return setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, v: viewRef.current });
    }
    if (e.button !== 0) return;
    if (tool === 'select') {
      if (!e.shiftKey) setSel(new Set());
      return setDrag({ kind: 'marquee', a: p, b: p, add: e.shiftKey ? new Set(sel) : new Set() });
    }
    start(tool, p);
  };

  /** A drawing tool, pressed at `p` (on the canvas or over a thing). */
  const start = (t: Tool, p: P, overId?: string) => {
    const base = elsRef.current;
    if (t === 'pen') {
      const el = make('pen', p);
      setEls([...base, el]);
      return setDrag({ kind: 'pen', id: el.id, pts: [p], base });
    }
    if (t === 'line' || t === 'arrow') {
      const over = overId ? byId.get(overId) : undefined;
      const el = { ...make(t, p), ...(over && isAttachable(over) ? { from: over.id } : {}) };
      setEls([...base, lineThrough(el, p, p)]);
      return setDrag({ kind: 'create', id: el.id, a: p, base });
    }
    if (t === 'select' || t === 'hand') return;
    const el = make(t, p, { w: 1, h: 1 });
    setEls([...base, el]);
    setDrag({ kind: 'create', id: el.id, a: p, base });
  };

  const onElementDown = (e: ReactPointerEvent, id: string) => {
    host.current?.focus({ preventScroll: true });
    if (e.button === 1 || space || tool === 'hand') {
      e.stopPropagation();
      e.preventDefault();
      return setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, v: viewRef.current });
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toWorld(e.clientX, e.clientY);
    if (tool !== 'select') return start(tool, p, id);
    if (editing === id) return;
    if (editing) setEditing(null);
    let next = sel;
    if (e.shiftKey) {
      next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else if (!sel.has(id)) next = new Set([id]);
    setSel(next);
    const ids = movedWith(elsRef.current, next);
    const box = unionBox(elsRef.current.filter((x) => ids.has(x.id)).map(boxOf));
    if (!ids.size || !box) return;
    setDrag({ kind: 'move', start: p, base: elsRef.current, ids, box, moved: false });
  };

  const onHandleDown = (e: ReactPointerEvent, handle: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    const base = elsRef.current;
    const chosen = base.filter((x) => sel.has(x.id) && !x.lock);
    const start = unionBox(chosen.map(boxOf));
    if (!start) return;
    setDrag({ kind: 'resize', handle, start, base, ids: new Set(chosen.map((x) => x.id)), single: chosen.length === 1 ? chosen[0]! : null });
  };

  const onEndDown = (e: ReactPointerEvent, id: string, end: 'a' | 'b') => {
    e.stopPropagation();
    e.preventDefault();
    setDrag({ kind: 'end', id, end, base: elsRef.current });
  };

  /** The attachable thing under a board point (for an arrow's end), not `except`. */
  const attachableAt = (p: P, except: string): El | null => {
    const list = elsRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i]!;
      if (x.id === except || !isAttachable(x) || x.type === 'frame') continue;
      if (p.x >= x.x && p.x <= x.x + x.w && p.y >= x.y && p.y <= x.y + x.h) return x;
    }
    return null;
  };

  useEffect(() => {
    if (!drag) return;
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = toWorld(ev.clientX, ev.clientY);
      const z = viewRef.current.z;
      switch (d.kind) {
        case 'pan':
          return setView({ ...d.v, x: d.v.x + ev.clientX - d.sx, y: d.v.y + ev.clientY - d.sy });
        case 'marquee': {
          const b = boxFrom(d.a, p);
          const hit = elsRef.current.filter((x) => intersects(b, boxOf(x))).map((x) => x.id);
          setSel(new Set([...d.add, ...hit]));
          return setDrag({ ...d, b: p });
        }
        case 'move': {
          let dx = p.x - d.start.x;
          let dy = p.y - d.start.y;
          if (!d.moved && Math.hypot(dx * z, dy * z) < 3) return;
          if (!ev.altKey) {
            const others = d.base.filter((x) => !d.ids.has(x.id) && !isLine(x) && x.type !== 'pen').map(boxOf);
            const s = snap({ ...d.box, x: d.box.x + dx, y: d.box.y + dy }, others, 6 / z);
            dx += s.dx;
            dy += s.dy;
            setGuides(s.guides);
          } else setGuides([]);
          setEls(moveBy(d.base, d.ids, dx, dy));
          if (!d.moved) setDrag({ ...d, moved: true });
          return;
        }
        case 'resize': {
          const to = resizeBox(d.start, d.handle, p, ev.shiftKey || d.single?.type === 'image');
          if (d.single && !isLine(d.single) && d.single.type !== 'pen') {
            return setEls(settleLines(d.base.map((x) => (x.id === d.single!.id ? { ...x, ...to } : x))));
          }
          return setEls(scaleGroup(d.base, d.ids, d.start, to));
        }
        case 'create': {
          const el = d.base.length < elsRef.current.length ? elsRef.current.find((x) => x.id === d.id) : null;
          if (!el) return;
          if (isLine(el)) {
            // The end follows the pointer, and holds on to the thing it is over; an attached end sits on its edge.
            const over = attachableAt(p, el.id);
            const draft = { ...el, to: over?.id };
            const ends = lineEnds(lineThrough(draft, d.a, p), new Map(d.base.map((x) => [x.id, x])));
            return setEls([...d.base, lineThrough(draft, ends.a, ends.b)]);
          }
          let b = boxFrom(d.a, p);
          if (ev.shiftKey) {
            const s = Math.max(b.w, b.h);
            b = { x: p.x < d.a.x ? d.a.x - s : d.a.x, y: p.y < d.a.y ? d.a.y - s : d.a.y, w: s, h: s };
          }
          return setEls([...d.base, { ...el, x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) }]);
        }
        case 'pen': {
          const pts = [...d.pts, p];
          const el = elsRef.current.find((x) => x.id === d.id);
          if (!el) return;
          setDrag({ ...d, pts });
          return setEls([...d.base, penFrom(el, pts)]);
        }
        case 'end': {
          const el = d.base.find((x) => x.id === d.id);
          if (!el) return;
          const ends = lineEnds(el, new Map(d.base.map((x) => [x.id, x])));
          const over = attachableAt(p, el.id);
          const nextEl = { ...el, ...(d.end === 'a' ? { from: over?.id } : { to: over?.id }) };
          const a = d.end === 'a' ? p : ends.a;
          const b = d.end === 'b' ? p : ends.b;
          return setEls(settleLines(d.base.map((x) => (x.id === el.id ? lineThrough(nextEl, a, b) : x))));
        }
      }
    };
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      setGuides([]);
      if (!d) return;
      const now = elsRef.current;
      switch (d.kind) {
        case 'move':
          if (d.moved) commit(now, d.base);
          return;
        case 'resize':
        case 'end':
          if (now !== d.base) commit(now, d.base);
          return;
        case 'create': {
          const el = now.find((x) => x.id === d.id);
          if (!el) return;
          // A click without a drag makes the thing at its usual size.
          const tiny = isLine(el) ? Math.hypot(el.w, el.h) < 4 : el.w < 6 && el.h < 6;
          let made = el;
          if (tiny) {
            if (isLine(el)) made = lineThrough(el, d.a, { x: d.a.x + 160, y: d.a.y });
            else {
              const full = make(el.type, d.a);
              made = { ...full, id: el.id, x: r1(d.a.x - full.w / 2), y: r1(d.a.y - full.h / 2) };
            }
          }
          const next = settleLines([...d.base, made]);
          commit(next, d.base);
          setSel(new Set([made.id]));
          setTool('select');
          if (hasText(made)) setEditing(made.id);
          return;
        }
        case 'pen': {
          const el = now.find((x) => x.id === d.id);
          if (!el || d.pts.length < 2) return void setEls(d.base);
          commit([...d.base, penFrom(el, thin(d.pts, 1.5 / viewRef.current.z))], d.base);
          return;
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    // The handlers read the latest state through refs; they are bound once per drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind]);

  /* ------------------------------------------------------------- keyboard ----- */

  const onKey = (e: ReactKeyboardEvent) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (k === ' ') {
      e.preventDefault();
      if (!space) setSpace(true);
      return;
    }
    if (mod && k === 'z') {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && k === 'y') return void (e.preventDefault(), redo());
    if (mod && k === 'a') return void (e.preventDefault(), setSel(new Set(els.map((x) => x.id))));
    if (mod && (k === 'c' || k === 'x')) {
      const chosen = els.filter((x) => sel.has(x.id));
      if (!chosen.length) return;
      e.preventDefault();
      clipboard = chosen.map((x) => ({ ...x }));
      if (k === 'x') remove(sel);
      return;
    }
    if (mod && k === 'v' && clipboard.length) {
      // The system clipboard is read by the paste event (files, text); ours here.
      e.preventDefault();
      const c = viewportCenter();
      const b = unionBox(clipboard.map(boxOf))!;
      const made = duplicate(clipboard, c.x - (b.x + b.w / 2), c.y - (b.y + b.h / 2));
      return add(made);
    }
    if (mod && k === 'd') {
      e.preventDefault();
      const chosen = els.filter((x) => sel.has(x.id));
      if (chosen.length) add(duplicate(chosen, 24, 24));
      return;
    }
    if (mod && (k === '=' || k === '+')) return void (e.preventDefault(), zoomBy(1.25));
    if (mod && k === '-') return void (e.preventDefault(), zoomBy(0.8));
    if (mod && k === '0') return void (e.preventDefault(), setView((v) => ({ ...v, z: 1 })));
    if (e.shiftKey && (k === '!' || e.code === 'Digit1')) return void (e.preventDefault(), fit());
    if (k === 'delete' || k === 'backspace') return void (e.preventDefault(), remove(sel));
    if (k === 'escape') {
      setSel(new Set());
      setTool('select');
      return;
    }
    if (k === 'enter' && sel.size === 1) {
      const only = byId.get([...sel][0]!);
      if (only && hasText(only)) {
        e.preventDefault();
        setEditing(only.id);
      }
      return;
    }
    if (k.startsWith('arrow') && sel.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
      const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
      commit(moveBy(els, movedWith(els, sel), dx, dy));
      return;
    }
    if (k === ']' || k === '[') return void order(k === ']' ? 'front' : 'back');
    if (!mod && !e.altKey && TOOL_KEYS[k]) {
      setTool(TOOL_KEYS[k]!);
      if (k === 'i') fileInput.current?.click();
    }
  };

  const order = (to: 'front' | 'back') => {
    if (!sel.size) return;
    const chosen = els.filter((x) => sel.has(x.id));
    const rest = els.filter((x) => !sel.has(x.id));
    commit(to === 'front' ? [...rest, ...chosen] : [...chosen, ...rest]);
  };

  // Files and text pasted onto the board (while it has focus).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!host.current || document.activeElement !== host.current || editing) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!files.length && !text.trim()) return;
      e.preventDefault();
      void receive(files.length ? { kind: 'files', files } : { kind: 'text', text }, viewportCenter());
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  /* ---------------------------------------------------------------- menus ----- */

  const elementMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const ids = sel.has(id) ? sel : new Set([id]);
    if (!sel.has(id)) setSel(ids);
    const chosen = els.filter((x) => ids.has(x.id));
    const locked = chosen.every((x) => x.lock);
    const one = chosen.length === 1 ? chosen[0]! : null;
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        ...(one?.type === 'item' && one.ref ? [{ label: 'Open', icon: MENU_ICONS.open, onClick: () => onOpenItem(one.ref!) }] : []),
        ...(one && hasText(one) ? [{ label: 'Edit text', icon: MENU_ICONS.rename, onClick: () => setEditing(one.id) }] : []),
        { label: 'Bring to front', icon: MENU_ICONS.front, onClick: () => order('front') },
        { label: 'Send to back', icon: MENU_ICONS.back, onClick: () => order('back') },
        { label: 'Duplicate', icon: MENU_ICONS.duplicate, onClick: () => add(duplicate(chosen, 24, 24)) },
        { label: locked ? 'Unlock' : 'Lock', icon: locked ? MENU_ICONS.unlock : MENU_ICONS.lock, onClick: () => patch(ids, () => ({ lock: locked ? undefined : true })) },
        { label: 'Delete', icon: MENU_ICONS.remove, danger: true, onClick: () => remove(ids) },
      ],
    });
  };

  const canvasMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        ...(clipboard.length ? [{ label: 'Paste here', icon: MENU_ICONS.add, onClick: () => { const b = unionBox(clipboard.map(boxOf))!; add(duplicate(clipboard, at.x - b.x, at.y - b.y)); } }] : []),
        { label: 'Sticky note here', icon: MENU_ICONS.add, onClick: () => { const s = make('sticky', { x: at.x - 100, y: at.y - 100 }); add([s]); setEditing(s.id); } },
        { label: 'Card of an item here', icon: MENU_ICONS.folder, onClick: () => setPicker(at) },
        { label: 'Image here', icon: MENU_ICONS.add, onClick: () => { pendingImageAt.current = at; fileInput.current?.click(); } },
        { label: 'Select everything', icon: MENU_ICONS.show, onClick: () => setSel(new Set(els.map((x) => x.id))) },
        { label: 'Show everything', icon: MENU_ICONS.show, onClick: fit },
        { label: bg === 'dots' ? 'Grid background' : bg === 'grid' ? 'No background' : 'Dotted background', icon: MENU_ICONS.settings, onClick: () => { setBg(bg === 'dots' ? 'grid' : bg === 'grid' ? 'none' : 'dots'); save.touched(); } },
      ],
    });
  };

  /* --------------------------------------------------------------- render ----- */

  const chosen = els.filter((x) => sel.has(x.id));
  const selBox = unionBox(chosen.map(boxOf));
  const single = chosen.length === 1 ? chosen[0]! : null;
  const z = view.z;
  const editingEl = editing ? byId.get(editing) ?? null : null;
  const grid = 24 * z;
  const hostStyle: CSSProperties =
    bg === 'none'
      ? {}
      : {
          backgroundSize: `${grid}px ${grid}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundImage:
            bg === 'dots'
              ? `radial-gradient(circle, rgba(255,255,255,${z < 0.5 ? 0.06 : 0.11}) ${Math.max(0.6, 1.1 * Math.min(z, 1.4))}px, transparent 0)`
              : 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
        };
  const cursor = space || tool === 'hand' ? (drag?.kind === 'pan' ? 'grabbing' : 'grab') : tool === 'select' ? 'default' : 'crosshair';

  return (
    <div className="kb">
      <ConflictBar
        status={save.status}
        message={save.message}
        onKeep={save.keepMine}
        onLoad={() =>
          void save.loadTheirs().then((fresh) => {
            if (!fresh) return;
            const d = fresh.data as BoardData;
            setEls(settleLines(d.elements));
            setBg(d.bg ?? 'dots');
          })
        }
      />
      <div
        ref={host}
        className={`kb-canvas${drag?.kind === 'marquee' ? ' is-marquee' : ''}`}
        style={{ ...hostStyle, cursor }}
        tabIndex={0}
        aria-label="Board"
        onPointerDown={onCanvasDown}
        onContextMenu={canvasMenu}
        onKeyDown={onKey}
        onKeyUp={(e) => e.key === ' ' && setSpace(false)}
        onBlur={() => setSpace(false)}
        onDoubleClick={(e) => {
          if (e.target !== host.current || tool !== 'select') return;
          const p = toWorld(e.clientX, e.clientY);
          const t = make('text', { x: p.x, y: p.y - 16 });
          add([t]);
          setEditing(t.id);
        }}
        onDragOver={(e) => {
          if (!canKeep(Array.from(e.dataTransfer.types))) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes(DRAG_ITEM) ? 'link' : 'copy';
        }}
        onDrop={(e) => {
          const d = readDrop(e.dataTransfer);
          if (!d) return;
          e.preventDefault();
          void receive(d, toWorld(e.clientX, e.clientY));
        }}
      >
        <div className="kb-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${z})` }}>
          {els.map((el) => (
            <Thing key={el.id} el={el} byId={byId} z={z} editing={editing === el.id} onDown={onElementDown} onMenu={elementMenu} onOpen={onOpenItem} onEdit={setEditing} />
          ))}
          {/* What is selected: outlines, then the handles of one thing or of the group. */}
          {chosen.map((x) =>
            isLine(x) || x.type === 'pen' ? null : <div key={`o${x.id}`} className={`kb-outline${x.lock ? ' is-locked' : ''}`} style={{ left: x.x, top: x.y, width: x.w, height: x.h, borderWidth: 1.5 / z }} />,
          )}
          {selBox && chosen.length > 1 && <div className="kb-outline kb-outline--group" style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h, borderWidth: 1 / z }} />}
          {!drag && selBox && !(single && (isLine(single) || single.lock)) && !editing &&
            HANDLES.map((h) => <span key={h} className={`kb-handle kb-handle--${h}`} style={handleStyle(h, selBox, z)} onPointerDown={(e) => onHandleDown(e, h)} />)}
          {single && isLine(single) && !single.lock && (() => {
            const { a, b } = lineEnds(single, byId);
            return (
              <>
                <span className={`kb-end${single.from ? ' is-attached' : ''}`} style={endStyle(a, z)} onPointerDown={(e) => onEndDown(e, single.id, 'a')} />
                <span className={`kb-end${single.to ? ' is-attached' : ''}`} style={endStyle(b, z)} onPointerDown={(e) => onEndDown(e, single.id, 'b')} />
              </>
            );
          })()}
          {guides.map((g, i) => (
            <span key={i} className="kb-guide" style={g.axis === 'x' ? { left: g.at, top: g.from, width: 1 / z, height: g.to - g.from } : { left: g.from, top: g.at, height: 1 / z, width: g.to - g.from }} />
          ))}
          {drag?.kind === 'marquee' && (() => {
            const b = boxFrom(drag.a, drag.b);
            return <span className="kb-marquee" style={{ left: b.x, top: b.y, width: b.w, height: b.h, borderWidth: 1 / z }} />;
          })()}
          {editingEl && (
            <TextEditor
              el={editingEl}
              onDone={(text, h) => {
                setEditing(null);
                const cur = elsRef.current.find((x) => x.id === editingEl.id);
                if (!cur) return;
                const trimmed = text.replace(/\s+$/, '');
                if (cur.type === 'text' && !trimmed) return remove([cur.id]);
                if (trimmed === (cur.text ?? '') && (cur.type !== 'text' || !h || Math.abs(h - cur.h) < 1)) return;
                patch([cur.id], () => ({ text: trimmed || undefined, ...(cur.type === 'text' && h ? { h: r1(h) } : {}) }));
              }}
            />
          )}
        </div>
        {els.length === 0 && !drag && (
          <div className="kb-empty" aria-hidden="true">
            <b>An empty board</b>
            <span>Pick a tool below - or drop images, files, posts from X and items from your folders here. Double-click to write.</span>
          </div>
        )}
      </div>

      {chosen.length > 0 && !editing && <Props chosen={chosen} onPatch={(f) => patch(sel, f)} onOrder={order} onDelete={() => remove(sel)} onDuplicate={() => add(duplicate(chosen, 24, 24))} />}

      <div className="kb-tools" role="toolbar" aria-label="Board tools">
        {TOOLS.map(([t, label, key, icon]) => (
          <button key={t} type="button" className={`kb-tool${tool === t ? ' is-on' : ''}`} aria-label={`${label} (${key})`} title={`${label} · ${key}`} aria-pressed={tool === t} onClick={() => setTool(t)}>
            {icon}
          </button>
        ))}
        <span className="kb-tools__sep" />
        {tool === 'sticky' && (
          <span className="kb-stickies">
            {STICKY.map((c) => (
              <button key={c} type="button" className={`kb-stickies__c${c === stickyColor ? ' is-on' : ''}`} style={{ background: c }} aria-label={`Sticky color ${c}`} onClick={() => setStickyColor(c)} />
            ))}
          </span>
        )}
        <button type="button" className="kb-tool" aria-label="Image (I)" title="Image · I" onClick={() => { pendingImageAt.current = null; fileInput.current?.click(); }}>{IC.image}</button>
        <button type="button" className="kb-tool" aria-label="Card of an item" title="Card of an item from your folders" onClick={() => setPicker(viewportCenter())}>{IC.card}</button>
      </div>

      <div className="kb-zoom" role="group" aria-label="View">
        <button type="button" className="kb-tool" aria-label="Undo" title="Undo · Ctrl+Z" disabled={!past.current.length} onClick={undo}>{IC.undo}</button>
        <button type="button" className="kb-tool" aria-label="Redo" title="Redo · Ctrl+Shift+Z" disabled={!future.current.length} onClick={redo}>{IC.redo}</button>
        <span className="kb-tools__sep" />
        <button type="button" className="kb-tool" aria-label="Zoom out" title="Zoom out · Ctrl −" onClick={() => zoomBy(0.8)}>{IC.minus}</button>
        <button type="button" className="kb-zoom__pct" title="Show everything · Shift+1" onClick={fit}>{Math.round(z * 100)}%</button>
        <button type="button" className="kb-tool" aria-label="Zoom in" title="Zoom in · Ctrl +" onClick={() => zoomBy(1.25)}>{IC.plus}</button>
      </div>
      {busy && <p className="kb-busy" role="status"><span className="fx-spin" aria-hidden="true" />{busy}</p>}

      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          setTool('select');
          if (files.length) void receive({ kind: 'files', files }, pendingImageAt.current ?? viewportCenter());
        }}
      />
      {picker && (
        <CardPicker
          exclude={item.id}
          onPick={(id) => {
            const at = picker;
            setPicker(null);
            add([{ id: newId(), type: 'item', x: r1(at.x - 140), y: r1(at.y - 64), w: 280, h: 128, ref: id }]);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {menu && <TabMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function handleStyle(h: Handle, b: Box, z: number): CSSProperties {
  const s = 9 / z;
  const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2;
  const y = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2;
  return { left: x - s / 2, top: y - s / 2, width: s, height: s, borderWidth: 1.5 / z, borderRadius: 2 / z };
}
const endStyle = (p: P, z: number): CSSProperties => {
  const s = 11 / z;
  return { left: p.x - s / 2, top: p.y - s / 2, width: s, height: s, borderWidth: 2 / z };
};

async function imageSize(f: File): Promise<{ w: number; h: number }> {
  try {
    const b = await createImageBitmap(f);
    const out = { w: b.width, h: b.height };
    b.close();
    return out;
  } catch {
    return { w: 0, h: 0 };
  }
}

/* ------------------------------------------------------------------ one thing ----- */

const Thing = memo(function Thing({ el, byId, z, editing, onDown, onMenu, onOpen, onEdit }: {
  el: El;
  byId: ReadonlyMap<string, El>;
  z: number;
  editing: boolean;
  onDown: (e: ReactPointerEvent, id: string) => void;
  onMenu: (e: ReactMouseEvent, id: string) => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const common = {
    'data-id': el.id,
    onPointerDown: (e: ReactPointerEvent) => onDown(e, el.id),
    onContextMenu: (e: ReactMouseEvent) => onMenu(e, el.id),
    onDoubleClick: (e: ReactMouseEvent) => {
      e.stopPropagation();
      if (el.type === 'item' && el.ref) onOpen(el.ref);
      else if (hasText(el)) onEdit(el.id);
    },
  };
  const op = el.op ?? 1;
  if (isLine(el) || el.type === 'pen') return <Stroke el={el} byId={byId} z={z} common={common} />;
  const box: CSSProperties = { left: el.x, top: el.y, width: el.w, height: el.h, opacity: op };
  const text = !editing && el.text ? el.text : '';
  switch (el.type) {
    case 'sticky':
      return (
        <div className="kb-thing kb-sticky" style={{ ...box, background: el.fill ?? STICKY[0], color: inkOn(el.fill ?? STICKY[0]) }} {...common}>
          <span className="kb-text" style={textStyle(el, 'l', 't')}>{text}</span>
        </div>
      );
    case 'text':
      return (
        <div className="kb-thing kb-textel" style={{ ...box, color: el.stroke ?? '#f2f2f2' }} {...common}>
          <span className="kb-text kb-text--free" style={textStyle(el, 'l', 't')}>{text || (editing ? '' : ' ')}</span>
        </div>
      );
    case 'frame':
      return (
        <div className="kb-thing kb-frame" style={{ ...box, background: el.fill ?? '#ffffff08', borderColor: el.stroke ?? '#ffffff26', borderWidth: 1 / z }} {...common}>
          <span className="kb-frame__name" style={{ fontSize: 12 / z, top: -18 / z }}>{el.name ?? 'Frame'}</span>
        </div>
      );
    case 'image':
      return <ImageThing el={el} box={box} common={common} />;
    case 'item':
      return <ItemThing el={el} box={box} common={common} />;
    default:
      return <ShapeThing el={el} box={box} common={common} text={text} />;
  }
});

const textStyle = (el: El, al: 'l' | 'c' | 'r', va: 't' | 'm' | 'b'): CSSProperties => ({
  fontSize: el.fs ?? 18,
  fontWeight: el.bold ? 700 : el.type === 'text' ? 500 : 450,
  textAlign: ({ l: 'left', c: 'center', r: 'right' } as const)[el.align ?? al],
  justifyContent: ({ t: 'flex-start', m: 'center', b: 'flex-end' } as const)[el.valign ?? va],
});

function ShapeThing({ el, box, common, text }: { el: El; box: CSSProperties; common: object; text: string }) {
  const sw = el.sw ?? 2;
  const dash = el.dash === 'dashed' ? `${sw * 4} ${sw * 3}` : el.dash === 'dotted' ? `${sw} ${sw * 2.2}` : undefined;
  const fill = el.fill ?? '#2a2a30';
  const stroke = el.stroke ?? '#8d8d96';
  const w = Math.max(1, el.w);
  const h = Math.max(1, el.h);
  const shape =
    el.type === 'ellipse' ? (
      <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0.5, w / 2 - sw / 2)} ry={Math.max(0.5, h / 2 - sw / 2)} />
    ) : el.type === 'diamond' ? (
      <polygon points={`${w / 2},${sw / 2} ${w - sw / 2},${h / 2} ${w / 2},${h - sw / 2} ${sw / 2},${h / 2}`} strokeLinejoin="round" />
    ) : (
      <rect x={sw / 2} y={sw / 2} width={Math.max(0, w - sw)} height={Math.max(0, h - sw)} rx={Math.min(el.radius ?? 0, w / 2, h / 2)} />
    );
  return (
    <div className="kb-thing kb-shape" style={{ ...box, color: inkOn(fill) }} {...common}>
      <svg className="kb-shape__svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill={fill} stroke={sw ? stroke : 'none'} strokeWidth={sw} strokeDasharray={dash} aria-hidden="true">
        {shape}
      </svg>
      <span className="kb-text kb-text--shape" style={textStyle(el, 'c', 'm')}>{text}</span>
    </div>
  );
}

function ImageThing({ el, box, common }: { el: El; box: CSSProperties; common: object }) {
  const url = useFileUrl(el.file ?? null);
  return (
    <div className="kb-thing kb-image" style={box} {...common}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="kb-image__wait"><span className="fx-spin" aria-hidden="true" /></span>}
    </div>
  );
}

function ItemThing({ el, box, common }: { el: El; box: CSSProperties; common: object }) {
  const s = useFolders();
  const it = s.list?.folders.flatMap((f) => f.items).find((i) => i.id === el.ref) ?? null;
  const picture = it && (it.kind === 'chart' ? (it.meta.thumb ? it.id : null) : it.kind === 'file' && /png|jpeg|webp|gif/.test(it.meta.fileType ?? '') ? it.id : null);
  const url = useFileUrl(picture ?? null, it?.kind === 'chart');
  const tall = el.h >= 170;
  return (
    <div className={`kb-thing kb-item${it ? '' : ' is-gone'}`} style={box} {...common} title={it ? 'Double-click to open' : undefined}>
      {tall && url && <span className="kb-item__pic"><img src={url} alt="" draggable={false} /></span>}
      <span className="kb-item__row">
        {it ? <KindIcon item={it} size={16} /> : <KindIcon kind="doc" size={16} />}
        <span className="kb-item__body">
          <b>{it ? it.title : 'Not in your folders any more'}</b>
          <small>{it ? `${KIND_LABEL[it.kind]} · ${itemLine(it)}` : 'Deleted'}</small>
        </span>
      </span>
      {it && (it.kind === 'tweet' || it.kind === 'doc') && it.meta.excerpt && !(tall && url) && <span className="kb-item__x">{it.meta.excerpt}</span>}
    </div>
  );
}

/** A line, an arrow or a pen stroke: its own SVG over its box (with room for the heads). */
function Stroke({ el, byId, z, common }: { el: El; byId: ReadonlyMap<string, El>; z: number; common: object }) {
  const sw = el.sw ?? 2;
  const pad = sw * 4 + 12;
  const stroke = el.stroke ?? '#c9c9d1';
  let d: string;
  let heads: ReactNode = null;
  let bx: number;
  let by: number;
  let bw: number;
  let bh: number;
  if (el.type === 'pen') {
    const p = el.points ?? [];
    bx = el.x;
    by = el.y;
    bw = el.w;
    bh = el.h;
    d = smooth(p);
  } else {
    const { a, b } = lineEnds(el, byId);
    bx = Math.min(a.x, b.x);
    by = Math.min(a.y, b.y);
    bw = Math.abs(b.x - a.x);
    bh = Math.abs(b.y - a.y);
    const A = { x: a.x - bx + pad, y: a.y - by + pad };
    const B = { x: b.x - bx + pad, y: b.y - by + pad };
    d = `M${A.x},${A.y} L${B.x},${B.y}`;
    heads = (
      <>
        {endMark(el.head ?? (el.type === 'arrow' ? 'arrow' : 'none'), A, B, sw, stroke)}
        {endMark(el.tail ?? 'none', B, A, sw, stroke)}
      </>
    );
  }
  const off = el.type === 'pen' ? pad : 0;
  const dash = el.dash === 'dashed' ? `${sw * 4} ${sw * 3}` : el.dash === 'dotted' ? `${sw} ${sw * 2.2}` : undefined;
  return (
    <svg
      className="kb-thing kb-stroke"
      style={{ left: bx - pad, top: by - pad, width: bw + pad * 2, height: bh + pad * 2, opacity: el.op ?? 1 }}
      width={bw + pad * 2}
      height={bh + pad * 2}
      {...common}
    >
      <g transform={off ? `translate(${off},${off})` : undefined}>
        <path className="kb-stroke__hit" d={d} strokeWidth={Math.max(sw + 10 / z, 12 / z)} />
        <path d={d} fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} />
      </g>
      {heads}
    </svg>
  );
}

/** A stroke through relative points, smoothed (midpoint quadratic curves). */
function smooth(p: readonly number[]): string {
  if (p.length < 4) return '';
  let d = `M${p[0]},${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i]! + p[i + 2]!) / 2;
    const my = (p[i + 1]! + p[i + 3]!) / 2;
    d += ` Q${p[i]},${p[i + 1]} ${mx},${my}`;
  }
  d += ` L${p[p.length - 2]},${p[p.length - 1]}`;
  return d;
}

/** The mark at end `at` of a line coming from `from`. */
function endMark(kind: BoardEnd, from: P, at: P, sw: number, color: string): ReactNode {
  if (kind === 'none') return null;
  const ang = Math.atan2(at.y - from.y, at.x - from.x);
  const L = 7 + sw * 3;
  const pt = (a: number, r: number) => `${at.x + Math.cos(a) * r},${at.y + Math.sin(a) * r}`;
  if (kind === 'arrow') return <path d={`M${pt(ang + Math.PI - 0.5, L)} L${at.x},${at.y} L${pt(ang + Math.PI + 0.5, L)}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
  if (kind === 'triangle') return <path d={`M${pt(ang + Math.PI - 0.45, L)} L${at.x},${at.y} L${pt(ang + Math.PI + 0.45, L)} Z`} fill={color} stroke={color} strokeWidth={sw} strokeLinejoin="round" />;
  if (kind === 'dot') return <circle cx={at.x} cy={at.y} r={2 + sw * 1.4} fill={color} />;
  return <path d={`M${pt(ang + Math.PI / 2, L * 0.6)} L${pt(ang - Math.PI / 2, L * 0.6)}`} stroke={color} strokeWidth={sw} strokeLinecap="round" />;
}

/* ---------------------------------------------------------------- writing ----- */

function TextEditor({ el, onDone }: { el: El; onDone: (text: string, height: number | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [v, setV] = useState(el.text ?? '');
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(ref.current?.value ?? v, el.type === 'text' ? (ref.current?.scrollHeight ?? null) : null);
  };
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  // A free text grows with what is written.
  useEffect(() => {
    const t = ref.current;
    if (t && el.type === 'text') {
      t.style.height = 'auto';
      t.style.height = `${Math.max(el.h, t.scrollHeight)}px`;
    }
  }, [v, el.type, el.h]);
  const fill = el.type === 'sticky' ? el.fill ?? STICKY[0] : isShape(el) ? el.fill ?? '#2a2a30' : undefined;
  const centered = isShape(el);
  return (
    <textarea
      ref={ref}
      className={`kb-edit${centered ? ' is-centered' : ''}${el.type === 'sticky' ? ' is-sticky' : ''}`}
      value={v}
      maxLength={10_000}
      style={{
        left: el.x,
        top: el.y,
        width: el.w,
        height: el.type === 'text' ? undefined : el.h,
        fontSize: el.fs ?? 18,
        fontWeight: el.bold ? 700 : el.type === 'text' ? 500 : 450,
        textAlign: ({ l: 'left', c: 'center', r: 'right' } as const)[el.align ?? (centered ? 'c' : 'l')],
        color: el.type === 'text' ? el.stroke ?? '#f2f2f2' : inkOn(fill),
      }}
      onChange={(e) => setV(e.target.value)}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          finish();
        }
      }}
    />
  );
}

/* --------------------------------------------------------------- properties ----- */

function Props({ chosen, onPatch, onOrder, onDelete, onDuplicate }: {
  chosen: El[];
  onPatch: (f: (e: El) => Partial<El> | null) => void;
  onOrder: (to: 'front' | 'back') => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const [open, setOpen] = useState<'fill' | 'stroke' | null>(null);
  const filled = chosen.filter((e) => e.type === 'sticky' || isShape(e) || e.type === 'frame');
  const stroked = chosen.filter((e) => isShape(e) || isLine(e) || e.type === 'pen' || e.type === 'text' || e.type === 'frame');
  const widths = chosen.filter((e) => isShape(e) || isLine(e) || e.type === 'pen');
  const texts = chosen.filter(hasText);
  const lines = chosen.filter(isLine);
  const first = chosen[0]!;
  const locked = chosen.every((e) => e.lock);
  const swatch = (kind: 'fill' | 'stroke', colors: string[]) => (
    <span className="kb-props__pop">
      {colors.map((c) => (
        <button key={c} type="button" className={`kb-props__c${c === NONE ? ' is-none' : ''}`} style={{ background: c === NONE ? undefined : c }} aria-label={c === NONE ? 'None' : c} onClick={() => { onPatch((e) => (kind === 'fill' ? (filled.includes(e) ? { fill: c } : null) : stroked.includes(e) ? { stroke: c } : null)); setOpen(null); }} />
      ))}
    </span>
  );
  return (
    <div className="kb-props" role="toolbar" aria-label="Selected" onPointerDown={(e) => e.stopPropagation()}>
      {filled.length > 0 && (
        <span className="kb-props__group">
          <button type="button" className="kb-props__chip" title="Fill" onClick={() => setOpen(open === 'fill' ? null : 'fill')}>
            <span className="kb-props__dot" style={{ background: filled[0]!.fill ?? '#2a2a30' }} />Fill
          </button>
          {open === 'fill' && swatch('fill', filled.every((e) => e.type === 'sticky') ? STICKY : [...STICKY.slice(0, 3), ...COLORS, NONE])}
        </span>
      )}
      {stroked.length > 0 && (
        <span className="kb-props__group">
          <button type="button" className="kb-props__chip" title={texts.length === chosen.length && chosen.every((e) => e.type === 'text') ? 'Text color' : 'Line color'} onClick={() => setOpen(open === 'stroke' ? null : 'stroke')}>
            <span className="kb-props__dot kb-props__dot--ring" style={{ borderColor: stroked[0]!.stroke ?? '#c9c9d1' }} />{chosen.every((e) => e.type === 'text') ? 'Color' : 'Line'}
          </button>
          {open === 'stroke' && swatch('stroke', [...COLORS, NONE])}
        </span>
      )}
      {widths.length > 0 && (
        <span className="kb-props__seg" role="group" aria-label="Line width">
          {[1, 2, 4, 8].map((w) => (
            <button key={w} type="button" className={(widths[0]!.sw ?? 2) === w ? 'is-on' : ''} title={`${w} px`} onClick={() => onPatch((e) => (widths.includes(e) ? { sw: w } : null))}>
              <span style={{ height: Math.min(w, 6), width: 14 }} />
            </button>
          ))}
        </span>
      )}
      {widths.length > 0 && (
        <span className="kb-props__seg" role="group" aria-label="Line style">
          {(['solid', 'dashed', 'dotted'] as const).map((d) => (
            <button key={d} type="button" className={(widths[0]!.dash ?? 'solid') === d ? 'is-on' : ''} title={d} onClick={() => onPatch((e) => (widths.includes(e) ? { dash: d === 'solid' ? undefined : d } : null))}>
              {d === 'solid' ? '—' : d === 'dashed' ? '- -' : '···'}
            </button>
          ))}
        </span>
      )}
      {lines.length > 0 && (
        <span className="kb-props__seg" role="group" aria-label="Ends">
          <select aria-label="Start" value={lines[0]!.tail ?? 'none'} onChange={(e) => onPatch((x) => (isLine(x) ? { tail: e.target.value as BoardEnd } : null))}>
            {ENDS.map((x) => <option key={x} value={x}>{x === 'none' ? 'Start: none' : `Start: ${x}`}</option>)}
          </select>
          <select aria-label="End" value={lines[0]!.head ?? (lines[0]!.type === 'arrow' ? 'arrow' : 'none')} onChange={(e) => onPatch((x) => (isLine(x) ? { head: e.target.value as BoardEnd } : null))}>
            {ENDS.map((x) => <option key={x} value={x}>{x === 'none' ? 'End: none' : `End: ${x}`}</option>)}
          </select>
        </span>
      )}
      {texts.length > 0 && (
        <>
          <span className="kb-props__seg" role="group" aria-label="Text size">
            {FONT_SIZES.map(([l, s]) => (
              <button key={l} type="button" className={Math.round(texts[0]!.fs ?? 18) === s ? 'is-on' : ''} onClick={() => onPatch((e) => (hasText(e) ? { fs: s } : null))}>{l}</button>
            ))}
          </span>
          <span className="kb-props__seg" role="group" aria-label="Alignment">
            {(['l', 'c', 'r'] as const).map((a) => (
              <button key={a} type="button" className={(texts[0]!.align ?? (isShape(texts[0]!) ? 'c' : 'l')) === a ? 'is-on' : ''} aria-label={a === 'l' ? 'Left' : a === 'c' ? 'Center' : 'Right'} onClick={() => onPatch((e) => (hasText(e) ? { align: a } : null))}>
                {a === 'l' ? IC.left : a === 'c' ? IC.center : IC.right}
              </button>
            ))}
            <button type="button" className={texts[0]!.bold ? 'is-on' : ''} aria-label="Bold" onClick={() => onPatch((e) => (hasText(e) ? { bold: e.bold ? undefined : true } : null))}><b>B</b></button>
          </span>
        </>
      )}
      <label className="kb-props__op" title="Opacity">
        <input type="range" min={10} max={100} step={5} value={Math.round((first.op ?? 1) * 100)} onChange={(e) => onPatch(() => ({ op: Number(e.target.value) >= 100 ? undefined : Number(e.target.value) / 100 }))} />
      </label>
      <span className="kb-props__seg">
        <button type="button" title="Bring to front · ]" aria-label="Bring to front" onClick={() => onOrder('front')}>{MENU_ICONS.front}</button>
        <button type="button" title="Send to back · [" aria-label="Send to back" onClick={() => onOrder('back')}>{MENU_ICONS.back}</button>
        <button type="button" title={locked ? 'Unlock' : 'Lock'} aria-label={locked ? 'Unlock' : 'Lock'} className={locked ? 'is-on' : ''} onClick={() => onPatch(() => ({ lock: locked ? undefined : true }))}>{locked ? MENU_ICONS.lock : MENU_ICONS.unlock}</button>
        <button type="button" title="Duplicate · Ctrl+D" aria-label="Duplicate" onClick={onDuplicate}>{MENU_ICONS.duplicate}</button>
        <button type="button" title="Delete" aria-label="Delete" className="is-danger" onClick={onDelete}>{MENU_ICONS.remove}</button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------- icons ----- */

const ic = (d: ReactNode) => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IC = {
  select: ic(<path d="M5 3.5 15 9l-4.5 1.3L8.6 15z" />),
  hand: ic(<path d="M7 9.5V5a1.2 1.2 0 0 1 2.4 0v4M9.4 8.5V4a1.2 1.2 0 0 1 2.4 0v4.5M11.8 9V5.2a1.2 1.2 0 0 1 2.4 0V11c0 3-2 5.5-5 5.5-2 0-3.2-1-4.3-2.6L3.5 11.6a1.2 1.2 0 0 1 2-1.4L7 12" />),
  sticky: ic(<><path d="M4 4h12v8l-4 4H4z" /><path d="M12 16v-4h4" /></>),
  text: ic(<path d="M4.5 5h11M10 5v11M7.5 16h5" />),
  rect: ic(<rect x="3.5" y="4.5" width="13" height="11" rx="2" />),
  ellipse: ic(<ellipse cx="10" cy="10" rx="6.5" ry="5.5" />),
  diamond: ic(<path d="m10 3 7 7-7 7-7-7z" />),
  line: ic(<path d="M4 16 16 4" />),
  arrow: ic(<><path d="M4 16 16 4" /><path d="M9.5 4H16v6.5" /></>),
  pen: ic(<path d="M3.5 15.5c2-3 3.5-7 6-7s1 5 3.5 5 2.5-4 3.5-6" />),
  frame: ic(<path d="M6 3v14M14 3v14M3 6h14M3 14h14" />),
  image: ic(<><rect x="3" y="4" width="14" height="12" rx="2" /><circle cx="7.5" cy="8" r="1.4" /><path d="m3.5 15 4.5-4.5 3 3 2.2-2.2L17 15" /></>),
  card: ic(<><rect x="3" y="5" width="14" height="10" rx="2" /><path d="M6 8.5h8M6 11.5h5" /></>),
  undo: ic(<><path d="M6.5 8H12a3.5 3.5 0 0 1 0 7H8.5" /><path d="M9 5 6 8l3 3" /></>),
  redo: ic(<><path d="M13.5 8H8a3.5 3.5 0 0 0 0 7h3.5" /><path d="m11 5 3 3-3 3" /></>),
  plus: ic(<path d="M10 4.5v11M4.5 10h11" />),
  minus: ic(<path d="M4.5 10h11" />),
  left: ic(<path d="M3.5 5h13M3.5 8.5h8M3.5 12h13M3.5 15.5h8" />),
  center: ic(<path d="M3.5 5h13M6 8.5h8M3.5 12h13M6 15.5h8" />),
  right: ic(<path d="M3.5 5h13M8.5 8.5h8M3.5 12h13M8.5 15.5h8" />),
};

const TOOLS: Array<[Tool, string, string, ReactNode]> = [
  ['select', 'Select', 'V', IC.select],
  ['hand', 'Hand', 'H', IC.hand],
  ['frame', 'Frame', 'F', IC.frame],
  ['sticky', 'Sticky note', 'S', IC.sticky],
  ['text', 'Text', 'T', IC.text],
  ['rect', 'Rectangle', 'R', IC.rect],
  ['ellipse', 'Ellipse', 'O', IC.ellipse],
  ['diamond', 'Diamond', 'D', IC.diamond],
  ['line', 'Line', 'L', IC.line],
  ['arrow', 'Arrow', 'A', IC.arrow],
  ['pen', 'Pen', 'P', IC.pen],
];
