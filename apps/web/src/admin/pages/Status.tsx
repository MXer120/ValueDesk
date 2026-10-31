/** The status of everything (admin/statusView.ts): read from what the servers already publish. */
import { ago, bytes, duration, int, when } from '../format';
import { Badge, JsonView, Note, PageHead, Panel, Tile, useAdmin } from '../ui';
import type { EverythingStatus } from '../types';

const isErr = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in v && typeof (v as { error: unknown }).error === 'string';
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const STATE_TONE = { up: 'pos', degraded: 'warn', down: 'neg', unknown: 'dim' } as const;

export function Status() {
  const r = useAdmin<{ status: EverythingStatus | null }>('status', {}, 30_000);
  const s = r.data?.status ?? null;
  return (
    <>
      <PageHead title="Status" line="Servers, indexer, executor, brake, releases and errors from browsers - read from what the servers publish, every 30 s." loaded={r} />
      {r.error && <Note kind="error">{r.error}</Note>}
      {s && (
        <>
          <Services s={s} />
          <div className="ad-grid2">
            <Indexer v={s.indexer} />
            <Executor v={s.executor} />
          </div>
          <div className="ad-grid2">
            <Server v={s.system} />
            <Releases v={s.releases} brake={s.brake} />
          </div>
          <Errors v={s.clientErrors} />
        </>
      )}
    </>
  );
}

function Services({ s }: { s: EverythingStatus }) {
  if (isErr(s.report)) return <Note kind="error">Status page: {s.report.error}</Note>;
  const services = s.report.services ?? [];
  const notices = (s.report.notices ?? []).filter((n) => !n.closedAt);
  return (
    <>
      <div className="ad-tiles">
        {services.map((x) => (
          <Tile key={x.id} label={x.name} value={<Badge tone={STATE_TONE[x.state]}>{x.state}</Badge>} sub={`${x.uptime === null ? '–' : `${x.uptime}%`} 90 d · ${x.latencyMs === null ? '–' : `${int(x.latencyMs)} ms`} · ${ago(x.checkedAt)}`} />
        ))}
      </div>
      {notices.map((n) => (
        <Note key={n.id} kind={n.kind === 'incident' ? 'warn' : 'info'}>
          {n.kind === 'incident' ? 'Incident' : 'Maintenance'} #{n.id}: {n.title} · {n.updates.at(-1)?.stage} {n.updates.at(-1)?.text ? `- ${n.updates.at(-1)!.text}` : ''} ({ago(n.updates.at(-1)?.at)})
        </Note>
      ))}
    </>
  );
}

function Indexer({ v }: { v: Record<string, unknown> | null }) {
  if (!v) return <Panel title="Indexer"><p className="ad-dim">No indexer status on this server.</p></Panel>;
  if (isErr(v)) return <Panel title="Indexer"><Note kind="error">{v.error}</Note></Panel>;
  const lag = rec(v.loopLagMs);
  const steps = Object.entries(rec(v.lastBuildStepMs)).map(([k, ms]) => [k, num(ms)] as const).filter(([, ms]) => ms !== null).sort((a, b) => b[1]! - a[1]!);
  const sockets = rec(v.sockets ?? v.streams);
  const lanes = rec(v.lanes);
  return (
    <Panel title="Indexer">
      <dl className="ad-dl">
        <div><dt>Status written</dt><dd>{ago(num(v.at))}</dd></div>
        <div><dt>Last board build</dt><dd>{ago(num(v.lastBuildAt))} · took {duration(num(v.lastBuildMs))}</dd></div>
        <div><dt>Event loop lag</dt><dd>{int(num(lag.lastMinute))} ms last minute · {int(num(lag.sinceStart))} ms worst</dd></div>
        <div><dt>Streams</dt><dd>{Object.entries(sockets).map(([k, up]) => <Badge key={k} tone={up ? 'pos' : 'neg'}>{k}</Badge>)}</dd></div>
        {typeof v.lastError === 'string' && <div><dt>Last error</dt><dd className="ad-warn">{v.lastError}</dd></div>}
      </dl>
      {steps.length > 0 && (
        <table className="ad-table ad-table--compact">
          <thead><tr><th>Build step</th><th className="num">Last build</th></tr></thead>
          <tbody>{steps.slice(0, 12).map(([k, ms]) => <tr key={k}><td className="ad-mono">{k}</td><td className="num">{duration(ms)}</td></tr>)}</tbody>
        </table>
      )}
      {Object.keys(lanes).length > 0 && (
        <table className="ad-table ad-table--compact">
          <thead><tr><th>Lane</th><th className="num">Queued</th><th className="num">Done</th><th className="num">Failed</th></tr></thead>
          <tbody>{Object.entries(lanes).map(([k, l]) => <tr key={k}><td className="ad-mono">{k}</td><td className="num">{int(num(rec(l).queued))}</td><td className="num">{int(num(rec(l).done))}</td><td className="num">{int(num(rec(l).failed))}</td></tr>)}</tbody>
        </table>
      )}
      <details><summary>Whole status row</summary><JsonView value={v} /></details>
    </Panel>
  );
}

