/**
 * The Live Feed widget: a news channel's live stream (Bloomberg TV, CNBC, CBS
 * News, Yahoo Finance, the White House and more - model.ts CHANNELS), or a
 * pasted YouTube, Twitch, Kick or Vimeo link.
 *
 * Two shapes, by the panel's own size. With room above a 16:9 picture the
 * controls are a header that stays - LIVE with a slow red dot, the source,
 * play / pause, mute, fullscreen, clear - over a picture sized to exactly 16:9,
 * so there are no black bars. Without it the picture fills the panel and the
 * same controls float over its top edge, showing while the pointer moves (and
 * while it rests on them) and hiding together a moment after it stops.
 *
 * A YouTube stream shows none of YouTube's own overlays. A transparent layer
 * keeps its hover controls away; the player is made taller than its picture and
 * clipped to it, so its title bar, logo and "More videos" land outside the clip
 * (ytPlayer.ts playerBand). YouTube also shows a play / pause button in the
 * middle for a few seconds each time playback starts - on load and on resume,
 * whatever its controls setting - so the widget's own cover stays over the
 * picture from the load until that has passed, and a channel's live stream is
 * never stopped and started again: pausing it holds it, running on silently
 * under the cover, and play lifts the cover - at once, and live. A pasted video
 * pauses for real. The widget drives the player through its commands and reads
 * back what it does (ytPlayer.ts), so play / pause shows the real state; the
 * sound follows the viewer's choice; captions are unloaded each time it starts
 * playing (YouTube turns them on for a muted video). Twitch, Kick and Vimeo keep
 * their own controls. It starts muted (a browser only autoplays a muted video;
 * the site's Permissions-Policy lets these players play sound once unmuted). The
 * choice is remembered on this browser.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useAsync, useStored } from '../../hooks';
import { vsApi } from '../../vsApi';
import { FxSelect } from '../funds/ui';
import { EmptyState } from '../EmptyState';
import { CHANNELS, PLATFORM_NAME, embedUrl, isYouTube, parseStream, readChoice, streamOf, type FeedChoice } from './model';
import { YT, YT_ORIGIN, fitVideo, playerBand, readYtMessage, ytCommand, ytListening, type YtReport } from './ytPlayer';
import './LiveFeed.css';

const CUSTOM = 'custom';
/** The header's height when it stays above the picture. */
const HEAD = 46;
/** The floating controls hide this long after the pointer stops. */
const IDLE_MS = 2200;
/** A single click on the picture waits this long to tell itself from a double click (fullscreen). */
const CLICK_MS = 220;
/** A player that has not started this long after it answered is held up (autoplay refused): the widget offers play. */
const STALL_MS = 3500;
/** How long YouTube's own play / pause shows in the middle after playback starts: the cover stays this long. */
const SETTLE_MS = 4500;
/** A frame that never reports (its messages blocked) is uncovered after this long. */
const LOAD_MS = 10_000;

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

interface PlayerView {
  ready: boolean;
  state: number | null;
  muted: boolean | null;
}
const NO_VIEW: PlayerView = { ready: false, state: null, muted: null };

/**
 * What a YouTube embed reports about itself, from its frame's load on. It is
 * told the widget listens until it answers; `assume` shows a command's outcome
 * before the player confirms it.
 */
function useYouTube(frame: RefObject<HTMLIFrameElement | null>, src: string | null, on: boolean) {
  const [view, setView] = useState<PlayerView>(NO_VIEW);
  const heard = useRef(false);
  const knock = useRef<number | null>(null);
  const send = useCallback((msg: string) => frame.current?.contentWindow?.postMessage(msg, YT_ORIGIN), [frame]);
  const stopKnocking = () => {
    if (knock.current !== null) window.clearInterval(knock.current);
    knock.current = null;
  };

  useEffect(() => {
    setView(NO_VIEW);
    heard.current = false;
    if (!on) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || !frame.current || e.source !== frame.current.contentWindow) return;
      const r = readYtMessage(e.data);
      if (!r) return;
      if (!heard.current) {
        heard.current = true;
        stopKnocking();
        send(ytCommand('addEventListener', ['onStateChange']));
      }
      setView((p) => ({ ready: true, state: r.state ?? p.state, muted: r.muted ?? p.muted }));
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      stopKnocking();
    };
  }, [src, on, frame, send]);

  const onLoad = useCallback(() => {
    if (!on) return;
    heard.current = false;
    stopKnocking();
    let tries = 0;
    send(ytListening());
    knock.current = window.setInterval(() => {
      if (heard.current || ++tries > 60) stopKnocking();
      else send(ytListening());
    }, 250);
  }, [on, send]);

  const assume = useCallback((r: YtReport) => setView((p) => ({ ...p, state: r.state ?? p.state, muted: r.muted ?? p.muted })), []);
  return { ...view, send, onLoad, assume };
}

