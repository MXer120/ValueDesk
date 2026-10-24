/**
 * The Live Feed's sources and embeds, without React: the news channels it
 * offers (each a YouTube channel, played as that channel's current live
 * stream), a pasted link read as YouTube, Twitch, Kick or Vimeo, and the
 * player URL for each - muted at first, since a browser only autoplays a
 * muted video.
 */
import type { EmbedPlatform } from '../../legal/embeds';

export interface Channel {
  id: string;
  name: string;
  /** The YouTube channel whose live stream plays. */
  youtube: string;
}

/** The dropdown's channels, in order: the five the owner asked for first, then more news. */
export const CHANNELS: readonly Channel[] = [
  { id: 'bloomberg', name: 'Bloomberg TV', youtube: 'UCIALMKvObZNtJ6AmdCLP7Lg' },
  { id: 'cnbc', name: 'CNBC Television', youtube: 'UCrp_UI8XtuYfpiqluWLD7Lw' },
  { id: 'cbs', name: 'CBS News', youtube: 'UC8p1vwvWtl6T73JiExfWs1g' },
  { id: 'yahoo', name: 'Yahoo Finance', youtube: 'UCEAZeUIeJs0IjQiqTCdVSIg' },
  { id: 'whitehouse', name: 'The White House', youtube: 'UCYxRlFDqcWM4y7FfpiAN3KQ' },
  // The Fed's own channel: the FOMC's press conferences live (@federalreserve).
  { id: 'fed', name: 'Federal Reserve (FOMC)', youtube: 'UCAzhpt9DmG6PnHXjmJTvRGQ' },
  { id: 'cnbcintl', name: 'CNBC', youtube: 'UCvJJ_dzjViJCoLf5uKUTwoA' },
  { id: 'reuters', name: 'Reuters', youtube: 'UChqUTb7kYRX8-EiaN3XFrSQ' },
  { id: 'sky', name: 'Sky News', youtube: 'UCoMdktPbSTixAyNGwb-UYkQ' },
  { id: 'abc', name: 'ABC News', youtube: 'UCBi2mrWuNuyYy4gbM6fU18Q' },
  { id: 'livenow', name: 'LiveNOW from FOX', youtube: 'UCJg9wBPyKMNA5sRDnvzmkdg' },
  { id: 'aljazeera', name: 'Al Jazeera English', youtube: 'UCNye-wNBqNL5ZzHSJj3l8Bg' },
  { id: 'dw', name: 'DW News', youtube: 'UCknLrEdhRCp1aegoMqRaCZg' },
];

export type Stream =
  | { kind: 'youtube-live'; channel: string }
  | { kind: 'youtube'; video: string }
  | { kind: 'twitch'; channel: string }
  | { kind: 'twitch-video'; video: string }
  | { kind: 'kick'; channel: string }
  | { kind: 'vimeo'; video: string };

/** Whose player a stream plays in: the platform the visitor must allow first (legal/embeds.ts). */
export const PLATFORM_OF: Record<Stream['kind'], EmbedPlatform> = {
  'youtube-live': 'youtube',
  youtube: 'youtube',
  twitch: 'twitch',
  'twitch-video': 'twitch',
  kick: 'kick',
  vimeo: 'vimeo',
};

export const PLATFORM_NAME: Record<Stream['kind'], string> = {
  'youtube-live': 'YouTube',
  youtube: 'YouTube',
  twitch: 'Twitch',
  'twitch-video': 'Twitch',
  kick: 'Kick',
  vimeo: 'Vimeo',
};

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const NAME = /^[A-Za-z0-9_]{2,40}$/;

/**
 * A pasted link as a stream, or a sentence saying why not. A YouTube @handle
 * cannot be resolved in the browser; its /channel/UC... link or a video link can.
 */
