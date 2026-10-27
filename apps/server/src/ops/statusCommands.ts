/**
 * The owner's status commands, one grammar for both ways in: the CLI on server 1
 * (tools/status-post.ts, deploy/server/bin/status.sh) and the owner's Telegram chat
 * (ops/statusTelegram.ts, which splits a message into words with tokenize()).
 *
 *   incident "<title>" --components=<ids|all> [--impact=minor|major|critical] [--start=<when>] ["<message>"]
 *   update <id> [<stage>] ["<message>"] [--title=..] [--impact=..] [--components=..] [--start=..] [--end=..]
 *   resolve <id> ["<message>"]                 an incident resolved, a maintenance completed
 *   maintenance "<title>" --start=<when> --end=<when> --components=<ids|all> ["<message>"]
 *   list [--all]                               open, upcoming and the last closed ones
 *   show <id>                                  one notice and its timeline
 *   delete <id>                                off the page entirely (the CLI only)
 *
 * <when>: now, +30m / +2h / +1d (from now; an --end from the start), 2026-10-28T02:00
 * or "2026-10-28 02:00" (UTC unless it says +02:00), or 02:00 (the next 02:00 UTC for a
 * maintenance, the last one for an incident's start). Components: website, api,
 * executor, indexer or all. Stages: investigating, identified, monitoring, resolved
 * (an incident); scheduled, in_progress, verifying, completed (a maintenance).
 */
import {
  IMPACTS, IMPACT_TEXT, STAGE_TEXT, fmtUtc, fmtWindow, noticePhase, stagesOf,
  type Impact, type Notice, type NoticeStage,
} from './statusModel.js';

export { fmtUtc, fmtWindow };
import { NoticeError, type NoticeStore } from './statusNotices.js';

export interface CommandResult {
  code: 0 | 1 | 2;
  text: string;
  /** Whether a notice was written (the caller refreshes the backup export). */
  changed?: boolean;
}

export const COMMAND_HELP = [
  'Status page commands:',
  '  incident "<title>" --components=executor --impact=major "<message>"',
  '  update <id> identified "<message>"      (investigating, identified, monitoring, resolved)',
  '  resolve <id> "<message>"',
  '  maintenance "<title>" --start=2026-10-28T02:00 --end=+1h --components=api,indexer "<message>"',
  '  update <id> --end=+30m "<message>"      (move a window; scheduled, in_progress, verifying, completed)',
  '  list | show <id> | delete <id>',
  'Times are UTC: now, +30m, +2h, 2026-10-28T02:00, 02:00. Components: website, api, executor, indexer, all.',
].join('\n');

const MIN = 60_000;
const DAY = 86_400_000;

// --- words ---------------------------------------------------------------------------

/**
 * A message's words the way a shell would split them: "double quotes" (and the curly
 * ones phones type) keep spaces, a dash a phone turned "--" into counts as "--".
 * Apostrophes are letters: "we're" stays one word.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | null = null;
  const close: Record<string, string> = { '"': '"', '\u201c': '\u201d', '\u201e': '\u201c', '\u00ab': '\u00bb', '\u201d': '\u201d' };
  for (const ch of text) {
    if (quote) {
      if (ch === close[quote] || (quote !== '"' && ch === '"')) quote = null;
      else cur += ch;
      continue;
    }
    if (ch in close) {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out.map((w) => w.replace(/^[—–](?=[a-z])/i, '--'));
}

interface Parsed {
  words: string[];
  flags: Map<string, string | true>;
}

function parse(argv: readonly string[], allowed: readonly string[]): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  for (const a of argv) {
    if (/^--[a-z]/i.test(a)) {
      const eq = a.indexOf('=');
      const name = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      if (!allowed.includes(name)) throw new NoticeError(`unknown option --${name}${allowed.length ? ` (here: ${allowed.map((x) => `--${x}`).join(' ')})` : ''}`);
      flags.set(name, eq < 0 ? true : a.slice(eq + 1));
    } else words.push(a);
  }
  return { words, flags };
}

const str = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  if (v === true) throw new NoticeError(`--${name} needs a value: --${name}=...`);
  return v;
};

// --- times ---------------------------------------------------------------------------

/**
 * A time the owner typed (see the header); `base` is what a "+2h" counts from, `prefer`
 * which 02:00 a bare clock time means. Throws NoticeError when it is not one.
 */
