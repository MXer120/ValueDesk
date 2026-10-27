/**
 * GET /api/vs/status - the public status page's data (ops/status.ts): each
 * service's last probe and its 90 days of uptime, and the owner's incidents and
 * maintenance (ops/statusNotices.ts), as ops/statusModel.ts types them.
 * GET /api/vs/status/feed - the same incidents and maintenance as an Atom feed,
 * for a feed reader (or a chat's RSS bot): one entry per notice, updated with it.
 *
 * Public and the same for everyone: no input, nothing about a visitor. Built at
 * most every CACHE_MS from status.db and kept in memory between, and the edge may
 * share an answer as long (perf.ts CACHE_POLICIES) - so a crowd watching the page
 * during an outage costs this server one small read every 30 seconds.
 *
 * A server that does not probe (local dev without VALUESCAN_STATUS_PROBE=1)
 * answers from whatever status.db holds - usually nothing: every day no data.
 */
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SITE, StatusStore } from '../ops/status.js';
import { IMPACT_TEXT, STAGE_TEXT, STATUS_SERVICES, type Notice, type StatusReport } from '../ops/statusModel.js';

export const STATUS_CACHE_MS = 30_000;
export const FEED_PATH = '/api/vs/status/feed';
/** The feed's own (perf.ts caches JSON only): feed readers poll; five minutes is soon enough. */
export const FEED_CACHE = 'public, max-age=300, stale-while-revalidate=300';
const FEED_ENTRIES = 50;

export interface StatusRouteOptions {
  /** The record to answer from (tests, or the running prober's); default one opened on first use. */
  store?: StatusStore;
  now?: () => number;
  /** The public site the feed links to (VALUESCAN_STATUS_SITE_URL, else www.valuedesk.so). */
  site?: string;
}

/** Text for XML: the five special characters escaped, and the characters XML 1.0 forbids dropped. */
export const xml = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[&<>"']/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' } as Record<string, string>)[c]};`);

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const NAMES = new Map<string, string>(STATUS_SERVICES.map((s) => [s.id, s.name]));

/** The Atom feed of the notices (newest change first). Plain text everywhere: type="text". */
export function atomFeed(notices: readonly Notice[], site: string, now: number): string {
  const base = site.replace(/\/+$/, '');
  const changed = (n: Notice): number => Math.max(n.updates.at(-1)?.at ?? n.startsAt, n.closedAt ?? 0);
  const list = [...notices].sort((a, b) => changed(b) - changed(a)).slice(0, FEED_ENTRIES);
  const updated = list.length ? changed(list[0]!) : now;
  const entries = list.map((n) => {
    const kind = n.kind === 'incident' ? `${IMPACT_TEXT[n.impact ?? 'minor']} incident` : 'Maintenance';
    const when = n.kind === 'maintenance' ? `Planned ${iso(n.startsAt)} to ${iso(n.endsAt!)}. ` : '';
    const body = [
      `${kind}. Affects: ${n.components.map((c) => NAMES.get(c) ?? c).join(', ')}. ${when}`.trim(),
      ...[...n.updates].reverse().map((u) => `${iso(u.at)} ${STAGE_TEXT[u.stage]}${u.text ? `: ${u.text}` : ''}`),
    ].join('\n');
    return [
      '  <entry>',
      `    <id>${xml(`${base}/status#notice-${n.id}`)}</id>`,
      `    <title type="text">${xml(`${n.kind === 'maintenance' ? 'Maintenance: ' : ''}${n.title} (${STAGE_TEXT[n.updates.at(-1)!.stage]})`)}</title>`,
      `    <link rel="alternate" type="text/html" href="${xml(`${base}/status#notice-${n.id}`)}"/>`,
      `    <published>${iso(n.updates[0]!.at)}</published>`,
      `    <updated>${iso(changed(n))}</updated>`,
      `    <content type="text">${xml(body)}</content>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${xml(`${base}/status`)}</id>`,
    '  <title type="text">ValueDesk status</title>',
    `  <link rel="alternate" type="text/html" href="${xml(`${base}/status`)}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${xml(`${base}${FEED_PATH}`)}"/>`,
    `  <updated>${iso(updated)}</updated>`,
    '  <author><name>ValueDesk</name></author>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}

export async function statusRoutes(app: FastifyInstance, opts: StatusRouteOptions = {}) {
  const now = opts.now ?? Date.now;
  const site = (opts.site ?? (process.env.VALUESCAN_STATUS_SITE_URL?.trim() || DEFAULT_SITE)).replace(/\/+$/, '');
  let store = opts.store ?? null;
  let cached: { at: number; body: StatusReport; feed: string | null } | null = null;

  const current = (t: number): NonNullable<typeof cached> => {
    if (!cached || t - cached.at >= STATUS_CACHE_MS) {
      store ??= new StatusStore();
      cached = { at: t, body: store.report(t), feed: null };
    }
    return cached;
  };

  app.get('/api/vs/status', async (req, reply) => {
    try {
      return current(now()).body;
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'status: the record could not be read');
      return reply.code(503).send({ ok: false, error: 'status is not available right now' });
    }
  });

  app.get('/api/vs/status/feed', async (req, reply) => {
    try {
      const c = current(now());
      c.feed ??= atomFeed(c.body.notices ?? [], site, c.at);
      return reply.type('application/atom+xml; charset=utf-8').header('Cache-Control', FEED_CACHE).send(c.feed);
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'status: the feed could not be built');
      return reply.code(503).send({ ok: false, error: 'status is not available right now' });
    }
  });
}
