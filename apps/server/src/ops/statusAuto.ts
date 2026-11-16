/**
 * Incidents from the probes' own record (owner, 2026-10-28: "there was downtime but none
 * there"): until now the page had an incident only when the owner posted one, so a real
 * outage showed as red bars and nothing else - no entry under Past incidents, nothing in
 * the feed, no banner in the app.
 *
 * Fed each round's samples (ops/status.ts startStatusProber), per service:
 *   down AUTO.downMin minutes in a row, or degraded (or worse) AUTO.degradedMin minutes in
 *   a row, opens an incident (major when down, minor when degraded) dated from the first
 *   bad minute; going from degraded to down makes it major. Up AUTO.clearMin minutes in a
 *   row resolves it, with how long it lasted.
 *   No sample at all for AUTO.gapMin minutes or more: the prober runs inside the Data API,
 *   so the API was not running (a restart that took long, the server down) - a resolved
 *   incident for that stretch, written when the probes come back.
 * Nothing is opened over the owner's own word: an incident or maintenance of theirs that
 * covers the service at that time stands instead. When the owner resolves or removes one of
 * these by hand while the probes still see the fault, it stays closed until the service has
 * been up AUTO.clearMin minutes again.
 *
 * An indexer incident says what is behind (a sample's `why`, ops/indexerJudge.ts whyText) in plain
 * words; something new behind while it is open is one update to it ("Now also: ..."). A sample that
 * says the service is stopping on purpose counts as maintenance: nothing is opened from it.
 *
 * The incidents are ordinary notices (ops/statusNotices.ts): the page, the feed, the app's
 * banner and the backup carry them as they carry the owner's, and the owner can change
 * them with the same tools. Which ones are automatic, and each service's run, are kept in
 * status_meta - a restart neither repeats one nor misses a close.
 *
 * Once, at the first start with this code, the record already there (every sample since
 * the prober began, at most 7 days back - how far an incident may be dated) is played
 * through the same rules, so the past outages get their entries too.
 */
import type { NoticeStore } from './statusNotices.js';
import { DAY_MIN, STATUS_SERVICES, fmtUtc, noticeSpan, type ServiceId, type ServiceState } from './statusModel.js';
import { whyText } from './indexerJudge.js';

export const AUTO = { downMin: DAY_MIN.down, degradedMin: DAY_MIN.degraded, clearMin: 5, gapMin: 5 } as const;

/** How far back an incident may start (statusNotices.ts MAX_BACK_MS), less a minute's margin. */
const BACK_MS = 7 * 86_400_000 - 60_000;
const STATE_KEY = 'auto_incidents';
export const REPLAYED_KEY = 'auto_incidents_replayed';

type Bad = 'degraded' | 'down';
type Seen = Exclude<ServiceState, 'unknown'>;

interface Track {
  /** Our open incident on this service, or null. */
  id: number | null;
  worst: Bad | null;
  badFrom: number | null;
  downFrom: number | null;
  upFrom: number | null;
  /** The owner closed ours while the fault was still seen: nothing new until it has been up a while. */
  quiet: boolean;
  /** What the probes said is behind during this bad run (Sample.why codes), and what our incident has said. */
  seen?: string[];
  told?: string[];
}

interface AutoState {
  v: 1;
  /** The last minute played. */
  last: number | null;
  /** The notices this wrote (the owner's are every other). */
  ids: number[];
  tracks: Partial<Record<ServiceId, Track>>;
}

const NAME = new Map<string, string>(STATUS_SERVICES.map((s) => [s.id, s.name]));

const TITLE: Record<ServiceId, Record<Bad, string>> = {
  website: { down: 'Website not loading', degraded: 'Website partly failing' },
  api: { down: 'Data API not answering', degraded: 'Data API degraded' },
  executor: { down: 'Copy & algo executor not answering', degraded: 'Copy & algo executor degraded' },
  indexer: { down: 'Indexer not publishing - data is not current', degraded: 'Indexer degraded - figures may be behind' },
};

/** The codes' plain words, known ones only, joined; '' for none. */
function whyWords(why: readonly string[]): string {
  return why.map(whyText).filter((x): x is string => x !== null).join('; ');
}

