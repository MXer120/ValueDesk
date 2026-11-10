/**
 * Status: first exactly what www.valuedesk.so/status says - the same verdict per service (admin/statusView.ts
 * judge, with statusModel.ts shownState), its pills and 90-day bars - then what only the owner needs: why a
 * service is not up (the prober's failed checks), the probe beside a maintenance, the indexer's lanes and
 * streams, the executor, server 1, releases, brake and browser errors.
 *
 * Owner 2026-11-07: "on dev page it says indexer degraded. on production it doesnt (maintenance?)". The page
 * showed the raw probe; the public page shows maintenance while a release's notice is open. Both now judge
 * with one function, and the probe is shown as a detail, never as a second verdict.
 */
import { DayBars } from '../../status/StatusPage';
import { SERVICE_LINE, SHOWN_TEXT, STATE_TEXT, dayDetail, fmtUptime } from '../../status/statusData';
import { ago, bytes, duration, int, when } from '../format';
import { Empty, Note, OVERALL_WORDS, Page, Pill, Section, ShownPill, toneOfOverall, useAdmin } from '../ui';
import type { EverythingStatus, JudgedService } from '../types';

const isErr = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in v && typeof (v as { error: unknown }).error === 'string';
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface IndexerView {
  health: {
    at: number | null;
    streams: Record<string, boolean>;
    loopLagMs: { lastMinute: number | null; sinceStart: number | null };
    lanes: Record<string, { queued: number | null; done: number | null; failed: number | null; backoffMs: number | null }>;
    lastBuildAt: number | null;
    lastBuildMs: number | null;
  } | null;
  lastError: string | null;
  stopping: boolean;
  steps: Array<[string, number]>;
}

export function Status() {
  const r = useAdmin<{ status: EverythingStatus | null }>('status', {}, 30_000);
  const s = r.data?.status ?? null;
  const judged = s?.judged ?? null;
  const report = s && !isErr(s.report) ? s.report : null;
  const notUp = (judged?.services ?? []).filter((x) => x.shown !== 'up' && x.shown !== 'unknown');
  const indexerWhy = judged?.services.find((x) => x.id === 'indexer')?.why ?? [];
  return (
    <Page
      title={judged ? OVERALL_WORDS[judged.overall] : s ? 'Status not readable' : 'Checking…'}
      line={notUp.length ? notUp.map((x) => `${x.name}: ${SHOWN_TEXT[x.shown]}`).join(' · ') : 'The same verdict as www.valuedesk.so/status, with the detail behind it. Every 30 s.'}
      tone={toneOfOverall(judged?.overall)}
      loaded={r}
      wide
    >
      {r.error && <Section><Note kind="error">{r.error}</Note></Section>}
      {s && isErr(s.report) && <Section><Note kind="error">The status record: {s.report.error}</Note></Section>}
      {judged && report && (
        <ul className="st-list" aria-label="Services">
          {judged.services.map((x) => {
            const raw = report.services?.find((y) => y.id === x.id);
            const notices = (report.notices ?? []) as unknown as Parameters<typeof dayDetail>[2];
            const days = (raw?.days ?? []).map((d) => dayDetail(d, x.id as Parameters<typeof dayDetail>[1], notices, s!.at));
            return (
              <li key={x.id} className="st-svc">
                <div className="st-svc__head">
                  <div className="st-svc__name">
                    <b>{x.name}</b>
                    <small>{SERVICE_LINE[x.id as keyof typeof SERVICE_LINE] ?? ''}</small>
                  </div>
                  <div className="st-svc__now">
                    <ShownPill state={x.shown} />
                    {x.latencyMs !== null && x.probe !== 'unknown' && <small className="st-ms">{x.latencyMs} ms</small>}
                  </div>
                </div>
                {days.length > 0 && <DayBars days={days} label={`${x.name}: ${fmtUptime(x.uptime)} uptime over the last ${days.length} days`} />}
                <div className="st-scale" aria-hidden="true">
                  <span>{days.length} days ago</span>
                  <span className="st-scale__pct">{fmtUptime(x.uptime)} uptime</span>
                  <span>Today</span>
                </div>
                <Behind x={x} />
              </li>
            );
          })}
        </ul>
      )}
      {s && (
        <>
          <Executor v={s.executor} />
          <Indexer v={s.indexer as unknown as IndexerView | { error: string } | null} why={indexerWhy} />
          <Server v={s.system} />
          <Releases v={s.releases} brake={s.brake} />
          <Errors v={s.clientErrors} />
        </>
      )}
    </Page>
  );
}

