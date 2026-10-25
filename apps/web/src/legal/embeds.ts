/**
 * Consent for the Live Feed's third-party players (§ 25(1) TDDDG): a YouTube,
 * Twitch, Kick or Vimeo player is never loaded until the visitor allows it -
 * with "Accept all" in the terms popup (offered next to an equally visible
 * "Only necessary", never pre-selected and never part of accepting the terms:
 * the terms are accepted either way), or for one platform in the widget itself
 * (LiveFeed.tsx). The choice can be withdrawn on the Cookies page (cookies.ts,
 * LegalView.tsx). Kept in this browser only.
 *
 * Before consent the widget shows what loading the player means and nothing of
 * the platform: no iframe, no script, no thumbnail. The server-side stream
 * lookup (/api/vs/live) involves no data of the visitor and needs no consent.
 */
import { useSyncExternalStore } from 'react';

/**
 * `fed`: the Fed live widget (components/fedlive): the Federal Reserve's own
 * broadcast from Brightcove's servers - nothing of it loads before consent. (Its
 * speech model is served by this site, not a third party.)
 */
export type EmbedPlatform = 'youtube' | 'twitch' | 'kick' | 'vimeo' | 'fed';
export const EMBED_PLATFORMS: readonly EmbedPlatform[] = ['youtube', 'twitch', 'kick', 'vimeo', 'fed'];

/** Who runs each player and where its privacy policy is - shown before consent. */
export const EMBED_PROVIDERS: Readonly<Record<EmbedPlatform, { name: string; operator: string; policy: string }>> = {
  youtube: { name: 'YouTube', operator: 'Google Ireland Ltd.', policy: 'https://policies.google.com/privacy' },
  twitch: { name: 'Twitch', operator: 'Twitch Interactive, Inc.', policy: 'https://www.twitch.tv/p/legal/privacy-notice/' },
  kick: { name: 'Kick', operator: 'Kick Streaming Pty Ltd', policy: 'https://kick.com/privacy-policy' },
  vimeo: { name: 'Vimeo', operator: 'Vimeo.com, Inc.', policy: 'https://vimeo.com/privacy' },
  fed: { name: 'Federal Reserve broadcast', operator: 'Brightcove Inc. (the Federal Reserve’s video host)', policy: 'https://www.brightcove.com/en/legal/privacy' },
};

const KEY = 'vd.embeds.v1';

export interface EmbedConsent {
  /** When each platform was allowed (ms); absent: not allowed. */
  allowed: Partial<Record<EmbedPlatform, number>>;
}

const listeners = new Set<() => void>();
let state: EmbedConsent | null = null;

function load(): EmbedConsent {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as EmbedConsent) : null;
    const allowed: EmbedConsent['allowed'] = {};
    for (const p of EMBED_PLATFORMS) {
      const t = v?.allowed?.[p];
      if (typeof t === 'number' && Number.isFinite(t)) allowed[p] = t;
    }
    state = { allowed };
  } catch {
    state = { allowed: {} };
  }
  return state;
}

function save(next: EmbedConsent): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: for this page only */
  }
  for (const l of listeners) l();
}

export const embedConsent = (): EmbedConsent => load();
export const embedAllowed = (p: EmbedPlatform): boolean => load().allowed[p] !== undefined;

export function allowEmbed(p: EmbedPlatform, now = Date.now()): void {
  save({ allowed: { ...load().allowed, [p]: now } });
}

/** "Accept all" in the terms popup: every platform at once (a choice made next to an equal "Only necessary"). */
export function allowAllEmbeds(now = Date.now()): void {
  const allowed = { ...load().allowed };
  for (const p of EMBED_PLATFORMS) allowed[p] ??= now;
  save({ allowed });
}

/** Every platform's player may load: the terms popup does not offer them again. */
export const allEmbedsAllowed = (): boolean => EMBED_PLATFORMS.every((p) => embedAllowed(p));

export function revokeEmbed(p: EmbedPlatform): void {
  const allowed = { ...load().allowed };
  delete allowed[p];
  save({ allowed });
}

export function subscribeEmbeds(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useEmbedConsent(): EmbedConsent {
  return useSyncExternalStore(subscribeEmbeds, embedConsent, embedConsent);
}

/** For tests. */
export function _resetEmbedsForTests(): void {
  state = null;
}
