/**
 * Talking to a YouTube embed without loading YouTube's iframe_api script. The
 * player answers postMessage once it is told someone listens (`listening`):
 * it then reports what it does (`infoDelivery` {playerState, muted},
 * `onStateChange`) and takes commands (`command` {func, args}). The Live Feed
 * (LiveFeed.tsx) reads it so its play and mute buttons show what the player
 * really does, not what the last click asked for.
 */
export const YT_ORIGIN = 'https://www.youtube.com';

/** YouTube's player states. */
export const YT = { unstarted: -1, ended: 0, playing: 1, paused: 2, buffering: 3, cued: 5 } as const;

/** What one message from the player says; absent fields say nothing. */
export interface YtReport {
  ready?: boolean;
  state?: number;
  muted?: boolean;
}

export function readYtMessage(data: unknown): YtReport | null {
  let m: unknown = data;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== 'object') return null;
  const { event, info } = m as { event?: unknown; info?: unknown };
  if (event === 'onReady') return { ready: true };
  if (event === 'onStateChange') return typeof info === 'number' ? { state: info } : null;
  if (event !== 'infoDelivery' && event !== 'initialDelivery') return null;
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  const out: YtReport = event === 'initialDelivery' ? { ready: true } : {};
  if (typeof i.playerState === 'number') out.state = i.playerState;
  if (typeof i.muted === 'boolean') out.muted = i.muted;
  return Object.keys(out).length ? out : null;
}

export const ytListening = () => JSON.stringify({ event: 'listening', id: 1, channel: 'widget' });
export const ytCommand = (func: string, args: unknown[] = []) =>
  JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' });

/** Where a 16:9 picture sits in a w × h box: as large as fits, centred. */
export function fitVideo(w: number, h: number): { x: number; y: number; w: number; h: number } {
  if (w <= 0 || h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const vw = Math.min(w, (h * 16) / 9);
  const vh = (vw * 9) / 16;
  return { x: Math.round((w - vw) / 2), y: Math.round((h - vh) / 2), w: Math.round(vw), h: Math.round(vh) };
}

/**
 * How far the player reaches past the picture above and below it. The player is
 * made taller than its 16:9 picture, YouTube letterboxes it, and its title bar,
 * logo, captions and "More videos" sit on those bars - which the widget clips.
 */
export function playerBand(videoH: number): number {
  return Math.max(64, Math.round(videoH * 0.2));
}
