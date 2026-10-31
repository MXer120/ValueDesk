/** The first page: what needs the owner now, and today's numbers. */
import { ago, int, usd, usdShort } from '../format';
import { Badge, Note, PageHead, Tile, useAdmin } from '../ui';
import type { AnalyticsSummary, BuilderOverview, EverythingStatus, TicketRow } from '../types';

export function Overview() {
  const tickets = useAdmin<{ tickets: TicketRow[] }>('tickets', {}, 60_000);
  const builder = useAdmin<{ builder: BuilderOverview | null }>('builder', { days: 7 }, 120_000);
  const analytics = useAdmin<{ analytics: AnalyticsSummary | null }>('analytics', { days: 1 }, 60_000);
  const status = useAdmin<{ status: EverythingStatus | null }>('status', {}, 60_000);
  const open = (tickets.data?.tickets ?? []).filter((t) => t.status === 'open');
  const b = builder.data?.builder;
  const a = analytics.data?.analytics?.totals;
  const s = status.data?.status;
  const services = s && !('error' in s.report) ? s.report.services ?? [] : [];
  const notUp = services.filter((x) => x.state !== 'up');
  const exec = s?.executor;
  const errors = [tickets.error, builder.error, analytics.error, status.error].filter(Boolean);
  return (
    <>
      <PageHead title="Overview" />
      {errors.map((e) => <Note key={e} kind="error">{e}</Note>)}
      <div className="ad-tiles">
        <Tile label="Open tickets" value={<a href="#/tickets">{int(open.length)}</a>} tone={open.length ? 'warn' : undefined} sub={open[0] ? `newest ${ago(open[0].lastAt)}` : 'nothing waiting for you'} />
        <Tile label="Fees today (UTC)" value={b ? usd(b.fees.d1) : '–'} sub={b ? `7 d ${usd(b.fees.d7)}` : undefined} />
        <Tile label="Volume today (UTC)" value={b ? usdShort(b.volume.d1) : '–'} sub={b ? `7 d ${usdShort(b.volume.d7)}` : undefined} />
        <Tile label="Visitors today" value={a ? int(a.visitors) : '–'} sub={a ? `${int(a.liveVisits)} on the site now` : undefined} />
        <Tile label="Services" value={services.length ? (notUp.length ? <Badge tone="neg">{notUp.length} not up</Badge> : <Badge tone="pos">all up</Badge>) : '–'} sub={notUp.map((x) => `${x.name}: ${x.state}`).join(' · ') || undefined} />
        <Tile label="Executor" value={exec ? (exec.reachable && exec.health?.ok ? <Badge tone="pos">ok</Badge> : <Badge tone="neg">not ok</Badge>) : '–'} sub={exec?.health ? `${int(exec.health.copies as number)} copies · ${int(exec.health.algos as number)} algos${exec.health.brake ? ' · BRAKE ON' : ''}` : undefined} />
      </div>
      {open.length > 0 && (
        <ul className="ad-ticketlist ad-ticketlist--flat">
          {open.slice(0, 8).map((t) => (
            <li key={t.id}><a href={`#/tickets/${t.id}`}><span className="ad-mono">#{t.id}</span> <span className="ad-dim">{t.category} · {ago(t.lastAt)}</span><div className="ad-ticketlist__text">{t.lastText}</div></a></li>
          ))}
        </ul>
      )}
    </>
  );
}