/**
 * Whether YouTube's own play / pause has left the middle of the picture: false
 * from a frame's load until SETTLE_MS after its player starts playing, and again
 * after each later start (a resume) - a rebuffer inside a run is no start. A frame
 * that never reports is taken as settled after LOAD_MS.
 */
function useSettled(src: string | null, state: number | null, ready: boolean) {
  const [settled, setSettled] = useState(false);
  const inRun = useRef(false);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    setSettled(false);
    inRun.current = false;
    clear();
  }, [src]);
  useEffect(() => {
    if (!src || ready) return;
    const t = window.setTimeout(() => setSettled(true), LOAD_MS);
    return () => window.clearTimeout(t);
  }, [src, ready]);
  useEffect(() => {
    if (state === YT.playing && !inRun.current) {
      inRun.current = true;
      setSettled(false);
      clear();
      timer.current = window.setTimeout(() => setSettled(true), SETTLE_MS);
    } else if (state !== YT.playing && state !== YT.buffering) {
      inRun.current = false;
    }
  }, [state]);
  useEffect(() => clear, []);
  return settled;
}

export function LiveFeed({ instance }: {
  /** A duplicate tab's own settings (dashboard/tradeTabs.tsx): "2" for the second copy. */
  instance?: string;
} = {}) {
  const [stored, setStored] = useStored<FeedChoice>(`vs.livefeed.choice${instance ? `.${instance}` : ''}`, { channel: CHANNELS[0]!.id });
  const choice = readChoice(stored);
  // The sound the viewer chose (a stream starts without it); the player follows it.
  const [sound, setSound] = useState(false);
  // A channel's live stream paused: it runs on, silent, under the widget's cover.
  const [held, setHeld] = useState(false);
  const [draft, setDraft] = useState(choice && 'custom' in choice ? choice.custom : '');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [box, size] = useBoxSize<HTMLDivElement>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [full, setFull] = useState(false);
  const [awake, setAwake] = useState(false);
  const idle = useRef<number | null>(null);
  const holding = useRef(false);
  const click = useRef<number | null>(null);

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
    ? embedUrl(stream, { muted: yt ? true : !sound, host: window.location.hostname, origin: window.location.origin })
    : null;
  const player = useYouTube(frame, src, yt);

  // Room above a 16:9 picture for the header: it stays, and the picture takes exactly 16:9.
  const docked = !!src && !full && size.w > 0 && size.h - HEAD >= (size.w * 9) / 16 - 2;
  const pic = docked ? { w: size.w, h: Math.round((size.w * 9) / 16) } : null;
  const video = fitVideo(pic?.w ?? size.w, pic?.h ?? size.h);
  const band = playerBand(video.h);

  // A channel's stream is live: pausing holds it instead of stopping the player (which
  // would bring YouTube's own button back when it starts again).
  const holdable = channel !== null;
  // What the player does, once it has said so; until then it is taken to autoplay.
  const running = player.state === null || player.state === YT.playing || player.state === YT.buffering;
  const stopped = player.ready && (player.state === YT.paused || player.state === YT.ended);
  const playing = running && !held;
  const [stalled, setStalled] = useState(false);
  const notStarted = player.state === null || player.state === YT.unstarted || player.state === YT.cued;
  useEffect(() => {
    setStalled(false);
    if (!yt || !player.ready || !notStarted) return;
    const t = window.setTimeout(() => setStalled(true), STALL_MS);
    return () => window.clearTimeout(t);
  }, [yt, player.ready, notStarted]);
  const settled = useSettled(yt ? src : null, player.state, player.ready);
  // The cover: a play button when paused, held or held up; a spinner while YouTube's own button shows.
  const cover = !yt ? null : held || stopped || stalled ? 'paused' : !settled ? 'starting' : null;
  const lastCover = useRef<'paused' | 'starting'>('starting');
  if (cover) lastCover.current = cover;

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [box]);
  // A new stream starts muted and playing.
  const streamKey = stream ? JSON.stringify(stream) : '';
  useEffect(() => {
    setSound(false);
    setHeld(false);
  }, [streamKey]);

  // The player's sound follows the viewer's choice; a held stream stays silent under its cover.
  const { send } = player;
  const silent = !sound || held;
  useEffect(() => {
    if (yt && player.ready) send(ytCommand(silent ? 'mute' : 'unMute'));
  }, [yt, player.ready, silent, send]);

  // Captions off each time it starts playing: YouTube turns them on for a muted video,
  // and again when it resumes.
  const reallyPlaying = player.state === YT.playing;
  useEffect(() => {
    if (!yt || !reallyPlaying) return;
    const off = () => {
      send(ytCommand('unloadModule', ['captions']));
      send(ytCommand('unloadModule', ['cc']));
    };
    off();
    const t = window.setTimeout(off, 1500);
    return () => window.clearTimeout(t);
  }, [yt, reallyPlaying, send]);

  const wake = () => {
    setAwake(true);
    if (idle.current !== null) window.clearTimeout(idle.current);
    // Resting on the controls keeps them: a click there never lands on a picture whose controls just left.
    idle.current = holding.current ? null : window.setTimeout(() => setAwake(false), IDLE_MS);
  };
  useEffect(() => () => {
    if (idle.current !== null) window.clearTimeout(idle.current);
    if (click.current !== null) window.clearTimeout(click.current);
  }, []);
  const hold = (on: boolean) => {
    holding.current = on;
    wake();
  };

  const command = (next: boolean) => {
    player.assume({ state: next ? YT.playing : YT.paused });
    setStalled(false);
    send(ytCommand(next ? 'playVideo' : 'pauseVideo'));
  };
  // Pause: a live channel is held, a pasted video stops. Play: the cover lifts, and the
  // player is started only if it is not already running.
  const togglePlay = () => {
    if (!yt) return;
    if (playing) {
      if (holdable) setHeld(true);
      else command(false);
      return;
    }
    setHeld(false);
    if (!running || stopped || stalled) command(true);
  };
  const toggleMute = () => setSound((s) => !s);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.();
  };
  // One click on the picture pauses or plays; a double click is fullscreen only.
  const onPicClick = () => {
    if (click.current !== null) window.clearTimeout(click.current);
    click.current = window.setTimeout(() => {
      click.current = null;
      togglePlay();
    }, CLICK_MS);
  };
  const onPicDouble = () => {
    if (click.current !== null) window.clearTimeout(click.current);
    click.current = null;
    toggleFull();
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
        <Btn label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>{playing ? <IconPause /> : <IconPlay />}</Btn>
      )}
      {stream && (
        <Btn label={sound ? 'Mute' : 'Unmute'} pressed={sound} onClick={toggleMute}>{sound ? <IconSound /> : <IconMuted />}</Btn>
      )}
      <Btn label={full ? 'Leave fullscreen' : 'Fullscreen'} onClick={toggleFull}>{full ? <IconShrink /> : <IconExpand />}</Btn>
      {choice && <Btn label="Clear the live feed" onClick={() => { setStored(null); setEditing(false); }}><IconClear /></Btn>}
    </>
  );

  const iframe = (cls: string, style?: CSSProperties) => src && (
    <iframe
      key={src}
      ref={frame}
      className={cls}
      style={style}
      src={src}
      title="Live feed"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      onLoad={player.onLoad}
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
      {src ? (
        <div className="lf__pic" style={pic ? { width: pic.w, height: pic.h } : undefined}>
          {yt ? (
            <div className="lf__vid" style={{ left: video.x, top: video.y, width: video.w, height: video.h }}>
              {iframe('lf__frame lf__frame--yt', { top: -band, height: video.h + 2 * band })}
              {/* YouTube under a layer: its own hover controls never show; the widget's do. */}
              <div className="lf__shield" onClick={onPicClick} onDoubleClick={onPicDouble} aria-hidden="true" />
              {/* Always there, so it fades out rather than vanishing; its last face stays while it fades. */}
              <button
                type="button"
                className={`lf__cover${cover ? ' is-on' : ''}`}
                onClick={cover === 'paused' ? togglePlay : onPicClick}
                onDoubleClick={onPicDouble}
                aria-label={lastCover.current === 'paused' ? 'Play' : 'Starting the stream'}
                aria-hidden={!cover}
                tabIndex={cover ? 0 : -1}
              >
                <span className="lf__big">{lastCover.current === 'paused' ? <IconPlay /> : <span className="lf__spin" aria-hidden="true" />}</span>
              </button>
            </div>
          ) : (
            iframe('lf__frame')
          )}
        </div>
      ) : lookingUp ? (
        <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Finding the stream…</p>
      ) : offAir ? (
        <EmptyState icon="news" title={`${channelName} is not live right now`} line={onAir.error ? onAir.error : 'Pick another channel; this one is checked again every few minutes.'} />
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
