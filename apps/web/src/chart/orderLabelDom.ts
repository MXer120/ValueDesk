/**
 * What an order line says, as HTML over the chart, because only HTML can blur what lies behind it: a canvas cannot.
 * The line itself, its drag and the hit areas of its buttons stay on the canvas (orderOverlays.ts). This layer takes
 * no pointer, and each box is exactly as wide as its hit area because both read one width.
 *
 * Bots hold hundreds of lines, and this runs after every draw of the chart, so:
 *   - only labels inside the pane have a node, reused by key; a node that leaves is hidden, not rebuilt;
 *   - a node is touched only where it changed, moved by transform, and nothing here reads layout;
 *   - at most BLUR_CAP labels blur at a time (each is a render pass); the rest take a solid tint (chart.css), as do
 *     all of them in potato mode.
 */
export const BLUR_CAP = 30;
/** A price tag in the axis is another pass, and tells less: tags blur only while few labels show. */
export const AXIS_BLUR_CAP = 12;

/** One box as chart/orderOverlays.ts describes it. */
export interface LabelBox {
  text: string;
  look: 'solid' | 'value' | 'outline' | 'cross';
  color: string;
  family: string;
}

export interface DomLabel {
  key: string;
  /** Centre of the label from the top of the pane, in whole pixels. */
  y: number;
  /** A position's label is the last to lose its blur. */
  first: boolean;
  /** The text the overlay was last given: the same text is the same label. */
  data: string;
  boxes: readonly LabelBox[];
  axisText: string;
  color: string;
}

const LABEL_HALF = 9;

/** Which rows show in a pane this tall, a row's whole box counting: no node for the hundreds that do not. */
export function labelsInPane<T extends { y: number }>(rows: readonly T[], height: number): T[] {
  return rows.filter((r) => r.y + LABEL_HALF >= 0 && r.y - LABEL_HALF <= height);
}

/**
 * The labels that may blur: all up to the cap, then positions and those nearest the middle of the pane, where the
 * price is. A row's distance only changes the choice when the set is over the cap.
 */
export function pickBlurred(rows: readonly Pick<DomLabel, 'key' | 'y' | 'first'>[], middle: number, cap = BLUR_CAP): Set<string> {
  if (rows.length <= cap) return new Set(rows.map((r) => r.key));
  const ranked = [...rows].sort((a, b) => Number(b.first) - Number(a.first) || Math.abs(a.y - middle) - Math.abs(b.y - middle) || (a.key < b.key ? -1 : 1));
  return new Set(ranked.slice(0, cap).map((r) => r.key));
}

interface Row {
  el: HTMLDivElement;
  axis: HTMLSpanElement;
  data: string | null;
  /** Looks and colours of the boxes: while it stands, a new figure only changes words. */
  shape: string;
  y: number;
  shown: boolean;
  blur: boolean;
  axisBlur: boolean;
  seen: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function crossIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M1.75 1.75l6.5 6.5M8.25 1.75l-6.5 6.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.2');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

export class OrderLabelDom {
  private readonly root: HTMLDivElement;
  private readonly rows = new Map<string, Row>();
  private pass = 0;
  private size = '';
  private left = 0;

  constructor(
    host: HTMLElement,
    private readonly widthOf: (box: LabelBox) => number,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'kc-lbls';
    this.root.setAttribute('aria-hidden', 'true');
    host.appendChild(this.root);
  }

  /** `left`: where labels start, from the chart's left edge. */
  paint(labels: readonly DomLabel[], pane: { left: number; top: number; height: number }, axisOnRight: boolean): void {
    const size = `${pane.left}|${pane.top}|${pane.height}|${axisOnRight}`;
    if (size !== this.size) {
      this.size = size;
      this.root.style.top = `${pane.top}px`;
      this.root.style.height = `${pane.height}px`;
      this.root.classList.toggle('is-axis-left', !axisOnRight);
      for (const row of this.rows.values()) row.y = Number.NaN;
      this.left = pane.left;
    }
    const blurred = pickBlurred(labels, pane.height / 2);
    const axisBlurs = labels.length <= AXIS_BLUR_CAP;
    this.pass++;
    for (const label of labels) {
      const row = this.rows.get(label.key) ?? this.make(label.key);
      row.seen = this.pass;
      if (row.data !== label.data) this.write(row, label);
      if (row.y !== label.y) {
        row.y = label.y;
        row.el.style.transform = `translate(${this.left}px, ${label.y - LABEL_HALF}px)`;
        row.axis.style.transform = `translateY(${label.y - LABEL_HALF}px)`;
      }
      const blur = blurred.has(label.key);
      if (row.blur !== blur) {
        row.blur = blur;
        row.el.classList.toggle('is-blur', blur);
      }
      const axisBlur = blur && axisBlurs;
      if (row.axisBlur !== axisBlur) {
        row.axisBlur = axisBlur;
        row.axis.classList.toggle('is-blur', axisBlur);
      }
      if (!row.shown) {
        row.shown = true;
        row.el.hidden = false;
        row.axis.hidden = false;
      }
    }
    for (const row of this.rows.values()) {
      if (row.seen === this.pass || !row.shown) continue;
      row.shown = false;
      row.el.hidden = true;
      row.axis.hidden = true;
    }
  }

  /** The line is gone for good. */
  drop(key: string): void {
    const row = this.rows.get(key);
    if (!row) return;
    row.el.remove();
    row.axis.remove();
    this.rows.delete(key);
  }

  dispose(): void {
    this.root.remove();
    this.rows.clear();
  }

  private make(key: string): Row {
    const el = document.createElement('div');
    el.className = 'kc-lbl';
    const axis = document.createElement('span');
    axis.className = 'kc-lbl__axis';
    this.root.append(el, axis);
    const row: Row = { el, axis, data: null, shape: '', y: Number.NaN, shown: true, blur: false, axisBlur: false, seen: 0 };
    this.rows.set(key, row);
    return row;
  }

  private write(row: Row, label: DomLabel): void {
    row.data = label.data;
    const shape = label.boxes.map((b) => `${b.look}:${b.color}:${b.family}`).join('|');
    if (shape !== row.shape) {
      row.shape = shape;
      row.el.replaceChildren(...label.boxes.map((b) => {
        const box = document.createElement('span');
        box.className = `kc-lbl__box is-${b.look}`;
        box.style.setProperty('--c', b.color);
        box.style.fontFamily = b.family;
        if (b.look === 'cross') box.appendChild(crossIcon());
        return box;
      }));
    }
    label.boxes.forEach((b, i) => {
      const box = row.el.children[i] as HTMLElement;
      const w = `${this.widthOf(b)}px`;
      if (box.style.width !== w) box.style.width = w;
      if (b.look !== 'cross' && box.textContent !== b.text) box.textContent = b.text;
    });
    row.axis.style.setProperty('--c', label.color);
    if (row.axis.textContent !== label.axisText) row.axis.textContent = label.axisText;
  }
}
