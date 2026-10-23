/**
 * The Live Feed widget: a news channel's live stream (Bloomberg TV, CNBC, CBS
 * News, Yahoo Finance, the White House and more - model.ts CHANNELS), or a
 * pasted YouTube, Twitch, Kick or Vimeo link.
 *
 * The controls stay out of the picture until the pointer is over it: the
 * source dropdown, mute / unmute, fullscreen and clear. It starts muted (a
 * browser only autoplays a muted video); YouTube takes mute and unmute as
 * player commands, the other players reload with the new setting. The choice
 * is remembered on this browser.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAsync, useStored } from '../../hooks';
import { vsApi } from '../../vsApi';
import { FxSelect } from '../funds/ui';
import { EmptyState } from '../EmptyState';
import { CHANNELS, PLATFORM_NAME, embedUrl, isYouTube, parseStream, readChoice, streamOf, type FeedChoice } from './model';
import './LiveFeed.css';

const CUSTOM = 'custom';

export function LiveFeed() {
  const [stored, setStored] = useStored<FeedChoice>('vs.livefeed.choice', { channel: CHANNELS[0]!.id });
  const choice = readChoice(stored);
  const [muted, setMuted] = useState(true);
  const [draft, setDraft] = useState(choice && 'custom' in choice ? choice.custom : '');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [full, setFull] = useState(false);
  // The pointer over the player is in the player's own document, so :hover on this box is not
  // reliable there: entering and leaving the box are what show and hide the controls.
  const [hover, setHover] = useState(false);

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

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  // A new stream starts muted again.
  const streamKey = stream ? JSON.stringify(stream) : '';
  useEffect(() => setMuted(true), [streamKey]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (yt) {
      frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: next ? 'mute' : 'unMute', args: [] }), 'https://www.youtube.com');
      if (!next) frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), 'https://www.youtube.com');
    }
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

  return (
    <div
      className={`lf${src ? '' : ' is-empty'}${editing ? ' is-editing' : ''}${hover ? ' is-hover' : ''}`}
      ref={box}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {src ? (
        <iframe
          key={src}
          ref={frame}
          className="lf__frame"
          src={src}
          title="Live feed"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : lookingUp ? (
        <p className="acct-empty acct-loading" role="status"><span className="acct-spin" aria-hidden="true" />Finding the stream…</p>
      ) : offAir ? (
        <EmptyState icon="news" title={`${channelName} is not live right now`} line={onAir.error ? onAir.error : 'Pick another channel; this one is checked again every few minutes.'} />
      ) : (
        <EmptyState icon="news" title="No live feed" line="Pick a news channel, or paste a YouTube, Twitch, Kick or Vimeo link." />
      )}

      <div className="lf__bar">
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
          <button type="button" className="lf__btn" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? <IconMuted /> : <IconSound />}
          </button>
        )}
        <button type="button" className="lf__btn" onClick={toggleFull} aria-label={full ? 'Leave fullscreen' : 'Fullscreen'} title={full ? 'Leave fullscreen' : 'Fullscreen'}>
          {full ? <IconShrink /> : <IconExpand />}
        </button>
        {choice && (
          <button type="button" className="lf__btn" onClick={() => { setStored(null); setEditing(false); }} aria-label="Clear the live feed" title="Clear">
            <IconClear />
          </button>
        )}
      </div>
      {error && <p className="lf__err" role="alert">{error}</p>}
    </div>
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
