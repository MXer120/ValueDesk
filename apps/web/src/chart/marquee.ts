/**
 * Which drawings a marked area takes in (Ctrl / ⌘ + drag on the plot,
 * Chart.tsx): a drawing is in when any part of it as drawn crosses the area -
 * a trend line passing through it, a horizontal line at a price inside it, a
 * rectangle overlapping it - not only when one of its anchors lies inside.
 *
 * Pure, in the pane's pixels; covered by marquee.test.ts.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A drawing as the area test sees it: its tool and its anchors on screen. */
export interface MarqueeItem {
  id: string;
  name: string;
  pts: Array<Partial<Pt>>;
}

/** The box two corners span, either way round. */
export const boxOf = (a: Pt, b: Pt): Box => ({
  left: Math.min(a.x, b.x),
  top: Math.min(a.y, b.y),
  right: Math.max(a.x, b.x),
  bottom: Math.max(a.y, b.y),
});

const grow = (b: Box, d: number): Box => ({ left: b.left - d, top: b.top - d, right: b.right + d, bottom: b.bottom + d });
const inside = (p: Pt, b: Box) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
const overlaps = (a: Box, b: Box) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

/** Whether the segment a-b crosses the box (Liang-Barsky clipping). */
export function segmentHits(a: Pt, b: Pt, box: Box): boolean {
  if (inside(a, box) || inside(b, box)) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x - box.left],
    [dx, box.right - a.x],
    [-dy, a.y - box.top],
    [dy, box.bottom - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** The segment a-b drawn on past b (a ray), or past both ends (a line), to well beyond any screen. */
const FAR = 1e6;
const extend = (a: Pt, b: Pt, both: boolean): [Pt, Pt] => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = (dx / len) * FAR;
  const uy = (dy / len) * FAR;
  return [both ? { x: a.x - ux, y: a.y - uy } : a, { x: a.x + ux, y: a.y + uy }];
};

/** Tools drawn as an area between their anchors: in when that area overlaps. */
const AREA = new Set([
  'ot_rect',
  'ot_gannBox',
  'ot_priceRange',
  'ot_dateRange',
  'ot_measure',
  'ot_longPosition',
  'ot_shortPosition',
  'ot_fibExtension',
]);
/** Point tools with a label beside the anchor: a little slack around it. */
const LABELS = new Set(['simpleAnnotation', 'ot_note', 'ot_arrow']);

/**
 * The ids of the drawings the box takes in, in the order given. `width` and
 * `height` are the pane's, for the lines that run to its edges.
 */
export function marqueeHits(items: readonly MarqueeItem[], boxIn: Box, width: number, height: number): string[] {
  // A pixel or two of slack, so a line drawn on the box's edge counts.
  const box = grow(boxIn, 2);
  const hits: string[] = [];
  for (const it of items) {
    const pts = it.pts.filter((p): p is Pt => typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y));
    const [a, b] = pts;
    if (!a) continue;
    let hit = false;
    switch (it.name) {
      case 'horizontalStraightLine':
      case 'simpleTag':
        hit = a.y >= box.top && a.y <= box.bottom;
        break;
      case 'priceLine':
        hit = segmentHits(a, { x: width, y: a.y }, box);
        break;
      case 'horizontalRayLine':
        hit = segmentHits(a, { x: b && b.x < a.x ? 0 : width, y: a.y }, box);
        break;
      case 'horizontalSegment':
        hit = segmentHits(a, { x: b ? b.x : a.x, y: a.y }, box);
        break;
      case 'verticalStraightLine':
        hit = a.x >= box.left && a.x <= box.right;
        break;
      case 'verticalRayLine':
        hit = segmentHits(a, { x: a.x, y: b && b.y < a.y ? 0 : height }, box);
        break;
      case 'verticalSegment':
        hit = segmentHits(a, { x: a.x, y: b ? b.y : a.y }, box);
        break;
      case 'ot_crossLine':
        hit = (a.y >= box.top && a.y <= box.bottom) || (a.x >= box.left && a.x <= box.right);
        break;
      case 'straightLine':
      case 'rayLine':
        hit = b ? segmentHits(...extend(a, b, it.name === 'straightLine'), box) : inside(a, box);
        break;
      case 'parallelStraightLine':
      case 'priceChannelLine': {
        if (!b) {
          hit = inside(a, box);
          break;
        }
        hit = segmentHits(...extend(a, b, true), box);
        const c = pts[2];
        if (!hit && c) hit = segmentHits(...extend(c, { x: c.x + (b.x - a.x), y: c.y + (b.y - a.y) }, true), box);
        break;
      }
      case 'fibonacciLine':
        // Its levels run the width of the pane between the two prices.
        hit = !!b && overlaps({ left: 0, right: width, top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) }, box);
        break;
      case 'ot_fibTimeZone':
        hit = a.x <= box.right;
        break;
      case 'ot_circle': {
        const r = b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
        hit = overlaps({ left: a.x - r, right: a.x + r, top: a.y - r, bottom: a.y + r }, box);
        break;
      }
      default:
        if (AREA.has(it.name) && pts.length > 1) {
          hit = overlaps(boxOf(pts.reduce((m, p) => ({ x: Math.min(m.x, p.x), y: Math.min(m.y, p.y) })), pts.reduce((m, p) => ({ x: Math.max(m.x, p.x), y: Math.max(m.y, p.y) }))), box);
        } else if (LABELS.has(it.name)) {
          hit = inside(a, grow(box, 10));
        } else {
          // Lines through their anchors in order (a trend line, a path, a
          // pattern); a triangle closes.
          hit = pts.some((p) => inside(p, box));
          for (let i = 1; !hit && i < pts.length; i++) hit = segmentHits(pts[i - 1]!, pts[i]!, box);
          if (!hit && it.name === 'ot_triangle' && pts.length === 3) hit = segmentHits(pts[2]!, pts[0]!, box);
        }
    }
    if (hit) hits.push(it.id);
  }
  return hits;
}
