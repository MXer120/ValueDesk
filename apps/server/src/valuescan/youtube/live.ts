/**
 * A YouTube channel's live stream right now, for the Live Feed widget.
 *
 * YouTube's `embed/live_stream?channel=` stopped resolving, so the stream is
 * found the way a browser finds it: the channel's /live page names it as its
 * canonical watch URL, and says "isLive" while it is on air. One fetch per
 * channel per three minutes (cached, one flight at a time); the host is fixed
 * and the channel id is checked, so nothing else can be asked for.
 */
const CACHE_MS = 3 * 60_000;
const TIMEOUT_MS = 8_000;
const MAX_CACHED = 200;
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

const cache = new Map<string, { at: number; video: string | null }>();
const inflight = new Map<string, Promise<string | null>>();

/** Tests only. */
export function resetLiveCache(): void {
  cache.clear();
  inflight.clear();
}

/** The live video id in a channel's /live page, or null when nothing is on air. */
export function liveVideoIn(html: string): string | null {
  const m = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/.exec(html);
  if (!m) return null;
  return /"isLive":true/.test(html) ? m[1]! : null;
}

export async function liveVideo(channel: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!CHANNEL_ID.test(channel)) throw new Error('Not a YouTube channel id');
  const hit = cache.get(channel);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.video;
  let flight = inflight.get(channel);
  if (!flight) {
    flight = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(`https://www.youtube.com/channel/${channel}/live`, {
          headers: { 'user-agent': 'Mozilla/5.0 (ValueDesk live feed)', 'accept-language': 'en' },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
        const video = liveVideoIn(await res.text());
        cache.set(channel, { at: Date.now(), video });
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
        return video;
      } catch (e) {
        if (hit) return hit.video;
        throw e instanceof Error && e.name === 'AbortError' ? new Error('YouTube timed out') : e;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => inflight.delete(channel));
    inflight.set(channel, flight);
  }
  return flight;
}
