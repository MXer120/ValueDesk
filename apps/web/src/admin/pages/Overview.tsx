/** The first page: whether everything runs, the last week's numbers, what needs the owner. */
import { BarChart } from '../BarChart';
import { ago, dayLabel, int, usd, usdShort, short } from '../format';
import { Empty, Figure, Figures, Note, Page, Pill, Section, useAdmin } from '../ui';
import type { AnalyticsSummary, BuilderOverview, EverythingStatus, TicketRow, UserRow } from '../types';

const STATE_TONE = { up: 'pos', degraded: 'warn', down: 'neg', unknown: 'dim' } as const;
const STATE_WORD = { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'No data' } as const;

export function Overview() {
  const tickets = useAdmin<{ tickets: TicketRow[] }>('tickets', {}, 60_000);
  const builder = useAdmin<{ builder: BuilderOverview | null }>('builder', { days: 30 }, 120_000);
  const analytics = useAdmin<{ analytics: AnalyticsSummary | null }>('analytics', { days: 7 }, 60_000);
  const status = useAdmin<{ status: EverythingStatus | null }>('status', {}, 60_000);
  const users = useAdmin<{ users: UserRow[] }>('users', {}, 120_000);

  const all = tickets.data?.tickets ?? [];
  const open = all.filter((t) => t.status === 'open');
  const b = builder.data?.builder;
  const a = analytics.data?.analytics?.totals;
  const s = status.data?.status;
  const services = s && s.report && !('error' in s.report) ? s.report.services ?? [] : [];
  const notUp = services.filter((x) => x.state !== 'up' && x.state !== 'unknown');
  const exec = s?.executor;
  const execOk = !!exec?.reachable && !!exec.health?.ok;
  const brake = !!exec?.health?.brake;
  const errors = [tickets.error, builder.error, analytics.error, status.error, users.error].filter(Boolean) as string[];
  const tone = !s ? 'unknown' : notUp.some((x) => x.state === 'down') || !execOk ? 'down' : notUp.length || brake ? 'warn' : 'pos';
  const title = !s ? 'Checking…' : tone === 'pos' ? 'Everything runs' : tone === 'warn' ? `${notUp.length + (brake ? 1 : 0)} thing${notUp.length + (brake ? 1 : 0) === 1 ? '' : 's'} to look at` : 'Something is down';
  const top = (users.data?.users ?? []).filter((u) => u.builder && u.builder.volume30d > 0).sort((x, y) => y.builder!.volume30d - x.builder!.volume30d).slice(0, 5);
  const reload = () => [tickets, builder, analytics, status, users].forEach((l) => l.reload());
  const loadedAt = Math.min(...[tickets, builder, analytics, status, users].map((l) => l.at ?? Infinity));

  return (
    <Page
      title={title}
      line={notUp.length ? notUp.map((x) => `${x.name}: ${STATE_WORD[x.state]}`).join(' · ') : 'ValueDesk at a glance: the last 7 days, and what is waiting for you.'}
      tone={tone}
      loaded={{ loading: [tickets, builder, analytics, status, users].some((l) => l.loading), at: Number.isFinite(loadedAt) ? loadedAt : null, reload }}
      wide
    >
      {errors.length > 0 && <Section>{errors.map((e) => <Note key={e} kind="error">{e}</Note>)}</Section>}
      <Section>
        <Figures>
          <Figure label="Builder fees, 7 days" value={b ? usd(b.fees.d7) : '–'} sub={b ? `today ${usd(b.fees.d1)} · all time ${usd(b.fees.lifetime.perps + b.fees.lifetime.spot)}` : undefined} />
          <Figure label="Volume, 7 days" value={b ? usdShort(b.volume.d7) : '–'} sub={b ? `today ${usdShort(b.volume.d1)} · all time ${usdShort(b.volume.lifetime.perps + b.volume.lifetime.spot)}` : undefined} />
          <Figure label="Trading wallets, 7 days" value={b ? int(b.wallets.traded7d) : '–'} sub={b ? `${int(b.wallets.total)} on the builder ledger` : undefined} />
          <Figure label="Open tickets" value={<a href="#/tickets">{int(open.length)}</a>} tone={open.length ? 'warn' : undefined} sub={all.length ? `${int(all.length)} chat${all.length === 1 ? '' : 's'} in all` : 'no chat yet'} />
        </Figures>
      </Section>
      <Section title="Volume and builder fees per day" aside={<a className="st-link ad-more" href="#/revenue">Volume & fees</a>}>
        {b ? (
          <div className="ad-charts">
            <BarChart title="Volume" bars={b.days.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.perps + d.spot }))} fmt={usd} fmtAxis={usdShort} />
            <BarChart title="Fees" bars={b.days.map((d) => ({ key: d.day, label: dayLabel(d.day), value: d.feePerps + d.feeSpot }))} fmt={usd} fmtAxis={usdShort} />
          </div>
        ) : <Empty>{builder.loading ? 'Loading…' : 'The builder ledger is off on this server.'}</Empty>}
      </Section>
      <Section title="Services" aside={<a className="st-link ad-more" href="#/status">Status</a>}>
        <ul className="ad-rows">
          {services.map((x) => (
            <li key={x.id}>
              <span className="ad-rows__name">{x.name}</span>
              <span className="st-ms">{x.latencyMs === null ? '' : `${int(x.latencyMs)} ms`}</span>
              <Pill tone={STATE_TONE[x.state]}>{STATE_WORD[x.state]}</Pill>
            </li>
          ))}
          <li>
            <span className="ad-rows__name">Executor health (server 2)</span>
            <span className="st-ms">{exec?.health ? `${int(exec.health.copies as number)} copies · ${int(exec.health.algos as number)} algos` : ''}</span>
            {exec ? <Pill tone={execOk ? (brake ? 'warn' : 'pos') : 'neg'}>{!execOk ? 'Not reachable' : brake ? 'Brake on' : 'Healthy'}</Pill> : <Pill tone="dim">Checking</Pill>}
          </li>
        </ul>
      </Section>
      <div className="ad-split2">
        <Section title="Top wallets, 30 days" aside={<a className="st-link ad-more" href="#/users">Users</a>}>
          {top.length ? (
            <ul className="ad-rows">
              {top.map((u) => (
                <li key={u.address}>
                  <span className="ad-rows__name ad-mono" title={u.address}>{short(u.address)}</span>
                  <span className="st-ms">{usd(u.builder!.fees.perps + u.builder!.fees.spot)} fees</span>
                  <span className="ad-rows__fig">{usdShort(u.builder!.volume30d)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>{users.loading ? 'Loading…' : 'No wallet traded through ValueDesk\'s builder in the last 30 days.'}</Empty>}
        </Section>
        <Section title="Waiting for an answer" aside={<a className="st-link ad-more" href="#/tickets">Tickets</a>}>
          {open.length ? (
            <ul className="ad-rows">
              {open.slice(0, 5).map((t) => (
                <li key={t.id}>
                  <a className="ad-rows__name ad-rows__link" href={`#/tickets/${t.id}`}>#{t.id} {t.lastText}</a>
                  <span className="st-ms">{ago(t.lastAt)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>{tickets.loading ? 'Loading…' : all.length ? 'Every chat is answered.' : 'No visitor has written yet. Messages sent with "Send feedback" land here and in Telegram.'}</Empty>}
        </Section>
      </div>
      <Section title="Visitors, 7 days" aside={<a className="st-link ad-more" href="#/analytics">Analytics</a>}>
        {a && a.visits ? (
          <Figures>
            <Figure label="Visitors" value={int(a.visitors)} sub={`${int(a.newVisitors)} new`} />
            <Figure label="Visits" value={int(a.visits)} sub={`${a.pagesPerVisit === null ? '–' : a.pagesPerVisit.toFixed(1)} pages each`} />
            <Figure label="Connected wallets" value={int(a.wallets)} />
            <Figure label="On the site now" value={int(a.liveVisits)} sub="active in the last 5 min" />
          </Figures>
        ) : <Empty>{analytics.loading ? 'Loading…' : 'No visits counted yet. Only visitors who allow analytics are counted - with "Accept all" or the prompt the site shows visitors who accepted the terms before analytics existed.'}</Empty>}
      </Section>
    </Page>
  );
}