/** What only the owner sees under a service: the checks that failed, the probe when the public page shows more, the notice. */
function Behind({ x }: { x: JudgedService }) {
  const differs = x.probe !== x.shown && x.probe !== 'unknown';
  if (!x.why.length && !differs && !x.notices.length) return null;
  return (
    <div className="dv-behind">
      {x.notices.map((n) => (
        <p key={n.id}><span className="dv-tag">{n.kind === 'maintenance' ? 'Maintenance' : 'Incident'}</span>{n.title}</p>
      ))}
      {differs && <p><span className="dv-tag">Probe</span>The last check says {STATE_TEXT[x.probe].toLowerCase()}{x.notices.length ? '; the open notice decides what the public page shows.' : '.'}</p>}
      {x.why.map((w) => (
        <p key={w.code}><span className="dv-tag dv-mono">{w.code}</span>{w.text}</p>
      ))}
      {x.checkedAt && <p className="dv-quiet">Checked {ago(x.checkedAt)}</p>}
    </div>
  );
}

function Indexer({ v, why }: { v: IndexerView | { error: string } | null; why: JudgedService['why'] }) {
  if (!v) return <Section title="Indexer"><Empty>No indexer status on this server.</Empty></Section>;
  if (isErr(v)) return <Section title="Indexer"><Note kind="error">{v.error}</Note></Section>;
  const h = v.health;
  if (!h) return <Section title="Indexer"><Empty>The indexer's status row cannot be read.</Empty></Section>;
  const stalled = new Set(why.filter((w) => w.code.startsWith('lane:')).map((w) => w.code.slice(5)));
  const failing = new Set(why.filter((w) => w.code.startsWith('fail:')).map((w) => w.code.slice(5)));
  const lanes = Object.entries(h.lanes);
  return (
    <Section title="Indexer" aside={<span className="st-ms">published {ago(h.at)}{v.stopping ? ' · restarting' : ''}</span>}>
      <dl className="dv-dl">
        <div><dt>Streams</dt><dd className="dv-pills">{Object.entries(h.streams).map(([k, up]) => <Pill key={k} tone={up ? 'pos' : 'neg'}>{k}</Pill>)}{!Object.keys(h.streams).length && '–'}</dd></div>
        <div><dt>Thread lag</dt><dd className={num(h.loopLagMs.lastMinute) !== null && h.loopLagMs.lastMinute! >= 15_000 ? 'dv-warn' : undefined}>{duration(h.loopLagMs.lastMinute)} worst in the last minute · {duration(h.loopLagMs.sinceStart)} since start</dd></div>
        <div><dt>Boards</dt><dd>built {ago(h.lastBuildAt)} in {duration(h.lastBuildMs)}</dd></div>
        {v.lastError && <div><dt>Last error</dt><dd className="dv-warn dv-wrap">{v.lastError}</dd></div>}
      </dl>
      {lanes.length > 0 && (
        <div className="dv-sheet">
          <table className="dv-table">
            <thead><tr><th>Lane</th><th>State</th><th className="right">Queued</th><th className="right">Done</th><th className="right">Failed</th><th className="right">Backoff</th></tr></thead>
            <tbody>
              {lanes.map(([k, l]) => (
                <tr key={k}>
                  <td className="dv-mono">{k}</td>
                  <td>{stalled.has(k) ? <Pill tone="warn">Stalled</Pill> : failing.has(k) ? <Pill tone="neg">Failing</Pill> : <Pill tone="pos">Moving</Pill>}</td>
                  <td className="right">{int(l.queued)}</td>
                  <td className="right">{int(l.done)}</td>
                  <td className="right">{int(l.failed)}</td>
                  <td className="right">{l.backoffMs ? duration(l.backoffMs) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {v.steps.length > 0 && (
        <details className="dv-details">
          <summary>Slowest steps of the last board build</summary>
          <ul className="dv-rows">{v.steps.map(([k, ms]) => <li key={k}><span className="dv-rows__name dv-mono">{k}</span><span className="dv-rows__fig">{duration(ms)}</span></li>)}</ul>
        </details>
      )}
    </Section>
  );
}

function Executor({ v }: { v: EverythingStatus['executor'] }) {
  const h = rec(v.health);
  const brake = rec(h.brake);
  const queue = rec(h.queue);
  return (
    <Section title="Copy & algo executor (server 2)" aside={v.reachable ? <Pill tone={h.ok ? (h.brake ? 'warn' : 'pos') : 'neg'}>{h.ok ? (h.brake ? 'Brake on' : 'Healthy') : 'Not healthy'}</Pill> : <Pill tone="neg">Not reachable</Pill>}>
      {!v.reachable ? (
        <Note kind="error">Not reachable through the site{v.status ? ` (HTTP ${v.status})` : v.error ? ` (${v.error})` : ''} after {int(v.ms ?? null)} ms{v.readAt ? `, read ${ago(v.readAt)}` : ''}. The service row above is the prober's verdict, which counts.</Note>
      ) : (
        <dl className="dv-dl">
          <div><dt>Answered</dt><dd>in {int(v.ms ?? null)} ms{v.readAt ? `, read ${ago(v.readAt)}` : ''} · database {h.db ? 'ok' : 'down'} · SoDEX feed {rec(h.feeds).sodex ? 'up' : 'down'}</dd></div>
          <div><dt>Copies</dt><dd>{int(num(h.copies))} ({int(num(h.active))} active)</dd></div>
          <div><dt>Algos running</dt><dd>{int(num(h.algos))}</dd></div>
          <div><dt>Brake</dt><dd>{h.brake ? <span className="dv-warn">on: {['trading', 'copies', 'algos'].filter((k) => brake[k]).join(', ')}{typeof brake.reason === 'string' ? ` - ${brake.reason}` : ''}</span> : 'off'}</dd></div>
          {Object.keys(queue).length > 0 && (
            <div><dt>Send queue</dt><dd>{int(num(queue.waiting))} waiting · {int(num(queue.inFlight))} in flight · oldest {duration(num(queue.oldestMs))}</dd></div>
          )}
        </dl>
      )}
    </Section>
  );
}

function Server({ v }: { v: EverythingStatus['system'] }) {
  if (isErr(v)) return <Section title="Server 1"><Note kind="error">{v.error}</Note></Section>;
  const used = 1 - v.memory.freeBytes / v.memory.totalBytes;
  const disk = v.disk ? 1 - v.disk.freeBytes / v.disk.totalBytes : null;
  return (
    <Section title={`Server 1 · ${v.host}`} aside={<span className="st-ms">up {duration(v.uptimeS * 1000)}</span>}>
      <dl className="dv-dl">
        <div><dt>Load</dt><dd>{v.load.map((x) => x.toFixed(2)).join(' / ')} on {v.cores} cores</dd></div>
        <div><dt>Memory</dt><dd className={used > 0.9 ? 'dv-warn' : undefined}>{(used * 100).toFixed(0)}% of {bytes(v.memory.totalBytes)} used</dd></div>
        <div><dt>Data disk</dt><dd className={disk !== null && disk > 0.8 ? 'dv-warn' : undefined}>{v.disk ? `${((disk ?? 0) * 100).toFixed(0)}% of ${bytes(v.disk.totalBytes)} used · ${bytes(v.disk.freeBytes)} free` : '–'}</dd></div>
        <div><dt>API process</dt><dd>up {duration(v.api.uptimeS * 1000)} · {bytes(v.api.rssBytes)} memory · Node {v.api.node}</dd></div>
      </dl>
    </Section>
  );
}

function Releases({ v, brake }: { v: EverythingStatus['releases']; brake: EverythingStatus['brake'] }) {
  return (
    <Section title="Releases and brake (server 1)">
      <dl className="dv-dl">
        {isErr(v) ? <div><dt>Releases</dt><dd className="dv-warn">{v.error}</dd></div> : (
          <>
            <div><dt>Running</dt><dd className="dv-mono">{v.current ?? 'not a released server'}</dd></div>
            <div><dt>Before it</dt><dd className="dv-mono">{v.previous ?? '–'}</dd></div>
            <div><dt>Kept</dt><dd className="dv-wrap">{v.installed.slice(0, 6).map((x) => `${x.tag} (${when(x.at)})`).join(' · ') || '–'}</dd></div>
          </>
        )}
        <div><dt>Site brake</dt><dd>{!brake ? 'off' : isErr(brake) ? brake.error : <span className="dv-warn">on: {['trading', 'copies', 'algos'].filter((k) => (brake as Record<string, unknown>)[k]).join(', ')} - {brake.reason}</span>}</dd></div>
      </dl>
    </Section>
  );
}

function Errors({ v }: { v: EverythingStatus['clientErrors'] }) {
  const list = isErr(v) ? [] : v.slice(0, 20);
  return (
    <Section title="Errors browsers reported" aside={!isErr(v) && v.length ? <span className="st-ms">latest {list.length} of {v.length}</span> : undefined}>
      {isErr(v) ? <Note kind="error">{v.error}</Note> : list.length ? (
        <ul className="dv-errs">
          {list.map((e) => (
            <li key={e.fp}>
              <div className="dv-errs__top">
                <b className="dv-wrap">{e.name}: {e.message}</b>
                <span className="st-ms">{int(e.count)}× · {ago(e.lastAt)}</span>
              </div>
              <span className="dv-quiet dv-wrap"><span className="dv-mono">{e.lastRoute}</span> · {e.lastBrowser} · build <span className="dv-mono">{e.lastBuild}</span></span>
            </li>
          ))}
        </ul>
      ) : <Empty>No error reported.</Empty>}
    </Section>
  );
}
