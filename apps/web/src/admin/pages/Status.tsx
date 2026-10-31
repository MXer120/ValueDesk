/**
 * The status of everything (admin/statusView.ts), read from what the servers already
 * publish. The services are the public Status page's own rows - its pills, its 90 day
 * bars with their tooltips (status/StatusPage.tsx DayBars) - then what only the owner
 * sees: the indexer's whole status, the executor's health, server 1, releases, brake,
 * browser errors.
 */
import { DayBars } from '../../status/StatusPage';
import { SERVICE_LINE, dayDetail, fmtUptime } from '../../status/statusData';
import { ago, bytes, duration, int, when } from '../format';
import { Empty, JsonView, Note, Page, Pill, Section, useAdmin } from '../ui';
import type { EverythingStatus } from '../types';

const isErr = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in v && typeof (v as { error: unknown }).error === 'string';
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const STATE_TONE = { up: 'pos', degraded: 'warn', down: 'neg', unknown: 'dim' } as const;
const STATE_WORD = { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'No data' } as const;

export function Status() {
  const r = useAdmin<{ status: EverythingStatus | null }>('status', {}, 30_000);
  const s = r.data?.status ?? null;
  const services = s && s.report && !isErr(s.report) ? s.report.services ?? [] : [];
  const bad = services.filter((x) => x.state === 'down' || x.state === 'degraded');
  const execOk = !!s?.executor.reachable && !!s.executor.health?.ok;
  const tone = !s ? 'unknown' : bad.some((x) => x.state === 'down') || !execOk ? 'down' : bad.length ? 'warn' : 'pos';
  return (
    <Page
      title={!s ? 'Checking…' : tone === 'pos' ? 'All systems operational' : tone === 'warn' ? 'Partly degraded' : 'Something is down'}
      line="Servers, indexer, executor, brake, releases and errors from browsers - read from what the servers publish, every 30 s."
      tone={tone}
      loaded={r}
    >
      {r.error && <Section><Note kind="error">{r.error}</Note></Section>}
      {s && (
        <>
          {isErr(s.report) ? <Section><Note kind="error">Status page: {s.report.error}</Note></Section> : (
            <ul className="st-list" aria-label="Services">
              {services.map((x) => {
                // The same report the public page reads (ops/statusModel.ts StatusReport), so its own helpers apply.
                const notices = (s.report && !isErr(s.report) ? s.report.notices ?? [] : []) as unknown as Parameters<typeof dayDetail>[2];
                const days = (x.days ?? []).map((d) => dayDetail(d, x.id as Parameters<typeof dayDetail>[1], notices, s.at));
                return (
                  <li key={x.id} className="st-svc">
                    <div className="st-svc__head">
                      <div className="st-svc__name">
                        <b>{x.name}</b>
                        <small>{SERVICE_LINE[x.id as keyof typeof SERVICE_LINE] ?? ''}</small>
                      </div>
                      <div className="st-svc__now">
                        <Pill tone={STATE_TONE[x.state]}>{STATE_WORD[x.state]}</Pill>
                        {x.latencyMs !== null && x.state !== 'unknown' && <small className="st-ms">{x.latencyMs} ms</small>}
                      </div>
                    </div>
                    {days.length > 0 && <DayBars days={days} label={`${x.name}: ${fmtUptime(x.uptime)} uptime over the last ${days.length} days`} />}
                    <div className="st-scale" aria-hidden="true">
                      <span>{days.length} days ago</span>
                      <span className="st-scale__pct">{fmtUptime(x.uptime)} uptime</span>
                      <span>Today</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Executor v={s.executor} />
          <Indexer v={s.indexer} />
          <Server v={s.system} />
          <Releases v={s.releases} brake={s.brake} />
          <Errors v={s.clientErrors} />
        </>
      )}
    </Page>
  );
}

function Indexer({ v }: { v: Record<string, unknown> | null }) {
  if (!v) return <Section title="Indexer"><Empty>No indexer status on this server.</Empty></Section>;
  if (isErr(v)) return <Section title="Indexer"><Note kind="error">{v.error}</Note></Section>;
  const lag = rec(v.loopLagMs);
  const steps = Object.entries(rec(v.lastBuildStepMs)).map(([k, ms]) => [k, num(ms)] as const).filter(([, ms]) => ms !== null).sort((a, b) => b[1]! - a[1]!);
  const sockets = rec(v.sockets ?? v.streams);
  const lanes = rec(v.lanes);
  return (
    <Section title="Indexer" aside={<span className="st-ms">status written {ago(num(v.at))}</span>}>
      <dl className="dv-dl">
        <div><dt>Last board build</dt><dd>{ago(num(v.lastBuildAt))} · took {duration(num(v.lastBuildMs))}</dd></div>
        <div><dt>Event loop lag</dt><dd>{int(num(lag.lastMinute))} ms in the last minute · {int(num(lag.sinceStart))} ms worst since start</dd></div>
        <div><dt>Streams</dt><dd>{Object.entries(sockets).map(([k, up]) => <Pill key={k} tone={up ? 'pos' : 'neg'}>{k}</Pill>)}</dd></div>
        {typeof v.lastError === 'string' && <div><dt>Last error</dt><dd className="dv-warn">{v.lastError}</dd></div>}
      </dl>
      <div className="dv-grid dv-grid--2">
        {steps.length > 0 && (
          <div className="dv-sheet">
            <table className="dv-table">
              <thead><tr><th>Build step</th><th className="right">Last build</th></tr></thead>
              <tbody>{steps.slice(0, 12).map(([k, ms]) => <tr key={k}><td className="dv-mono">{k}</td><td className="right">{duration(ms)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {Object.keys(lanes).length > 0 && (
          <div className="dv-sheet">
            <table className="dv-table">
              <thead><tr><th>Lane</th><th className="right">Queued</th><th className="right">Done</th><th className="right">Failed</th></tr></thead>
              <tbody>{Object.entries(lanes).map(([k, l]) => <tr key={k}><td className="dv-mono">{k}</td><td className="right">{int(num(rec(l).queued))}</td><td className="right">{int(num(rec(l).done))}</td><td className="right">{int(num(rec(l).failed))}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
      <details className="dv-details"><summary>The whole status row</summary><JsonView value={v} /></details>
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
        <Note kind="error">Not reachable{v.status ? ` (HTTP ${v.status})` : v.error ? ` (${v.error})` : ''} after {int(v.ms ?? null)} ms.</Note>
      ) : (
        <dl className="dv-dl">
          <div><dt>Answered in</dt><dd>{int(v.ms ?? null)} ms · database {h.db ? 'ok' : 'down'} · SoDEX feed {rec(h.feeds).sodex ? 'up' : 'down'}</dd></div>
          <div><dt>Copies</dt><dd>{int(num(h.copies))} ({int(num(h.active))} active)</dd></div>
          <div><dt>Algo orders running</dt><dd>{int(num(h.algos))}</dd></div>
          <div><dt>Brake</dt><dd>{h.brake ? <span className="dv-warn">on: {['trading', 'copies', 'algos'].filter((k) => brake[k]).join(', ')}{typeof brake.reason === 'string' ? ` - ${brake.reason}` : ''}</span> : 'off'}</dd></div>
          {Object.keys(queue).length > 0 && (
            <div>
              <dt>Send queue</dt>
              <dd>
                {int(num(queue.waiting))} waiting · {int(num(queue.inFlight))} in flight · oldest {duration(num(queue.oldestMs))} · cooldown {duration(num(queue.cooldownMs))} · {int(num(queue.sent))} sent · {int(num(queue.resent))} resent
              </dd>
            </div>
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
            <div><dt>Kept</dt><dd>{v.installed.map((x) => `${x.tag} (${when(x.at)})`).join(' · ') || '–'}</dd></div>
          </>
        )}
        <div><dt>Site brake</dt><dd>{!brake ? 'off' : isErr(brake) ? brake.error : <span className="dv-warn">on: {['trading', 'copies', 'algos'].filter((k) => (brake as Record<string, unknown>)[k]).join(', ')} - {brake.reason}</span>}</dd></div>
      </dl>
    </Section>
  );
}

function Errors({ v }: { v: EverythingStatus['clientErrors'] }) {
  return (
    <Section title="Errors browsers reported" flush>
      {isErr(v) ? <Note kind="error">{v.error}</Note> : (
        <div className="dv-sheet">
          <table className="dv-table">
            <thead><tr><th>Last</th><th>Error</th><th>Page</th><th>Browser</th><th>Build</th><th className="right">Count</th></tr></thead>
            <tbody>{v.map((e) => <tr key={e.fp}><td>{ago(e.lastAt)}</td><td>{e.name}: {e.message}</td><td className="dv-mono">{e.lastRoute}</td><td>{e.lastBrowser}</td><td className="dv-mono">{e.lastBuild}</td><td className="right">{int(e.count)}</td></tr>)}</tbody>
          </table>
          {!v.length && <div className="dv-sheet__none"><Empty>No error reported.</Empty></div>}
        </div>
      )}
    </Section>
  );
}