function Executor({ v }: { v: EverythingStatus['executor'] }) {
  const h = rec(v.health);
  const brake = rec(h.brake);
  const queue = rec(h.queue);
  return (
    <Panel title="Copy & algo executor (server 2)">
      {!v.reachable ? (
        <Note kind="error">Not reachable{v.status ? ` (HTTP ${v.status})` : v.error ? ` (${v.error})` : ''} after {int(v.ms ?? null)} ms.</Note>
      ) : (
        <dl className="ad-dl">
          <div><dt>Health</dt><dd><Badge tone={h.ok ? 'pos' : 'neg'}>{h.ok ? 'ok' : 'not ok'}</Badge> {int(v.ms ?? null)} ms</dd></div>
          <div><dt>Database</dt><dd>{h.db ? 'ok' : 'down'}</dd></div>
          <div><dt>Copies</dt><dd>{int(num(h.copies))} ({int(num(h.active))} active)</dd></div>
          <div><dt>Algo orders running</dt><dd>{int(num(h.algos))}</dd></div>
          <div><dt>SoDEX feed</dt><dd>{rec(h.feeds).sodex ? 'up' : 'down'}</dd></div>
          <div><dt>Brake</dt><dd>{h.brake ? <span className="ad-warn">on: {['trading', 'copies', 'algos'].filter((k) => brake[k]).join(', ')}{typeof brake.reason === 'string' ? ` - ${brake.reason}` : ''}</span> : 'off'}</dd></div>
          {Object.keys(queue).length > 0 && (
            <div>
              <dt>Send queue</dt>
              <dd>
                {int(num(queue.waiting))} waiting · {int(num(queue.inFlight))} in flight · oldest {duration(num(queue.oldestMs))} · cooldown {duration(num(queue.cooldownMs))} · {int(num(queue.sent))} sent · {int(num(queue.resent))} resent
                {Object.values(rec(queue.byClass)).some((n) => num(n)) && <span className="ad-dim"> ({Object.entries(rec(queue.byClass)).filter(([, n]) => num(n)).map(([k, n]) => `${k} ${int(num(n))}`).join(', ')})</span>}
              </dd>
            </div>
          )}
        </dl>
      )}
    </Panel>
  );
}

function Server({ v }: { v: EverythingStatus['system'] }) {
  if (isErr(v)) return <Panel title="Server 1"><Note kind="error">{v.error}</Note></Panel>;
  const used = 1 - v.memory.freeBytes / v.memory.totalBytes;
  const disk = v.disk ? 1 - v.disk.freeBytes / v.disk.totalBytes : null;
  return (
    <Panel title={`Server 1 (${v.host})`}>
      <dl className="ad-dl">
        <div><dt>Load</dt><dd>{v.load.map((x) => x.toFixed(2)).join(' / ')} on {v.cores} cores</dd></div>
        <div><dt>Memory</dt><dd className={used > 0.9 ? 'ad-warn' : undefined}>{(used * 100).toFixed(0)}% of {bytes(v.memory.totalBytes)}</dd></div>
        <div><dt>Data disk</dt><dd className={disk !== null && disk > 0.8 ? 'ad-warn' : undefined}>{v.disk ? `${((disk ?? 0) * 100).toFixed(0)}% of ${bytes(v.disk.totalBytes)} (${bytes(v.disk.freeBytes)} free)` : '–'}</dd></div>
        <div><dt>Up</dt><dd>{duration(v.uptimeS * 1000)}</dd></div>
        <div><dt>API process</dt><dd>pid {v.api.pid} · up {duration(v.api.uptimeS * 1000)} · {bytes(v.api.rssBytes)} RSS · Node {v.api.node}</dd></div>
      </dl>
    </Panel>
  );
}

function Releases({ v, brake }: { v: EverythingStatus['releases']; brake: EverythingStatus['brake'] }) {
  return (
    <Panel title="Releases and brake (server 1)">
      {isErr(v) ? <Note kind="error">{v.error}</Note> : (
        <dl className="ad-dl">
          <div><dt>Current</dt><dd className="ad-mono">{v.current ?? 'not a released server'}</dd></div>
          <div><dt>Previous</dt><dd className="ad-mono">{v.previous ?? '–'}</dd></div>
          <div><dt>Installed</dt><dd>{v.installed.map((x) => `${x.tag} (${when(x.at)})`).join(', ') || '–'}</dd></div>
        </dl>
      )}
      <dl className="ad-dl">
        <div><dt>Site brake</dt><dd>{!brake ? 'off' : isErr(brake) ? brake.error : <span className="ad-warn">on: {['trading', 'copies', 'algos'].filter((k) => (brake as Record<string, unknown>)[k]).join(', ')} - {brake.reason}</span>}</dd></div>
      </dl>
    </Panel>
  );
}

function Errors({ v }: { v: EverythingStatus['clientErrors'] }) {
  return (
    <Panel title="Errors browsers reported (newest first)">
      {isErr(v) ? <Note kind="error">{v.error}</Note> : (
        <div className="ad-tablewrap">
          <table className="ad-table ad-table--compact">
            <thead><tr><th>Last</th><th>Error</th><th>Route</th><th>Browser</th><th>Build</th><th className="num">Count</th></tr></thead>
            <tbody>
              {v.map((e) => <tr key={e.fp}><td>{ago(e.lastAt)}</td><td>{e.name}: {e.message}</td><td className="ad-mono">{e.lastRoute}</td><td>{e.lastBrowser}</td><td className="ad-mono">{e.lastBuild}</td><td className="num">{int(e.count)}</td></tr>)}
              {!v.length && <tr><td colSpan={6} className="ad-dim">None.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
