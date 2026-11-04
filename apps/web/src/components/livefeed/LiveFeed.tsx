/**
 * The Live Feed widget: a news channel's live stream (Bloomberg TV, CNBC, CBS
 * News, Yahoo Finance, the White House and more - model.ts CHANNELS), or a
 * pasted YouTube, Twitch, Kick or Vimeo link.
 *
 * THE PLATFORM'S PLAYER, AS IT COMES. The widget never covers, crops or drives a
 * player: YouTube's and Twitch's terms forbid overlays, frames or anything else in
 * front of any part of their players, hiding their logo, title or links, and
 * changing a player beyond its documented options (YouTube API Services Required
 * Minimum Functionality; Twitch Developer Services Agreement). So the widget's controls - LIVE with a slow red dot, the source,
 * mute, fullscreen, clear - sit in a header ABOVE the player, the player shows its
 * own controls, and it is never shown smaller than its platform allows
 * (MIN_PLAYER): a panel too small says so instead. The picture is 16:9 where the
 * panel allows, otherwise the platform letterboxes it. Mute reloads the player
 * with the setting (a stream starts muted: a browser only autoplays a muted
 * video). With nothing to play, the same controls float at the panel's top.
 *
 * CONSENT FIRST. No platform's player - no frame, no script - loads before the
 * viewer allows that platform (legal/embeds.ts; § 25 TDDDG, the two-click
 * solution). The consent is remembered on this browser and withdrawn on the
 * Cookies page.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAsync, useStored } from '../../hooks';
import { vsApi } from '../../vsApi';
import { FxSelect } from '../funds/ui';
import { EmptyState } from '../EmptyState';
import { CHANNELS, PLATFORM_NAME, PLATFORM_OF, embedUrl, parseStream, readChoice, streamOf, type FeedChoice, type Stream } from './model';
import { EMBED_PROVIDERS, allowEmbed, useEmbedConsent } from '../../legal/embeds';
import { LegalLink } from '../../legal/LegalGate';
import { EMBED_NOTICE } from '../../legal/notices';
import { fitVideo } from './ytPlayer';
import './LiveFeed.css';

const CUSTOM = 'custom';
/** The header's height when it stays above the picture. */
const HEAD = 46;
/** The floating controls hide this long after the pointer stops. */
const IDLE_MS = 2200;
/**
 * The smallest player each platform allows: YouTube 200 x 200 (Required Minimum
 * Functionality), Twitch 400 x 300 (its embed documentation); the others the same
 * as YouTube.
 */
const MIN_PLAYER: Record<'youtube' | 'twitch' | 'other', { w: number; h: number }> = {
  youtube: { w: 200, h: 200 },
  twitch: { w: 400, h: 300 },
  other: { w: 200, h: 200 },
};
const minPlayer = (s: Stream) => MIN_PLAYER[PLATFORM_OF[s.kind] === 'youtube' ? 'youtube' : PLATFORM_OF[s.kind] === 'twitch' ? 'twitch' : 'other'];

