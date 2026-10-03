/**
 * What the guide prints. ASCII only - it has to read the same in cmd.exe, in
 * Windows PowerShell 5.1 and in a log file - and every line goes through the
 * key redactor first.
 */

export const WIDTH = 78;

/** Typographic characters that have a plain spelling; anything else outside ASCII becomes "?". */
const PLAIN: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/[→⇒⟶➜]/g, '->'],
  [/[←⇐]/g, '<-'],
  [/[↔⇄⇔]/g, '<->'],
  [/[✓✔✅]/g, 'ok'],
  [/[✖✗✘❌]/g, 'x'],
  [/ℹ️?/g, 'i'],
  [/×/g, 'x'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/≈/g, '~'],
  [/µ/g, 'u'],
  [/[   ]/g, ' '],
  [/[·•●]/g, '*'],
  [/[▶▸►]/g, '>'],
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
];

/** Colour and cursor escape sequences. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function toAscii(s: string): string {
  let out = s.replace(ANSI, '');
  for (const [re, to] of PLAIN) out = out.replace(re, to);
  // Tabs and line breaks stay; every other control or non-ASCII character becomes "?".
  return out.replace(/[^\t\n\r\x20-\x7E]/g, '?');
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

export const fmtUsd = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '-' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);

/** `text` cut to `width` characters, with "..." when something was cut. */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : width <= 3 ? text.slice(0, width) : `${text.slice(0, width - 3)}...`;
}

/** Break `text` into lines of at most `width`, at spaces; a word longer than a line stays whole. */
export function wrap(text: string, width: number, indent = ''): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (indent + line + ' ' + word).length > width) {
        out.push(indent + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(indent + line);
  }
  return out;
}

/** A plain text table: columns padded to their widest cell, a dashed line under the header. */
export function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>, o: { right?: readonly number[]; max?: readonly number[] } = {}): string[] {
  const all = [headers, ...rows].map((r) => r.map((c, i) => (o.max?.[i] ? clip(toAscii(c ?? ''), o.max[i]!) : toAscii(c ?? ''))));
  const width = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const fmt = (r: readonly string[]): string =>
    r.map((c, i) => (o.right?.includes(i) ? (c ?? '').padStart(width[i]!) : (c ?? '').padEnd(width[i]!))).join('  ').trimEnd();
  return [fmt(all[0]!), width.map((w) => '-'.repeat(w)).join('  '), ...all.slice(1).map(fmt)];
}

export interface OutputOptions {
  /** A console: the live line can be redrawn in place. */
  tty: boolean;
  /** The console's width - or how to read it now (the window can be resized while the guide runs). */
  columns?: number | (() => number | undefined);
  /** Every finished line, already plain and redacted (the session transcript). */
  transcript?: (line: string) => void;
}

/** The one way anything reaches the screen. */
export class Output {
  /** Replaced while a key is in memory: every line is passed through it. */
  redact: (s: string) => string = (s) => s;
  private liveLen = 0;

  constructor(
    private readonly write: (s: string) => void,
    private readonly o: OutputOptions,
  ) {}

  get tty(): boolean {
    return this.o.tty;
  }

  private clean(s: string): string {
    return this.redact(toAscii(s));
  }

  line(s = ''): void {
    this.clearLive();
    for (const part of this.clean(s).split('\n')) {
      this.write(`${part}\n`);
      this.o.transcript?.(part);
    }
  }

  lines(xs: readonly string[], indent = ''): void {
    for (const x of xs) this.line(`${indent}${x}`);
  }

  /** Text without a line break after it (a question the owner answers on the same line). */
  prompt(s: string): void {
    this.clearLive();
    const t = this.clean(s);
    this.write(t);
    this.o.transcript?.(t);
  }

  /** The line that is redrawn in place while something runs. On anything but a console it prints nothing. */
  live(s: string): void {
    if (!this.o.tty) return;
    const cols = typeof this.o.columns === 'function' ? this.o.columns() : this.o.columns;
    const width = Math.max(20, (cols ?? 80) - 1);
    const t = clip(this.clean(s).replace(/\n/g, ' '), width);
    this.write(`\r${t}${' '.repeat(Math.max(0, this.liveLen - t.length))}`);
    this.liveLen = t.length;
  }

  clearLive(): void {
    if (!this.liveLen) return;
    this.write(`\r${' '.repeat(this.liveLen)}\r`);
    this.liveLen = 0;
  }

  rule(ch = '-'): void {
    this.line(ch.repeat(WIDTH));
  }

  banner(title: string, right = ''): void {
    this.line('='.repeat(WIDTH));
    this.line(` ${title}${right ? right.padStart(Math.max(1, WIDTH - 2 - title.length)) : ''}`);
    this.line('='.repeat(WIDTH));
  }

  /** "Step 3 of 8 - Read-only live checks                               (stage B)". */
  step(n: number, total: number, title: string, stage: string | null): void {
    const left = ` Step ${n} of ${total} - ${title}`;
    const right = stage ? `(stage ${stage})` : '';
    this.line();
    this.rule();
    this.line(`${left}${right ? right.padStart(Math.max(1, WIDTH - left.length)) : ''}`);
    this.rule();
  }

  /** A paragraph, wrapped. */
  say(text: string, indent = ' '): void {
    this.lines(wrap(text, WIDTH, indent));
  }

  /**
   * One result: `  PASS    title .............  12 s  detail`. A detail that does
   * not fit on the line goes underneath, wrapped - a failure's reason is never cut.
   */
  result(status: string, title: string, detail = '', ms?: number | null): void {
    for (const l of resultLines(status, title, detail, ms)) this.line(l);
  }
}

const TITLE_WIDTH = 50;
/** The widest line a result may be before its detail moves underneath (fits a 120-column console). */
const RESULT_MAX = 116;

export function resultLines(status: string, title: string, detail = '', ms?: number | null): string[] {
  const t = toAscii(title);
  const dots = t.length < TITLE_WIDTH - 1 ? ` ${'.'.repeat(TITLE_WIDTH - 1 - t.length)}` : '';
  // No duration given: no duration column (a fact that was looked up, not something that ran).
  const head = `  ${status.padEnd(7)} ${clip(t, TITLE_WIDTH)}${ms === undefined ? '' : `${dots} ${fmtDur(ms).padStart(6)}`}`;
  const d = toAscii(detail).replace(/\s+/g, ' ').trim();
  if (!d) return [head];
  if (head.length + 2 + d.length <= RESULT_MAX) return [`${head}  ${d}`];
  return [head, ...wrap(d, 100, ' '.repeat(10))];
}
