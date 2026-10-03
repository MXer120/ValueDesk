/**
 * Questions and answers.
 *
 * `Prompter` is the keyboard: at a console it reads lines the usual way and
 * reads the key with echo switched off; with stdin from a pipe or a file it
 * takes the lines in order (how the guide is tested).
 *
 * The helpers below it (confirm, choose, ...) are the only place `--yes` is
 * applied, and they can never apply it to a question marked `money`: a key, a
 * real-funds confirmation and anything that changes a file the owner did not
 * ask for are always asked.
 */
import { spawnSync } from 'node:child_process';
import type { Output } from './ui';
import { Stopped } from './types';

export interface Prompter {
  /** A person is at a console (stdin is a terminal). */
  readonly interactive: boolean;
  /** The next line typed; null when the input has ended. */
  ask(question: string): Promise<string | null>;
  /** The same without echo - for the key. null: ended, or Ctrl+C. */
  askHidden(question: string): Promise<string | null>;
  /** A line typed within `ms` (to stop or shorten a wait), else null. */
  waitLine(ms: number): Promise<string | null>;
  /** Ctrl+C: whatever question is open ends as "no answer" (null). */
  interrupt(): void;
  close(): void;
}

export interface StdinPrompterOptions {
  /** Reads the clipboard (Ctrl+V in a classic console window arrives as a key press, not as text). */
  clipboard?: () => string | null;
}

/** The Windows clipboard, through PowerShell. The text stays in memory: a pipe, no file. */
export function windowsClipboard(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
  } catch {
    return null;
  }
}

type Reader = NodeJS.ReadStream;

export class StdinPrompter implements Prompter {
  readonly interactive: boolean;
  private queue: string[] = [];
  private buf = '';
  private ended = false;
  private waiter: ((line: string | null) => void) | null = null;
  private secret: { text: string; done: (v: string | null) => void; esc: number } | null = null;
  /** The hidden prompt just ended on a CR: a LF that follows it belongs to the same Enter, not to the next question. */
  private dropLf = false;