function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function LiveFeed({ instance }: {
  /** A duplicate tab's own settings (dashboard/tradeTabs.tsx): "2" for the second copy. */
  instance?: string;
} = {}) {
  const [stored, setStored] = useStored<FeedChoice>(`vs.livefeed.choice${instance ? `.${instance}` : ''}`, { channel: CHANNELS[0]!.id });
  const choice = readChoice(stored);
  // The sound the viewer chose (a stream starts without it); the player follows it.
  const [sound, setSound] = useState(false);
  const [draft, setDraft] = useState(choice && 'custom' in choice ? choice.custom : '');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [box, size] = useBoxSize<HTMLDivElement>();
  const [full, setFull] = useState(false);
  const [awake, setAwake] = useState(false);
  const idle = useRef<number | null>(null);
  const holding = useRef(false);

  const picked = streamOf(choice);
  // A channel plays its stream on air: the server reads which video that is (/api/vs/live).
  const channel = picked?.kind === 'youtube-live' ? picked.channel : null;
  const onAir = useAsync(() => (channel ? vsApi.live(channel) : Promise.resolve(null)), [channel], { pollMs: channel ? 5 * 60_000 : undefined });
  const lookingUp = !!channel && onAir.data === null && !onAir.error && onAir.loading;
  const stream = channel ? (onAir.data ? { kind: 'youtube' as const, video: onAir.data } : null) : picked;
  const offAir = !!channel && !lookingUp && !stream;
  const channelName = choice && 'channel' in choice ? CHANNELS.find((c) => c.id === choice.channel)?.name ?? 'This channel' : 'This channel';
  /*
   * The next FOMC press conference (the economic calendar, server
   * valuedesk/calendar.ts): 30 minutes after the 2:00 pm ET statement, on the
   * Fed's own channel: an off-air Fed channel says when it is next on (no strip over
   * the player - owner, 2026-10-25).
   */
  const cal = useAsync(() => vsApi.calendar(), [], { pollMs: 60 * 60_000 });
  // A minute's clock, so the countdown and "live now" keep up between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const fomc = (cal.data?.events ?? []).find((e) => e.short === 'FOMC' && e.source === 'fed' && e.time + 90 * 60_000 >= now) ?? null;
  const pressAt = fomc ? fomc.time + 30 * 60_000 : 0;
  const onFed = !!choice && 'channel' in choice && choice.channel === 'fed';
  const pressWhen = fomc ? new Date(pressAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  /* No platform's player loads before the viewer allows that platform (§ 25 TDDDG,
     legal/embeds.ts): until then there is no frame at all, only what loading it means. */
  const consent = useEmbedConsent();
  const platform = stream ? PLATFORM_OF[stream.kind] : null;
  const needsConsent = !!platform && consent.allowed[platform] === undefined;
  // Every player reloads with the sound setting: nothing is ever sent into a platform's player.
  const src = stream && !needsConsent ? embedUrl(stream, { muted: !sound, host: window.location.hostname }) : null;

  // A player: the header above it, the player in the rest - 16:9 where it fits, never
  // smaller than its platform allows, and nothing of the widget's over it.
  const docked = !!src;
  const area = { w: size.w, h: Math.max(0, size.h - HEAD) };
  const min = stream ? minPlayer(stream) : MIN_PLAYER.other;
  const fit = fitVideo(area.w, area.h);
  // A cell within a few percent of 16:9 (the News terminal sizes its rows to it, to a
  // row's rounding) is filled outright: no sliver of a bar beside or under the stream.
  const near = area.h > 0 && Math.abs(area.w / area.h / (16 / 9) - 1) < 0.04;
  const pic = near
    ? { w: Math.max(area.w, min.w), h: Math.max(area.h, min.h) }
    : { w: Math.min(area.w, Math.max(fit.w, min.w)), h: Math.min(area.h, Math.max(fit.h, min.h)) };
  const tooSmall = !!src && size.w > 0 && (area.w < min.w || area.h < min.h);

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [box]);
  // A new stream starts muted.
  const streamKey = stream ? JSON.stringify(stream) : '';
  useEffect(() => setSound(false), [streamKey]);

  const wake = () => {
    setAwake(true);
    if (idle.current !== null) window.clearTimeout(idle.current);
    // Resting on the controls keeps them: a click there never lands on a picture whose controls just left.
    idle.current = holding.current ? null : window.setTimeout(() => setAwake(false), IDLE_MS);
  };
  useEffect(() => () => {
    if (idle.current !== null) window.clearTimeout(idle.current);
  }, []);
  const hold = (on: boolean) => {
    holding.current = on;
    wake();
  };

  const toggleMute = () => setSound((s) => !s);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.();
  };
  const pick = (v: string) => {
    if (!v) return;
    setError(null);
    if (v === CUSTOM) {
      setEditing(true);
      return;
    }
    setEditing(false);
    setStored({ channel: v });
  };
  const play = () => {
    const s = parseStream(draft);
    if ('error' in s) {
      setError(s.error);
      return;
    }
    setError(null);
    setEditing(false);
    setStored({ custom: draft.trim() });
  };

  const value = editing || (choice && 'custom' in choice) ? CUSTOM : choice?.channel ?? '';
  const options = [
    // Cleared: the trigger says so rather than naming a channel that is not playing.
    ...(value ? [] : [{ value: '', label: 'Pick a channel' }]),
    ...CHANNELS.map((c) => ({ value: c.id, label: c.name })),
    { value: CUSTOM, label: choice && 'custom' in choice && picked ? `Custom · ${PLATFORM_NAME[picked.kind]}` : 'Custom link…' },
  ];
  const live = !!src && (channel !== null || picked?.kind === 'twitch' || picked?.kind === 'kick');

  const controls = (
    <>
      {live && <span className="lf__live"><i aria-hidden="true" />Live</span>}
      <FxSelect
        label="Live feed source"
        value={value}
        options={options}
        onChange={pick}
        searchable={false}
        triggerClassName="lf__pick"
        listMinWidth={220}
      />
      {editing && (
        <form className="lf__custom" onSubmit={(e) => { e.preventDefault(); play(); }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="youtube.com/watch?v=…, twitch.tv/…, kick.com/…"
            aria-label="A YouTube, Twitch, Kick or Vimeo link"
            spellCheck={false}
            autoFocus
          />
          <button type="submit" className="lf__btn lf__btn--go">Play</button>
        </form>
      )}
      <span className="lf__gap" />
      {stream && (
        <Btn label={sound ? 'Mute' : 'Unmute'} pressed={sound} onClick={toggleMute}>{sound ? <IconSound /> : <IconMuted />}</Btn>
      )}
      <Btn label={full ? 'Leave fullscreen' : 'Fullscreen'} onClick={toggleFull}>{full ? <IconShrink /> : <IconExpand />}</Btn>
      {choice && <Btn label="Clear the live feed" onClick={() => { setStored(null); setEditing(false); }}><IconClear /></Btn>}
    </>
  );

  const iframe = src && (
    <iframe
      key={src}
      className="lf__frame"
      src={src}
      title="Live feed"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );

  return (
    <div
      ref={box}
      className={`lf${src ? '' : ' is-empty'}${editing ? ' is-editing' : ''}${docked ? ' is-docked' : ''}${awake ? ' is-awake' : ''}`}
      onPointerMove={wake}
      onPointerEnter={wake}
      onPointerLeave={() => { holding.current = false; setAwake(false); }}
    >
      {docked && <div className="lf__head">{controls}</div>}
      {needsConsent && platform ? (
        <div className="lg-consent" role="group" aria-label={`Allow ${EMBED_PROVIDERS[platform].name}`}>
          <p className="lg-consent__title">Load the {EMBED_PROVIDERS[platform].name} player?</p>
          <p>{EMBED_NOTICE(EMBED_PROVIDERS[platform].name, EMBED_PROVIDERS[platform].operator)}</p>
          <div className="lg-consent__actions">
            <button type="button" className="fx-cta" onClick={() => allowEmbed(platform)}>Allow {EMBED_PROVIDERS[platform].name} and play</button>
            <a className="lg-link" href={EMBED_PROVIDERS[platform].policy} target="_blank" rel="noopener noreferrer">{EMBED_PROVIDERS[platform].name}&rsquo;s privacy policy</a>
            <LegalLink page="cookies">Withdraw at any time</LegalLink>
          </div>
        </div>
      ) : src && stream && tooSmall ? (
        <EmptyState icon="news" title="Make this panel larger to play" line={`${PLATFORM_NAME[stream.kind]}'s player needs at least ${min.w} \u00d7 ${min.h} pixels.`} />
      ) : src ? (
        <div className="lf__pic" style={{ width: pic.w, height: pic.h }}>{iframe}</div>
      ) : lookingUp ? (
        <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Finding the stream…</p>
      ) : offAir && onAir.error ? (
        // The lookup itself is unavailable (no YouTube key on the server, or YouTube down): say so plainly.
        <EmptyState icon="news" title="The news channels are unavailable right now" line="Paste a YouTube, Twitch, Kick or Vimeo link to watch meanwhile." />
      ) : offAir && onFed && fomc ? (
        <EmptyState icon="news" title="The Federal Reserve is not live right now" line={`The next FOMC press conference: ${pressWhen} (${untilText(pressAt, now)}). It plays here once it starts.`} />
      ) : offAir ? (
        <EmptyState icon="news" title={`${channelName} is not live right now`} line="Pick another channel; this one is checked again every few minutes." />
      ) : (
        <EmptyState icon="news" title="No live feed" line="Pick a news channel, or paste a YouTube, Twitch, Kick or Vimeo link." />
      )}
      {!docked && (
        <div className="lf__bar" onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)}>
          {controls}
        </div>
      )}
      {error && <p className="lf__err" role="alert">{error}</p>}
    </div>
  );
}

/** "in 3d 4h", "in 45m", "now". */
function untilText(t: number, now: number): string {
  const m = Math.round((t - now) / 60_000);
  if (m <= 0) return 'now';
  if (m >= 1440) return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `in ${m}m`;
}

function Btn({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="lf__btn" onClick={onClick} aria-pressed={pressed} aria-label={label} title={label}>
      {children}
    </button>
  );
}

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IconSound = () => icon(<><path d="M3.5 8v4h3l4 3.5v-11l-4 3.5z" /><path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9" /></>);
const IconMuted = () => icon(<><path d="M3.5 8v4h3l4 3.5v-11l-4 3.5z" /><path d="m13.5 8 4 4M17.5 8l-4 4" /></>);
const IconExpand = () => icon(<path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" />);
const IconShrink = () => icon(<path d="M7.5 3.5v4h-4M16.5 7.5h-4v-4M12.5 16.5v-4h4M3.5 12.5h4v4" />);
const IconClear = () => icon(<path d="m5 5 10 10M15 5 5 15" />);