export function parseWhen(s: string, now: number, o: { base?: number; prefer?: 'future' | 'past' } = {}): number {
  const v = s.trim();
  if (/^now$/i.test(v)) return now;
  const rel = /^\+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?|d|days?)$/i.exec(v);
  if (rel) {
    const unit = rel[2]!.toLowerCase().startsWith('m') ? MIN : rel[2]!.toLowerCase().startsWith('h') ? 60 * MIN : DAY;
    return Math.round((o.base ?? now) + Number(rel[1]) * unit);
  }
  const clock = /^(\d{1,2}):(\d{2})(?:\s*UTC|Z)?$/i.exec(v);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h > 23 || m > 59) throw new NoticeError(`"${s}" is not a time of day`);
    const d = new Date(now);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
    if (o.prefer === 'past' ? t > now + MIN : t < now - MIN) t += o.prefer === 'past' ? -DAY : DAY;
    return t;
  }
  const full = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(v);
  if (full) {
    const zone = !full[3] || /^(z|utc)$/i.test(full[3]) ? 'Z' : full[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const t = Date.parse(`${full[1]}T${full[2] ?? '00:00'}${full[2] && full[2].length === 5 ? ':00' : ''}${zone}`);
    if (Number.isFinite(t)) return t;
  }
  throw new NoticeError(`"${s}" is not a time: now, +30m, +2h, 2026-10-28T02:00 or 02:00 (UTC)`);
}

// --- what the owner reads back ------------------------------------------------------------

const PHASE_TEXT = { active: 'open', resolved: 'resolved', upcoming: 'upcoming', in_progress: 'in progress', completed: 'completed' } as const;

/** One line per notice. */
export function noticeLine(n: Notice, now: number): string {
  const phase = noticePhase(n, now);
  const last = n.updates.at(-1)!;
  const parts = [`#${n.id}`, n.kind === 'incident' ? `${IMPACT_TEXT[n.impact ?? 'minor'].toLowerCase()} incident` : 'maintenance'];
  parts.push(n.kind === 'incident' && phase === 'active' ? `open (${STAGE_TEXT[last.stage].toLowerCase()})` : PHASE_TEXT[phase]);
  parts.push(n.components.join(','));
  parts.push(`"${n.title}"`);
  if (n.kind === 'maintenance') parts.push(fmtWindow(n.startsAt, n.endsAt!));
  else parts.push(n.closedAt !== null ? fmtWindow(n.startsAt, n.closedAt) : `since ${fmtUtc(n.startsAt)}`);
  return parts.join(' · ');
}

/** A notice with its timeline, newest update first. */
export function noticeText(n: Notice, now: number): string {
  const lines = [noticeLine(n, now)];
  for (const u of [...n.updates].reverse()) lines.push(`  ${fmtUtc(u.at)}  ${STAGE_TEXT[u.stage]}${u.text ? ` - ${u.text.replace(/\n/g, ' ')}` : ''}`);
  return lines.join('\n');
}

// --- the commands ------------------------------------------------------------------------

const idOf = (w: string | undefined): number => {
  const m = /^#?(\d{1,9})$/.exec(w ?? '');
  if (!m) throw new NoticeError(`which notice? give its number (list shows them)${w ? `, not "${w}"` : ''}`);
  return Number(m[1]);
};

const impactOf = (v: string | undefined): Impact | undefined => {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (!(IMPACTS as readonly string[]).includes(s)) throw new NoticeError(`the impact is minor, major or critical, not "${v}"`);
  return s as Impact;
};

const ALIASES: Record<string, string> = {
  maint: 'maintenance', maintenance: 'maintenance', incident: 'incident', update: 'update', resolve: 'resolve',
  complete: 'resolve', list: 'list', status: 'list', ls: 'list', show: 'show', delete: 'delete', help: 'help',
};

export interface CommandOptions {
  now?: number;
  /** `delete` is the CLI's only (default off). */
  allowDelete?: boolean;
  /** The page, named in what is said back. */
  site?: string;
}

