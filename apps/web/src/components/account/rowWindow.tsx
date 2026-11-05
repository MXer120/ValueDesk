/**
 * Only the rows near the view of a long account table are in the page.
 *
 * A market maker's open orders and a long history are hundreds of rows of which about seven show. All of them
 * rendered, a tab took 250 ms to open on a mid-range laptop's speed and every stream push re-rendered them
 * (measured 2026-11-05: e2e/perf/heavyAccount.ts). Up to WINDOW_FROM rows nothing changes.
 *
 * The rows left out are replaced by one spacer above and one below, so the scrollbar and the rows' places are
 * as they were. A table lays its columns out from the rows it holds, so once windowed its column widths are
 * held (table-layout: fixed, from what the browser laid out): scrolling does not move the columns. They are laid
 * out again when the panel's width changes, and a column widens when a row comes that would not fit. What a
 * browser's find-in-page cannot see is the one thing lost: rows far from the view are not in the page.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefCallback } from 'react';

export const WINDOW_FROM = 60;
/** Rows kept beyond the view on each side; a scroll inside them renders nothing. */
export const OVERSCAN = 12;
const DEFAULT_ROW_PX = 32;

export interface RowRange { from: number; to: number }

/** The rows `viewTop`..`viewTop + viewHeight` (px from the first row) touch, with OVERSCAN either side. */
export function rowRange(viewTop: number, viewHeight: number, rowPx: number, count: number): RowRange {
  const first = Math.floor(Math.max(0, viewTop) / rowPx);
  const last = Math.ceil((Math.max(0, viewTop) + Math.max(0, viewHeight)) / rowPx);
  return { from: Math.max(0, Math.min(first, count) - OVERSCAN), to: Math.min(count, last + OVERSCAN) };
}

/** Whether what `shown` holds still covers `want` without the overscan: if so, no new render. */
export function covers(shown: RowRange, viewFirst: number, viewLast: number, count: number): boolean {
  return shown.from <= viewFirst && Math.min(shown.to, count) >= Math.min(viewLast, count);
}

function release(table: HTMLTableElement, heads: HTMLTableCellElement[]): void {
  table.style.width = '';
  table.style.tableLayout = '';
  for (const th of heads) th.style.width = '';
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return null;
}

export interface RowWindow {
  /** On the table's <tbody>. */
  ref: RefCallback<HTMLTableSectionElement>;
  from: number;
  to: number;
  /** Heights of the spacers above and below (RowSpacer). */
  top: number;
  bottom: number;
}

export function useRowWindow(count: number): RowWindow {
  const windowed = count > WINDOW_FROM;
  const [body, setBody] = useState<HTMLTableSectionElement | null>(null);
  const [range, setRange] = useState<RowRange>({ from: 0, to: WINDOW_FROM });
  const [rowPx, setRowPx] = useState(DEFAULT_ROW_PX);
  const [widthSeen, setWidthSeen] = useState(0);
  const countRef = useRef(count);
  countRef.current = count;
  const ref = useCallback<RefCallback<HTMLTableSectionElement>>((el) => setBody(el), []);

  const look = useCallback(() => {
    if (!body) return;
    const row = body.querySelector<HTMLElement>(':scope > tr:not(.acct-spacer)');
    const px = row?.offsetHeight || 0;
    if (px > 0) setRowPx((was) => (was === px ? was : px));
    const h = px > 0 ? px : DEFAULT_ROW_PX;
    const scroller = scrollerOf(body);
    const box = body.getBoundingClientRect();
    const viewTopEdge = scroller ? scroller.getBoundingClientRect().top : 0;
    const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;
    const top = viewTopEdge - box.top;
    const n = countRef.current;
    const first = Math.floor(Math.max(0, top) / h);
    const last = Math.ceil((Math.max(0, top) + viewHeight) / h);
    setRange((was) => (covers(was, first, last, n) ? was : rowRange(top, viewHeight, h, n)));
  }, [body]);

  useLayoutEffect(() => {
    if (windowed) look();
  }, [windowed, look, count]);

  useEffect(() => {
    if (!windowed || !body) return;
    const scroller = scrollerOf(body);
    const target: HTMLElement | Window = scroller ?? window;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        look();
        setWidthSeen(body.closest('table')?.parentElement?.clientWidth ?? 0);
      });
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    // Its tab shown again, a panel resized.
    const seen = new ResizeObserver(onScroll);
    seen.observe(scroller ?? body);
    return () => {
      target.removeEventListener('scroll', onScroll);
      seen.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [windowed, body, look]);

  // The columns held: laid out once by the browser, then fixed until the panel's width changes.
  const held = useRef({ width: -1, cols: -1 });
  useLayoutEffect(() => {
    const table = body?.closest('table');
    const heads = table?.tHead?.rows[0]?.cells;
    if (!table || !heads || !body) return;
    const cells = Array.from(heads);
    if (!windowed) {
      if (held.current.width >= 0) release(table, cells);
      held.current = { width: -1, cols: -1 };
      return;
    }
    const room = table.parentElement?.clientWidth ?? 0;
    if (!room) return; // A hidden tab: laid out when it shows.
    if (held.current.width !== room || held.current.cols !== cells.length) {
      release(table, cells);
      const widths = cells.map((th) => th.offsetWidth);
      table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
      table.style.tableLayout = 'fixed';
      cells.forEach((th, i) => { th.style.width = `${widths[i]}px`; });
      held.current = { width: room, cols: cells.length };
      return;
    }
    // Rows that have just come in: a figure wider than its column widens the column.
    let grew = 0;
    for (const row of Array.from(body.rows)) {
      if (row.classList.contains('acct-spacer')) continue;
      Array.from(row.cells).forEach((td, i) => {
        const over = td.scrollWidth - td.clientWidth;
        const th = cells[i];
        if (over > 0 && th) {
          th.style.width = `${th.offsetWidth + over}px`;
          grew += over;
        }
      });
    }
    if (grew) table.style.width = `${table.offsetWidth + grew}px`;
  }, [windowed, body, range.from, range.to, widthSeen]);

  if (!windowed) return { ref, from: 0, to: count, top: 0, bottom: 0 };
  const from = Math.min(range.from, count);
  const to = Math.min(Math.max(range.to, from), count);
  return { ref, from, to, top: from * rowPx, bottom: (count - to) * rowPx };
}

/** One spacer row. Nothing to read or to hover. */
export function RowSpacer({ height }: { height: number }) {
  if (height <= 0) return null;
  return (
    <tr className="acct-spacer" aria-hidden="true" style={{ height }}>
      <td colSpan={99} />
    </tr>
  );
}
