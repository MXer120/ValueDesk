/**
 * A YouTube channel's live stream right now, for the Live Feed widget - asked of
 * the YouTube Data API v3 with this server's key (YOUTUBE_API_KEY), never read off
 * youtube.com's pages: YouTube's terms forbid automated access to the site and the
 * Developer Policies forbid scraping (docs/legal/TECH-AUDIT.md section 2).
 *
 * YouTube's `embed/live_stream?channel=` stopped resolving, so the video is found
 * here, as cheaply as the API allows (10,000 units a day by default):
 *   1. the video the channel was last seen live with: videos.list - still live?  1 unit
 *   2. its newest uploads (a stream that started lately is one of them):
 *      playlistItems.list on the uploads playlist, then videos.list on those     2 units
 *   3. a long-running stream older than its uploads: search.list eventType=live,
 *      at most once an hour per channel                                       100 units
 * One answer per channel per five minutes (cached, one flight at a time). Only the
 * Live Feed's own channels can be asked (LIVE_CHANNELS; the web's model.ts CHANNELS
 * - a web test checks they agree). Without a key there is no lookup: the route
 * answers not_available and the widget says the channel cannot be found.
 */
const CACHE_MS = 5 * 60_000;
const SEARCH_EVERY_MS = 60 * 60_000;
const TIMEOUT_MS = 8_000;
const API = 'https://www.googleapis.com/youtube/v3';
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** The Live Feed's channels (apps/web/src/components/livefeed/model.ts CHANNELS). */
export const LIVE_CHANNELS: ReadonlySet<string> = new Set([
  'UCIALMKvObZNtJ6AmdCLP7Lg', // Bloomberg TV
  'UCrp_UI8XtuYfpiqluWLD7Lw', // CNBC Television
  'UC8p1vwvWtl6T73JiExfWs1g', // CBS News
  'UCEAZeUIeJs0IjQiqTCdVSIg', // Yahoo Finance
  'UCYxRlFDqcWM4y7FfpiAN3KQ', // The White House
  'UCvJJ_dzjViJCoLf5uKUTwoA', // CNBC
  'UChqUTb7kYRX8-EiaN3XFrSQ', // Reuters
  'UCoMdktPbSTixAyNGwb-UYkQ', // Sky News
  'UCBi2mrWuNuyYy4gbM6fU18Q', // ABC News
  'UCJg9wBPyKMNA5sRDnvzmkdg', // LiveNOW from FOX
  'UCNye-wNBqNL5ZzHSJj3l8Bg', // Al Jazeera English
  'UCknLrEdhRCp1aegoMqRaCZg', // DW News
]);

/** The key, or '' (no lookup). Read per call, so setting it needs no code change. */
export const youtubeKey = (): string => process.env.YOUTUBE_API_KEY?.trim() ?? '';

interface Seen {
  at: number;
  video: string | null;
  /** The last video seen live, checked first next time. */
  last: string | null;
  searchedAt: number;
}
const seen = new Map<string, Seen>();
const inflight = new Map<string, Promise<string | null>>();

/** Tests only. */
export function resetLiveCache(): void {
  seen.clear();
  inflight.clear();
}

async function api<T>(path: string, params: Record<string, string>, key: string, fetchImpl: typeof fetch): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${API}/${path}?${new URLSearchParams({ ...params, key })}`, { signal: ctrl.signal });
    // Never the URL in an error: it carries the key.
    if (!res.ok) throw new Error(`YouTube Data API ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    throw e instanceof Error && e.name === 'AbortError' ? new Error('YouTube timed out') : e;
  } finally {
    clearTimeout(timer);
  }
}

interface VideoList { items?: Array<{ id?: string; snippet?: { liveBroadcastContent?: string } }> }
interface PlaylistItems { items?: Array<{ contentDetails?: { videoId?: string } }> }
interface SearchList { items?: Array<{ id?: { videoId?: string } }> }

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The first of these videos that is live now, or null. One unit. */
async function liveAmong(ids: string[], key: string, fetchImpl: typeof fetch): Promise<string | null> {
  const ok = ids.filter((id) => VIDEO_ID.test(id)).slice(0, 50);
  if (!ok.length) return null;
  const r = await api<VideoList>('videos', { part: 'snippet', id: ok.join(','), maxResults: '50' }, key, fetchImpl);
  return r.items?.find((v) => v.snippet?.liveBroadcastContent === 'live' && VIDEO_ID.test(v.id ?? ''))?.id ?? null;
}

async function lookUp(channel: string, prev: Seen | undefined, key: string, fetchImpl: typeof fetch): Promise<Seen> {
  const now = Date.now();
  const base = { at: now, last: prev?.last ?? null, searchedAt: prev?.searchedAt ?? 0 };
  // 1. Still on air with the video it had?
  if (prev?.last && (await liveAmong([prev.last], key, fetchImpl))) return { ...base, video: prev.last };
  // 2. A stream among its newest uploads (UC... -> UU..., the channel's uploads playlist).
  const uploads = await api<PlaylistItems>('playlistItems', { part: 'contentDetails', playlistId: `UU${channel.slice(2)}`, maxResults: '10' }, key, fetchImpl);
  const fresh = await liveAmong((uploads.items ?? []).map((i) => i.contentDetails?.videoId ?? ''), key, fetchImpl);
  if (fresh) return { ...base, video: fresh, last: fresh };
  // 3. A stream that has run longer than its uploads reach back: the costly search, rarely.
  if (now - base.searchedAt < SEARCH_EVERY_MS) return { ...base, video: null };
  const found = await api<SearchList>('search', { part: 'id', channelId: channel, eventType: 'live', type: 'video', maxResults: '1' }, key, fetchImpl);
  const video = found.items?.map((i) => i.id?.videoId ?? '').find((id) => VIDEO_ID.test(id)) ?? null;
  return { ...base, video, last: video ?? base.last, searchedAt: now };
}

/** The live video id of one of the Live Feed's channels, or null when nothing is on air. */
export async function liveVideo(channel: string, key: string = youtubeKey(), fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!CHANNEL_ID.test(channel) || !LIVE_CHANNELS.has(channel)) throw new Error('Not one of the Live Feed\'s channels');
  if (!key) throw new Error('The live lookup is not configured (YOUTUBE_API_KEY)');
  const hit = seen.get(channel);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.video;
  let flight = inflight.get(channel);
  if (!flight) {
    flight = (async () => {
      try {
        const next = await lookUp(channel, hit, key, fetchImpl);
        seen.set(channel, next);
        return next.video;
      } catch (e) {
        if (hit) return hit.video;
        throw e;
      }
    })().finally(() => inflight.delete(channel));
    inflight.set(channel, flight);
  }
  return flight;
}