export function parseStream(input: string): Stream | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Paste a YouTube, Twitch, Kick or Vimeo link.' };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: 'That is not a link.' };
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '').toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' && parts[0] && YT_ID.test(parts[0])) return { kind: 'youtube', video: parts[0] };
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && YT_ID.test(v)) return { kind: 'youtube', video: v };
    if ((parts[0] === 'live' || parts[0] === 'embed' || parts[0] === 'shorts') && parts[1] && YT_ID.test(parts[1])) {
      return { kind: 'youtube', video: parts[1] };
    }
    if (parts[0] === 'embed' && parts[1] === 'live_stream') {
      const ch = u.searchParams.get('channel');
      if (ch && /^UC[A-Za-z0-9_-]{22}$/.test(ch)) return { kind: 'youtube-live', channel: ch };
    }
    if (parts[0] === 'channel' && parts[1] && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1])) return { kind: 'youtube-live', channel: parts[1] };
    if (parts[0]?.startsWith('@')) return { error: 'Use the channel’s /channel/UC… link (Share → Copy channel ID) or a link to the live video.' };
    return { error: 'That YouTube link is not a video or a channel.' };
  }
  if (host === 'twitch.tv' || host === 'player.twitch.tv') {
    if (parts[0] === 'videos' && parts[1] && /^\d+$/.test(parts[1])) return { kind: 'twitch-video', video: parts[1] };
    const ch = host === 'player.twitch.tv' ? u.searchParams.get('channel') : parts[0];
    if (ch && NAME.test(ch)) return { kind: 'twitch', channel: ch.toLowerCase() };
    return { error: 'That Twitch link is not a channel or a video.' };
  }
  if (host === 'kick.com' || host === 'player.kick.com') {
    if (parts[0] && /^[A-Za-z0-9_-]{2,40}$/.test(parts[0])) return { kind: 'kick', channel: parts[0].toLowerCase() };
    return { error: 'That Kick link is not a channel.' };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = parts.find((p) => /^\d+$/.test(p));
    if (id) return { kind: 'vimeo', video: id };
    return { error: 'That Vimeo link is not a video.' };
  }
  return { error: 'Only YouTube, Twitch, Kick and Vimeo links play here.' };
}

/**
 * The player URL: each platform's documented options only, its own controls on
 * (LiveFeed.tsx: nothing covers or drives a player). \`host\` is this page's
 * hostname (Twitch refuses an embed whose \`parent\` is not it).
 */
export function embedUrl(s: Stream, o: { muted: boolean; host: string }): string {
  const mute = o.muted ? '1' : '0';
  switch (s.kind) {
    case 'youtube-live':
    case 'youtube': {
      const path = s.kind === 'youtube' ? `embed/${s.video}` : 'embed/live_stream';
      const q = new URLSearchParams({
        ...(s.kind === 'youtube-live' ? { channel: s.channel } : {}),
        autoplay: '1',
        mute,
        playsinline: '1',
        rel: '0',
      });
      return `https://www.youtube.com/${path}?${q}`;
    }
    case 'twitch':
    case 'twitch-video': {
      const q = new URLSearchParams({
        ...(s.kind === 'twitch' ? { channel: s.channel } : { video: `v${s.video}` }),
        parent: o.host,
        autoplay: 'true',
        muted: o.muted ? 'true' : 'false',
      });
      return `https://player.twitch.tv/?${q}`;
    }
    case 'kick':
      return `https://player.kick.com/${encodeURIComponent(s.channel)}?autoplay=true&muted=${o.muted ? 'true' : 'false'}`;
    case 'vimeo':
      return `https://player.vimeo.com/video/${s.video}?autoplay=1&muted=${mute}`;
  }
}

/** What the Live Feed remembers: a channel, a pasted stream, or nothing (cleared). */
export type FeedChoice = { channel: string } | { custom: string } | null;

export function readChoice(raw: unknown): FeedChoice {
  if (raw === null) return null;
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.channel === 'string' && CHANNELS.some((c) => c.id === o.channel)) return { channel: o.channel };
    if (typeof o.custom === 'string' && o.custom.trim()) return { custom: o.custom.trim().slice(0, 500) };
  }
  return { channel: CHANNELS[0]!.id };
}

/** The stream a choice plays, or null. */
export function streamOf(choice: FeedChoice): Stream | null {
  if (!choice) return null;
  if ('channel' in choice) {
    const c = CHANNELS.find((x) => x.id === choice.channel);
    return c ? { kind: 'youtube-live', channel: c.youtube } : null;
  }
  const s = parseStream(choice.custom);
  return 'error' in s ? null : s;
}