/** Run one command against the notices. A command that cannot be done is not an error: its reason is the text, code 2. */
export function runStatusCommand(argv: readonly string[], store: NoticeStore, o: CommandOptions = {}): CommandResult {
  const now = o.now ?? Date.now();
  const page = `${(o.site ?? 'https://www.valuedesk.so').replace(/\/+$/, '')}/status`;
  const [first, ...rest] = argv;
  const cmd = ALIASES[(first ?? '').toLowerCase()];
  try {
    switch (cmd) {
      case undefined:
      case 'help':
        return { code: first && cmd !== 'help' ? 2 : 0, text: `${first && cmd !== 'help' ? `unknown command "${first}"\n` : ''}${COMMAND_HELP}` };

      case 'incident': {
        const p = parse(rest, ['components', 'impact', 'start', 'stage']);
        const [title, ...words] = p.words;
        const start = str(p, 'start');
        const stage = str(p, 'stage') as NoticeStage | undefined;
        const n = store.create({
          kind: 'incident',
          title: title ?? '',
          components: [str(p, 'components') ?? ''],
          impact: impactOf(str(p, 'impact')) ?? 'minor',
          startsAt: start === undefined ? undefined : parseWhen(start, now, { prefer: 'past' }),
          stage,
          text: words.join(' '),
        }, now);
        return { code: 0, changed: true, text: `posted ${noticeText(n, now)}\n${page}` };
      }

      case 'maintenance': {
        const p = parse(rest, ['components', 'start', 'end']);
        const [title, ...words] = p.words;
        const start = str(p, 'start');
        const end = str(p, 'end');
        if (!start || !end) throw new NoticeError('a maintenance needs --start=<when> and --end=<when> (UTC; --end=+1h counts from the start)');
        const startsAt = parseWhen(start, now, { prefer: 'future' });
        const n = store.create({
          kind: 'maintenance',
          title: title ?? '',
          components: [str(p, 'components') ?? ''],
          startsAt,
          endsAt: parseWhen(end, now, { base: startsAt, prefer: 'future' }),
          text: words.join(' '),
        }, now);
        return { code: 0, changed: true, text: `scheduled ${noticeText(n, now)}\n${page}` };
      }

      case 'update': {
        const p = parse(rest, ['title', 'impact', 'components', 'start', 'end', 'stage']);
        const [idWord, ...more] = p.words;
        const id = idOf(idWord);
        const current = store.get(id);
        if (!current) throw new NoticeError(`there is no notice #${id}`);
        let stage = str(p, 'stage') as NoticeStage | undefined;
        const maybeStage = more[0]?.toLowerCase().replace(/[- ]/g, '_');
        if (stage === undefined && maybeStage && (stagesOf(current.kind) as readonly string[]).includes(maybeStage)) {
          stage = maybeStage as NoticeStage;
          more.shift();
        } else if (stage === undefined && maybeStage && [...stagesOf('incident'), ...stagesOf('maintenance')].includes(maybeStage as NoticeStage)) {
          throw new NoticeError(`#${id} is ${current.kind === 'incident' ? 'an incident' : 'a maintenance'}: its stages are ${stagesOf(current.kind).join(', ')}`);
        }
        const start = str(p, 'start');
        const end = str(p, 'end');
        const startsAt = start === undefined ? undefined : parseWhen(start, now, { prefer: current.kind === 'incident' ? 'past' : 'future' });
        const components = str(p, 'components');
        const text = more.join(' ');
        const change = {
          stage,
          text: text || undefined,
          title: str(p, 'title'),
          impact: impactOf(str(p, 'impact')),
          components: components === undefined ? undefined : [components],
          startsAt,
          endsAt: end === undefined ? undefined : parseWhen(end, now, { base: startsAt ?? current.startsAt, prefer: 'future' }),
        };
        if (Object.values(change).every((v) => v === undefined)) throw new NoticeError('nothing to update: give a stage, a message or a change (--title, --impact, --components, --start, --end)');
        const n = store.update(id, change, now);
        return { code: 0, changed: true, text: `updated ${noticeText(n, now)}` };
      }

      case 'resolve': {
        const p = parse(rest, []);
        const [idWord, ...words] = p.words;
        const n = store.resolve(idOf(idWord), words.join(' ') || undefined, now);
        return { code: 0, changed: true, text: `${n.kind === 'incident' ? 'resolved' : 'completed'} ${noticeText(n, now)}` };
      }

      case 'list': {
        const p = parse(rest, ['all']);
        const all = store.all();
        const open = all.filter((n) => ['active', 'in_progress', 'upcoming'].includes(noticePhase(n, now)));
        const closed = all.filter((n) => !open.includes(n));
        const shownClosed = p.flags.has('all') ? closed : closed.slice(0, 5);
        const lines = [
          open.length ? 'Open and upcoming:' : 'Nothing open or upcoming.',
          ...open.map((n) => `  ${noticeLine(n, now)}`),
        ];
        if (shownClosed.length) lines.push(p.flags.has('all') ? 'Closed:' : 'Last closed:', ...shownClosed.map((n) => `  ${noticeLine(n, now)}`));
        return { code: 0, text: lines.join('\n') };
      }

      case 'show': {
        const p = parse(rest, []);
        const n = store.get(idOf(p.words[0]));
        if (!n) return { code: 1, text: `there is no notice #${p.words[0]?.replace(/^#/, '')}` };
        return { code: 0, text: noticeText(n, now) };
      }

      case 'delete': {
        if (!o.allowDelete) return { code: 2, text: 'delete is only on the server (status.sh delete <id>); resolve it here, or correct it with update' };
        const p = parse(rest, []);
        const id = idOf(p.words[0]);
        return store.remove(id) ? { code: 0, changed: true, text: `deleted #${id}` } : { code: 1, text: `there is no notice #${id}` };
      }
    }
    return { code: 2, text: COMMAND_HELP };
  } catch (e) {
    if (e instanceof NoticeError) return { code: 2, text: e.message };
    throw e;
  }
}
