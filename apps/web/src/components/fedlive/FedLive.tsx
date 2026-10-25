/**
 * The Fed live widget: the Federal Reserve's own broadcast of an FOMC press
 * conference (or its last recording), with the words written out BEFORE the
 * picture says them.
 *
 * The broadcast plays twice (engine.ts): the picture with a player's usual
 * buffer, and a silent ear at the live edge whose audio a speech model turns
 * into text in this browser (stt.worker.ts) - or, without the model, the Fed's
 * own captions read from the same edge. Each line counts down to the moment the
 * picture reaches it and is marked said when it does. Words that move rates are
 * marked (keywords.ts): dovish green, hawkish red.
 *
 * Consent first (legal/embeds.ts `fed`): nothing of Brightcove loads before the
 * visitor allows it (the speech model is this site's own file). The Fed's broadcast is the US
 * government's own; YouTube's copies are never read (their terms).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAsync } from '../../hooks';
import { vsApi } from '../../vsApi';
import { EMBED_PROVIDERS, allowEmbed, useEmbedConsent } from '../../legal/embeds';
import { LegalLink } from '../../legal/LegalGate';
import { EmptyState } from '../EmptyState';
import { FedEngine, REPLAY_LEAD_S, type EngineState, type FedSource, type Line, type TextMode } from './engine';
import { markTerms, termsIn, type Tone } from './keywords';
import './FedLive.css';

const NOTICE = 'Starting loads the Federal Reserve’s broadcast from Brightcove’s servers (its video host), which receive your IP address and this page’s address. The words are turned into text in your browser by a speech model this site serves (about 30 MB, once); no audio leaves your device.';

async function fedLive(signal?: AbortSignal): Promise<FedSource | null> {
  const r = await fetch('/api/vs/fed/live', { signal });
  if (!r.ok) return null;
  const j = (await r.json()) as { ok?: boolean } & Partial<FedSource>;
  return j.ok && j.hls ? (j as FedSource) : null;
}

function fmtIn(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

const TONE_NAME: Record<Tone, string> = { dove: 'Dovish', hawk: 'Hawkish', neutral: 'Watched' };

export function FedLive() {
  const consent = useEmbedConsent();
  const allowed = consent.allowed.fed !== undefined;
  const src = useAsync(() => (allowed ? fedLive() : Promise.resolve(null)), [allowed], { pollMs: 30_000 });
  const cal = useAsync(() => vsApi.calendar(), [], { pollMs: 10 * 60_000 });
  const next = useMemo(() => {
    const now = Date.now();
    const e = (cal.data?.events ?? []).find((x) => x.id.startsWith('fed:fomc:') && x.time + 2 * 3600_000 > now);
    return e ? { statement: e.time, presser: e.time + 30 * 60_000 } : null;
  }, [cal.data]);

  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<FedEngine | null>(null);
  const [st, setSt] = useState<EngineState>({ phase: 'idle', device: null, download: null, error: null, lead: null });
  const [lines, setLines] = useState<Line[]>([]);
  const [mode, setMode] = useState<TextMode>('model');
  const [, tick] = useState(0);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!video.current) return;
    const e = new FedEngine(video.current, (l) => setLines((xs) => [...xs.slice(-400), l]), setSt);
    engine.current = e;
    return () => e.dispose();
  }, [allowed]);

  // The countdowns run while it plays.
  useEffect(() => {
    if (st.phase !== 'running') return;
    const t = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, [st.phase]);

  // Follow the newest line unless the reader scrolled up.
  useEffect(() => {
    const el = list.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const now = Date.now();
  const s = src.data;
  const pic = engine.current?.pictureTime ?? 0;
  const tally = useMemo(() => {
    const t: Record<Tone, number> = { dove: 0, hawk: 0, neutral: 0 };
    for (const l of lines) for (const x of termsIn(l.text)) t[x.tone]++;
    return t;
  }, [lines]);

  const start = () => {
    if (!s || !engine.current) return;
    setLines([]);
    void engine.current.start(s, mode);
  };
  const stop = () => engine.current?.stop();
  const running = st.phase === 'running' || st.phase === 'loading';

  if (!allowed) {
    return (
      <div className="fl fl--gate">
        <div className="lg-consent" role="group" aria-label="Allow the Federal Reserve broadcast">
          <p className="lg-consent__title">Load the Federal Reserve’s broadcast?</p>
          <p>{NOTICE}</p>
          <div className="lg-consent__actions">
            <button type="button" className="fx-cta" onClick={() => allowEmbed('fed')}>Allow and continue</button>
            <a className="lg-link" href={EMBED_PROVIDERS.fed.policy} target="_blank" rel="noopener noreferrer">Brightcove’s privacy policy</a>
            <LegalLink page="cookies">Withdraw at any time</LegalLink>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fl">
      <header className="fl__head">
        <span className={`fl__badge${s?.live ? ' is-live' : ''}`}>{s ? (s.live ? 'LIVE' : 'REPLAY') : 'OFF AIR'}</span>
        <span className="fl__name" title={s?.name}>{s?.name ?? 'Federal Reserve'}</span>
        {st.lead !== null && st.lead > 0.5 && <span className="fl__lead" title="How far the transcript is ahead of the picture">Text {st.lead.toFixed(0)}s ahead</span>}
        <span className="fl__spacer" />
        <div className="fl__seg" role="radiogroup" aria-label="Transcript from">
          <button type="button" role="radio" aria-checked={mode === 'model'} className={mode === 'model' ? 'is-on' : ''} disabled={running} onClick={() => setMode('model')} title="A speech model in your browser: earliest">Speech model</button>
          <button type="button" role="radio" aria-checked={mode === 'captions'} className={mode === 'captions' ? 'is-on' : ''} disabled={running} onClick={() => setMode('captions')} title="The Fed's own captions: lighter, a few seconds later">Fed captions</button>
        </div>
        {running
          ? <button type="button" className="fl__btn" onClick={stop}>Stop</button>
          : <button type="button" className="fl__btn is-go" disabled={!s} onClick={start}>{s?.live ? 'Start' : 'Replay last'}</button>}
      </header>

      <div className="fl__body">
        <div className="fl__pic">
          <video ref={video} playsInline controls poster={s?.poster ?? undefined} />
          {st.phase === 'idle' && (
            <div className="fl__over">
              {s?.live
                ? <p>The press conference is on air. Start to watch it with the words ahead of the picture.</p>
                : next
                  ? <p>Next FOMC press conference in <b>{fmtIn(next.presser - now)}</b>. Meanwhile, replay the last one to see how it works (the picture runs {REPLAY_LEAD_S}s behind).</p>
                  : <p>No press conference on air.</p>}
            </div>
          )}
        </div>

        <div className="fl__side">
          <div className="fl__tally" aria-label="Marked words so far">
            {(['dove', 'hawk', 'neutral'] as Tone[]).map((t) => (
              <span key={t} className={`fl__chip is-${t}`}>{TONE_NAME[t]} <b>{tally[t]}</b></span>
            ))}
            {st.device && <span className="fl__dev" title="Where the speech model runs">On your device</span>}
          </div>
          {st.phase === 'loading' && (
            <p className="fl__status" role="status">
              {st.download !== null ? <>Loading the speech model… {Math.round(st.download * 100)}%</> : 'Starting…'}
              {st.download !== null && <span className="fl__bar"><i style={{ width: `${Math.round(st.download * 100)}%` }} /></span>}
            </p>
          )}
          {st.error && <p className="fl__error" role="alert">{st.error}</p>}
          {lines.length === 0 && st.phase === 'running' && <p className="fl__status">Listening… the first words appear once someone speaks.</p>}
          {lines.length === 0 && st.phase === 'idle' && !st.error && (
            <EmptyState icon="news" title="The transcript appears here" line="Each line counts down to the moment the picture says it. Rate words are marked: dovish green, hawkish red." />
          )}
          <ol ref={list} className="fl__lines">
            {lines.map((l) => {
              const due = l.at - pic;
              const said = st.phase !== 'running' || due <= 0;
              return (
                <li key={l.id} className={said ? 'is-said' : 'is-ahead'}>
                  <span className="fl__when">{said ? 'said' : `in ${Math.ceil(due)}s`}</span>
                  <span className="fl__text">
                    {markTerms(l.text).map((sp, i) => (sp.tone ? <mark key={i} className={`is-${sp.tone}`}>{sp.text}</mark> : <span key={i}>{sp.text}</span>))}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