const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function openText(svc: ServiceId, bad: Bad, from: number, why: readonly string[] = []): string {
  const since = fmtUtc(from);
  if (svc === 'indexer') {
    if (bad === 'down') {
      return `The indexer has not published fresh data since ${since}: cohorts, the liquidation heatmap, leaderboards and wallet pages may be out of date. Detected by our automatic checks; we are looking into it.`;
    }
    // What the probes saw behind (ops/indexerJudge.ts); a replayed record has only the states.
    const words = whyWords(why);
    return words
      ? `Since ${since}: ${sentence(words)}. Detected by our automatic checks; we are looking into it.`
      : `Since ${since} one of the indexer's data streams has been down, its leaderboards have not been rebuilt for over an hour, or its reads have stopped making progress: some figures may be behind. Detected by our automatic checks; we are looking into it.`;
  }
  if (svc === 'executor' && bad === 'degraded') {
    return `Since ${since} the copy & algo executor has either answered that its database or its SoDEX feed is not right, or has been hard to reach from the site: copies and algo orders may be late, and the app may wait for its answers. Detected by our automatic checks; we are looking into it.`;
  }
  return `Our automatic checks have found the ${NAME.get(svc)} ${bad === 'down' ? 'not answering' : 'degraded'} since ${since}. We are looking into it.`;
}