  constructor(
    private readonly stdin: Reader,
    private readonly write: (s: string) => void,
    private readonly o: StdinPrompterOptions = {},
  ) {
    this.interactive = stdin.isTTY === true;
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string | Buffer) => this.onData(String(chunk)));
    stdin.on('end', () => this.onEnd());
    stdin.on('error', () => this.onEnd());
    stdin.resume();
  }

  private onEnd(): void {
    this.ended = true;
    if (this.buf) {
      this.queue.push(this.buf);
      this.buf = '';
    }
    this.flush();
    if (this.secret) {
      const s = this.secret;
      this.secret = null;
      s.done(null);
    }
  }

  private flush(): void {
    if (!this.waiter) return;
    if (this.queue.length) {
      const w = this.waiter;
      this.waiter = null;
      w(this.queue.shift()!);
    } else if (this.ended) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  private onData(chunk: string): void {
    if (this.secret) return this.onSecret(chunk);
    if (this.dropLf) {
      this.dropLf = false;
      if (chunk.startsWith('\n')) chunk = chunk.slice(1);
      if (!chunk) return;
    }
    this.buf += chunk;
    for (;;) {
      const i = this.buf.search(/\r\n|\n|\r/);
      if (i < 0) break;
      const nl = this.buf.startsWith('\r\n', i) ? 2 : 1;
      this.queue.push(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + nl);
    }
    this.flush();
  }

  /** Key presses while echo is off. Everything typed or pasted is kept; nothing is shown but one `*` per character. */
  private onSecret(chunk: string): void {
    const s = this.secret!;
    const finish = (v: string | null): void => {
      this.secret = null;
      try {
        this.stdin.setRawMode?.(false);
      } catch {
        /* the console is gone */
      }
      this.write('\n');
      s.done(v);
    };
    for (const ch of chunk) {
      const code = ch.codePointAt(0)!;
      if (s.esc === 2) {
        // Inside an escape sequence (arrow keys, bracketed-paste markers): skip to its final byte.
        if (code >= 0x40 && code <= 0x7e) s.esc = 0;
        continue;
      }
      if (s.esc === 1) {
        // What follows ESC: a sequence starts with [ or O; anything else was the Esc key alone, and this is a key of its own.
        s.esc = ch === '[' || ch === 'O' ? 2 : 0;
        if (s.esc === 2) continue;
      }
      if (ch === '\u001b') {
        s.esc = 1;
      } else if (ch === '\r' || ch === '\n') {
        if (!s.text && ch === '\n') continue; // the LF of a CRLF, or a stray one before anything was typed
        // The rest of this chunk is dropped; the LF of this Enter may still arrive in the next one.
        this.dropLf = ch === '\r';
        return finish(s.text);
      } else if (code === 0x03) {
        return finish(null); // Ctrl+C
      } else if (code === 0x08 || code === 0x7f) {
        if (s.text.length) {
          s.text = s.text.slice(0, -1);
          this.write('\b \b');
        }
      } else if (code === 0x15) {
        this.write('\b \b'.repeat(s.text.length)); // Ctrl+U: start over
        s.text = '';
      } else if (code === 0x16) {
        // Ctrl+V in a classic console window: the window does not paste for a program that reads keys, so read the clipboard here.
        const pasted = (this.o.clipboard?.() ?? '').split(/\r?\n/)[0]!.trim();
        s.text += pasted;
        this.write('*'.repeat(pasted.length));
      } else if (code >= 0x20) {
        s.text += ch;
        this.write('*');
      }
    }
  }

  private next(): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((res) => {
      this.waiter = res;
    });
  }

  async ask(question: string): Promise<string | null> {
    // At a console, what was typed BEFORE the question appeared is not an answer to it.
    if (this.interactive) this.queue.length = 0;
    this.write(question);
    const line = await this.next();
    // Scripted input is not echoed by anything: show it, so a transcript reads like a session -
    // unless it is the size of a key (someone answered a visible question with one).
    if (!this.interactive) this.write(`${line === null ? '(the input ended)' : /(?:0x)?[0-9a-fA-F]{64}/.test(line) ? '(not shown: that is the size of a private key)' : line}\n`);
    return line;
  }

  async askHidden(question: string): Promise<string | null> {
    this.write(question);
    if (!this.interactive || typeof this.stdin.setRawMode !== 'function') {
      const line = await this.next();
      this.write(line === null ? '(the input ended)\n' : '(hidden)\n');
      return line;
    }
    this.queue.length = 0;
    this.buf = '';
    this.stdin.setRawMode(true);
    return new Promise((done) => {
      this.secret = { text: '', done, esc: 0 };
    });
  }

  waitLine(ms: number): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return new Promise((res) => setTimeout(() => res(null), ms));
    return new Promise((res) => {
      const timer = setTimeout(() => {
        if (this.waiter === got) this.waiter = null;
        res(null);
      }, ms);
      const got = (line: string | null): void => {
        clearTimeout(timer);
        res(line);
      };
      this.waiter = got;
    });
  }

  interrupt(): void {
    if (this.secret) {
      const s = this.secret;
      this.secret = null;
      try {
        this.stdin.setRawMode?.(false);
      } catch {
        /* not a console */
      }
      s.done(null);
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  close(): void {
    try {
      this.stdin.setRawMode?.(false);
    } catch {
      /* not a console */
    }
    this.stdin.pause();
  }
}

// --- questions --------------------------------------------------------------------------------

export interface Asker {
  out: Output;
  prompter: Prompter;
  /** `--yes`: answer the non-money questions with their default. */
  auto: boolean;
}

const ended = (): never => {
  throw new Stopped('the input ended before the question was answered');
};

/** yes / no, with a default (Enter). `money` questions are never answered by `--yes`. */
export async function confirm(a: Asker, question: string, dflt: boolean, o: { money?: boolean } = {}): Promise<boolean> {
  const hint = dflt ? '[Y/n]' : '[y/N]';
  if (a.auto && !o.money) {
    a.out.line(` ${question} ${hint} ${dflt ? 'yes' : 'no'}   (--yes: the default)`);
    return dflt;
  }
  for (;;) {
    a.out.prompt(` ${question} ${hint} `);
    const raw = await a.prompter.ask('');
    if (raw === null) return ended();
    const s = raw.trim().toLowerCase();
    if (!s) return dflt;
    if (['y', 'yes', 'j', 'ja'].includes(s)) return true;
    if (['n', 'no', 'nein'].includes(s)) return false;
    a.out.line('   Type y or n, then Enter.');
  }
}

export interface Choice<T extends string> {
  key: T;
  /** What the owner types: 1, 2, 3 ... */
  label: string;
  /** Shown but not selectable, and why. */
  disabled?: string;
}

/** A numbered menu. Enter takes the default. */
export async function choose<T extends string>(a: Asker, question: string, options: ReadonlyArray<Choice<T>>, dflt: T, o: { money?: boolean } = {}): Promise<T> {
  a.out.line(` ${question}`);
  options.forEach((c, i) => a.out.line(`   ${i + 1}. ${c.label}${c.disabled ? `   (not available: ${c.disabled})` : ''}`));
  const dfltIndex = Math.max(0, options.findIndex((c) => c.key === dflt));
  if (a.auto && !o.money) {
    a.out.line(` Your choice [${dfltIndex + 1}]: ${dfltIndex + 1}   (--yes: the default)`);
    return options[dfltIndex]!.key;
  }
  for (;;) {
    a.out.prompt(` Your choice [${dfltIndex + 1}]: `);
    const raw = await a.prompter.ask('');
    if (raw === null) return ended();
    const s = raw.trim();
    const i = s ? Number(s) - 1 : dfltIndex;
    const c = Number.isInteger(i) ? options[i] : undefined;
    if (c && !c.disabled) return c.key;
    a.out.line(c ? `   That one is not available: ${c.disabled}.` : `   Type a number from 1 to ${options.length}, then Enter.`);
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

/** A typed value, checked. `auto` (with --yes) is the answer used instead of asking; without one the question is always asked. */
export async function askValue<T>(a: Asker, question: string, parse: (raw: string) => Parsed<T>, o: { auto?: string; money?: boolean } = {}): Promise<T> {
  if (a.auto && !o.money && o.auto !== undefined) {
    const r = parse(o.auto);
    if (r.ok) {
      a.out.line(` ${question} ${o.auto || '(Enter)'}   (--yes: the default)`);
      return r.value;
    }
  }
  for (;;) {
    a.out.prompt(` ${question} `);
    const raw = await a.prompter.ask('');
    if (raw === null) return ended();
    const r = parse(raw);
    if (r.ok) return r.value;
    a.out.line(`   ${r.problem}`);
  }
}

/** "Press Enter to continue" - a pause the owner ends. With --yes it does not pause. */
export async function pressEnter(a: Asker, text = 'Press Enter to continue.'): Promise<void> {
  if (a.auto) return;
  a.out.prompt(` ${text} `);
  if ((await a.prompter.ask('')) === null) ended();
}

/**
 * The owner must type `expected` (outer spaces aside). An address compares
 * without case (wallets show it both ways); a word like YES is taken only as
 * written (`exactCase`). Never answered by --yes. Returns false when they type
 * something else `tries` times, or "q".
 */
export async function typeExactly(a: Asker, question: string, expected: string, o: { exactCase?: boolean; tries?: number } = {}): Promise<boolean> {
  const tries = o.tries ?? 3;
  for (let i = 0; i < tries; i++) {
    a.out.prompt(` ${question} `);
    const raw = await a.prompter.ask('');
    if (raw === null) return ended();
    const s = raw.trim();
    if (o.exactCase ? s === expected : s.toLowerCase() === expected.toLowerCase()) return true;
    if (['q', 'quit', 'n', 'no', 'stop'].includes(s.toLowerCase())) return false;
    a.out.line(`   That does not match. ${i + 1 < tries ? 'Try again, or type q to stop.' : ''}`);
  }
  return false;
}
