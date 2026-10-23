/**
 * The Live Feed widget: a news channel's live stream (Bloomberg TV, CNBC, CBS
 * News, Yahoo Finance, the White House and more - model.ts CHANNELS), or a
 * pasted YouTube, Twitch, Kick or Vimeo link.
 *
 * Two shapes, by the panel's own size. With room above a 16:9 picture the
 * controls are a header that stays - LIVE with a slow red dot, the source,
 * play / pause, mute, fullscreen, clear - over a picture sized to exactly 16:9,
 * so there are no black bars. Without it the picture fills the panel and the
 * same controls float over its top edge, showing while the pointer moves and
 * hiding together a moment after it stops.
 *
 * A YouTube stream sits under a transparent layer: its own controls (the
 * pause button that outstayed everything else) never show, and the widget
 * drives it through the player's commands - play, pause, mute, and captions
 * off, which YouTube otherwise turns on for a muted video. Twitch, Kick and
 * Vimeo keep their own controls. It starts muted (a browser only autoplays a
 * muted video). The choice is remembered on this browser.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAsync, useStored } from '../../hooks';
import { vsApi } from '../../vsApi';
import { FxSelect } from '../funds/ui';
import { EmptyState } from '../EmptyState';
import { CHANNELS, PLATFORM_NAME, embedUrl, isYouTube, parseStream, readChoice, streamOf, type FeedChoice } from './model';
import './LiveFeed.css';

const CUSTOM = 'custom';
/** The header's height when it stays above the picture. */
const HEAD = 46;
/** The floating controls hide this long after the pointer stops. */
const IDLE_MS = 2200;

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
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState(choice && 'custom' in choice ? choice.custom : '');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [box, size] = useBoxSize<HTMLDivElement>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [full, setFull] = useState(false);
  const [awake, setAwake] = useState(false);
  const idle = useRef<number | null>(null);

  const picked = streamOf(choice);
  // A channel plays its stream on air: the server reads which video that is (/api/vs/live).
  const channel = picked?.kind === 'youtube-live' ? picked.channel : null;
  const onAir = useAsync(() => (channel ? vsApi.live(channel) : Promise.resolve(null)), [channel], { pollMs: channel ? 5 * 60_000 : undefined });
  const lookingUp = !!channel && onAir.data === null && !onAir.error && onAir.loading;
  const stream = channel ? (onAir.data ? { kind: 'youtube' as const, video: onAir.data } : null) : picked;
  const offAir = !!channel && !lookingUp && !stream;
  const channelName = choice && 'channel' in choice ? CHANNELS.find((c) => c.id === choice.channel)?.name ?? 'This channel' : 'This channel';
  const yt = stream ? isYouTube(stream) : false;
  // YouTube's mute is a command, so its URL keeps the muted start; the others reload with the setting.
  const src = stream
    ? embedUrl(stream, { muted: yt ? true : muted, host: window.location.hostname, origin: window.location.origin })
    : null;

  // Room above a 16:9 picture for the header: it stays, and the picture takes exactly 16:9.
  const docked = !!src && !full && size.w > 0 && size.h - HEAD >= (size.w * 9) / 16 - 2;
  const pic = docked ? { w: size.w, h: Math.round((size.w * 9) / 16) } : null;

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [box]);
  // A new stream starts muted and playing again.
  const streamKey = stream ? JSON.stringify(stream) : '';
  useEffect(() => {
    setMuted(true);
    setPaused(false);
  }, [streamKey]);

  const command = useCallback((func: string, args: unknown[] = []) => {
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
  }, []);
  /* Captions off: YouTube turns them on for a muted video. The player takes commands
     once it has started, so the command goes again for the first few seconds. */
  const onFrameLoad = () => {
    if (!yt) return;
    for (const ms of [600, 1800, 4000, 8000]) {
      window.setTimeout(() => {
        command('unloadModule', ['captions']);
        command('unloadModule', ['cc']);
      }, ms);
    }
  };

  const wake = () => {
    setAwake(true);
    if (idle.current !== null) window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setAwake(false), IDLE_MS);
  };
  useEffect(() => () => { if (idle.current !== null) window.clearTimeout(idle.current); }, []);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (yt) {
      command(next ? 'mute' : 'unMute');
      if (!next) command('playVideo');
    }
  };
  const togglePlay = () => {
    const next = !paused;
    setPaused(next);
    command(next ? 'pauseVideo' : 'playVideo');
  };
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
      {stream && yt && (
        <Btn label={paused ? 'Play' : 'Pause'} onClick={togglePlay}>{paused ? <IconPlay /> : <IconPause />}</Btn>
      )}
      {stream && (
        <Btn label={muted ? 'Unmute' : 'Mute'} pressed={!muted} onClick={toggleMute}>{muted ? <IconMuted /> : <IconSound />}</Btn>
      )}
      <Btn label={full ? 'Leave fullscreen' : 'Fullscreen'} onClick={toggleFull}>{full ? <IconShrink /> : <IconExpand />}</Btn>
      {choice && <Btn label="Clear the live feed" onClick={() => { setStored(null); setEditing(false); }}><IconClear /></Btn>}
    </>
  );

  return (
    <div
      ref={box}
      className={`lf${src ? '' : ' is-empty'}${editing ? ' is-editing' : ''}${docked ? ' is-docked' : ''}${awake ? ' is-awake' : ''}`}
      onPointerMove={wake}
      onPointerEnter={wake}
      onPointerLeave={() => setAwake(false)}
    >
      {docked && <div className="lf__head">{controls}</div>}
      {src ? (
        <div className="lf__pic" style={pic ? { width: pic.w, height: pic.h } : undefined}>
          <iframe
            key={src}
            ref={frame}
            className="lf__frame"
            src={src}
            title="Live feed"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={onFrameLoad}
          />
          {/* YouTube under a layer: its own hover controls never show; the widget's do. */}
          {yt && <div className="lf__shield" onDoubleClick={toggleFull} onClick={togglePlay} aria-hidden="true" />}
        </div>
      ) : lookingUp ? (
        <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Finding the stream…</p>
      ) : offAir ? (
        <EmptyState icon="news" title={`${channelName} is not live right now`} line={onAir.error ? onAir.error : 'Pick another channel; this one is checked again every few minutes.'} />
      ) : (
        <EmptyState icon="news" title="No live feed" line="Pick a news channel, or paste a YouTube, Twitch, Kick or Vimeo link." />
      )}
      {!docked && <div className="lf__bar">{controls}</div>}
      {error && <p className="lf__err" role="alert">{error}</p>}
    </div>
  );
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
const IconPlay = () => icon(<path d="M7 5.5v9l7.5-4.5z" fill="currentColor" />);
const IconPause = () => icon(<path d="M7.5 5v10M12.5 5v10" />);
const IconSound = () => icon(<><path d="M3.5 8v4h3l4 3.5v-11l-4 3.5z" /><path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9" /></>);
const IconMuted = () => icon(<><path d="M3.5 8v4h3l4 3.5v-11l-4 3.5z" /><path d="m13.5 8 4 4M17.5 8l-4 4" /></>);
const IconExpand = () => icon(<path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" />);
const IconShrink = () => icon(<path d="M7.5 3.5v4h-4M16.5 7.5h-4v-4M12.5 16.5v-4h4M3.5 12.5h4v4" />);
const IconClear = () => icon(<path d="m5 5 10 10M15 5 5 15" />);