const minutes = (a: number, b: number): string => {
  const m = Math.max(1, Math.round((b - a) / 60_000));
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

const blankTrack = (): Track => ({ id: null, worst: null, badFrom: null, downFrom: null, upFrom: null, quiet: false });

/**
 * How bad an automatic incident is. The indexer down is never "major" (owner 2026-11-09: "errors are still named super
 * drastically 'Major incident' when it's really just the indexer being down"): the site, trading and copies go on; only
 * figures fall behind. The Data API, the website or the executor down is major.
 */
export const impactOf = (svc: ServiceId, bad: Bad): 'major' | 'minor' => (bad === 'down' && svc !== 'indexer' ? 'major' : 'minor');

export class AutoIncidents {
  private s: AutoState;

  constructor(private readonly notices: NoticeStore) {
    this.s = this.load();
  }

  private load(): AutoState {
    try {
      const v = JSON.parse(this.notices.getMeta(STATE_KEY) ?? '') as Partial<AutoState>;
      if (v?.v === 1) {
        return {
          v: 1,
          last: typeof v.last === 'number' ? v.last : null,
          ids: Array.isArray(v.ids) ? v.ids.filter((x) => Number.isSafeInteger(x)) : [],
          tracks: v.tracks && typeof v.tracks === 'object' ? v.tracks : {},
        };
      }
    } catch {
      /* none yet */
    }
    return { v: 1, last: null, ids: [], tracks: {} };
  }

  private save(): void {
    this.notices.setMeta(STATE_KEY, JSON.stringify(this.s));
  }

  /** Whether notice `id` was written by these checks. */
  isAuto(id: number): boolean {
    return this.s.ids.includes(id);
  }

  /** The minute last played (tests, the replay). */
  get lastMinute(): number | null {
    return this.s.last;
  }

  /** An incident or maintenance of the owner's that covers `svc` somewhere in [from, to]. */
  private covered(svc: ServiceId, from: number, to: number): boolean {
    return this.notices.all().some((n) => {
      if (this.s.ids.includes(n.id) || !n.components.includes(svc)) return false;
      const [a, b] = noticeSpan(n, to);
      return a <= to && b >= from;
    });
  }

  private open(svc: ServiceId, bad: Bad, fromMs: number, at: number, why: readonly string[] = []): number | null {
    const from = Math.max(fromMs, at - BACK_MS);
    if (this.covered(svc, from, at)) return null;
    const n = this.notices.create({
      kind: 'incident', title: TITLE[svc][bad], components: [svc], impact: impactOf(svc, bad),
      startsAt: from, text: openText(svc, bad, from, why), stage: 'investigating',
    }, at);
    this.s.ids.push(n.id);
    return n.id;
  }

  /** A stretch with no sample: the Data API (where the prober runs) was not running. */
  private gap(fromMin: number, toMin: number, at: number): void {
    const from = Math.max(fromMin * 60_000, at - BACK_MS);
    const to = toMin * 60_000;
    if (to <= from || this.covered('api', from, to)) return;
    const n = this.notices.create({
      kind: 'incident', title: 'Data API was not running', components: ['api'], impact: to - from >= 30 * 60_000 ? 'major' : 'minor',
      startsAt: from, stage: 'resolved',
      text: `Our checks run inside the Data API, and none ran from ${fmtUtc(from)} to ${fmtUtc(to)} (${minutes(from, to)}): the API was restarting or stopped, and the app's data could not load. Recorded automatically when the checks came back.`,
    }, Math.max(at, to));
    this.s.ids.push(n.id);
  }

  /**
   * One round's samples for `minute`, observed at `at`. Never throws: a notice that cannot
   * be written is skipped, and the next round tries again.
   */
  observe(minute: number, samples: ReadonlyArray<{ service: ServiceId; state: Seen; why?: readonly string[] }>, at = minute * 60_000): void {
    if (this.s.last !== null && minute <= this.s.last) return;
    try {
      if (this.s.last !== null && minute - this.s.last - 1 >= AUTO.gapMin) this.gap(this.s.last + 1, minute, at);
    } catch {
      /* skipped */
    }
    this.s.last = minute;
    for (const smp of samples) {
      try {
        this.step(smp.service, smp.state, minute, at, smp.why ?? []);
      } catch {
        /* skipped: the next minute decides again */
      }
    }
    this.save();
  }

  private step(svc: ServiceId, state: Seen, minute: number, at: number, why: readonly string[]): void {
    const t = (this.s.tracks[svc] ??= blankTrack());
    // The service says it is stopping on purpose (the indexer's `stopping`, ops/status.ts): maintenance.
    // Nothing is opened from it and a bad run does not carry across it; an incident already open stays.
    if (why.includes('stopping')) {
      t.badFrom = null;
      t.downFrom = null;
      t.upFrom = null;
      t.seen = [];
      return;
    }
    if (state === 'up') {
      t.badFrom = null;
      t.downFrom = null;
      t.seen = [];
      t.upFrom ??= minute;
      if (minute - t.upFrom + 1 < AUTO.clearMin) return;
      t.quiet = false;
      if (t.id !== null) {
        const n = this.notices.get(t.id);
        if (n && n.closedAt === null) {
          const back = t.upFrom * 60_000;
          this.notices.resolve(t.id, `Working normally again since ${fmtUtc(back)} (automatic check). ${t.worst === 'down' ? 'Not answering' : 'Degraded'} for about ${minutes(n.startsAt, back)}.`, at);
        }
        t.id = null;
        t.worst = null;
      }
      return;
    }
    t.upFrom = null;
    t.badFrom ??= minute;
    const seen = (t.seen ??= []);
    for (const w of why) if (!seen.includes(w)) seen.push(w);
    if (state === 'down') t.downFrom ??= minute;
    else t.downFrom = null;
    const downLong = t.downFrom !== null && minute - t.downFrom + 1 >= AUTO.downMin;
    const badLong = minute - t.badFrom + 1 >= AUTO.degradedMin;
    if (t.id !== null) {
      const n = this.notices.get(t.id);
      if (!n || n.closedAt !== null) {
        // The owner resolved or removed it by hand: their word stands until the service is back.
        t.id = null;
        t.worst = null;
        t.quiet = true;
        return;
      }
      if (downLong && t.worst !== 'down') {
        this.notices.update(t.id, { impact: impactOf(svc, 'down'), title: TITLE[svc].down, text: `Not answering at all since ${fmtUtc(t.downFrom! * 60_000)}.` }, at);
        t.worst = 'down';
      }
      // Something else is behind as well: said once, as an update to the same incident.
      const fresh = seen.filter((w) => !(t.told ?? []).includes(w));
      const words = whyWords(fresh);
      if (words && t.worst !== 'down') this.notices.update(t.id, { text: `Now also: ${words}.` }, at);
      if (fresh.length) t.told = [...seen];
      return;
    }
    if (t.quiet || (!downLong && !badLong)) return;
    const bad: Bad = downLong ? 'down' : 'degraded';
    const id = this.open(svc, bad, t.badFrom * 60_000, at, seen);
    if (id !== null) {
      t.id = id;
      t.worst = bad;
      t.told = [...seen];
    }
  }
}
