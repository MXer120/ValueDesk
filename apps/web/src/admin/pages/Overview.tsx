/**
 * The first page: is everything running (the public Status page's own verdict), what waits for the owner,
 * and the last days' numbers. One request (POST /api/admin/overview) with only what is shown - it used to
 * be five, ~25 KB, waiting on the slowest - drawn at once from the kept copy (ui.tsx useAdmin).
 */
import { BarChart } from '../BarChart';
import { ago, dayLabel, int, short, usd, usdShort } from '../format';
import { Empty, Figure, Figures, Note, OVERALL_WORDS, Page, Pill, Section, ShownPill, toneOfOverall, useAdmin } from '../ui';
import { accountEarnedMicro, type OverviewAnswer } from '../types';
import { SHOWN_TEXT } from '../../status/statusData';

export function Overview() {
  const r = useAdmin<OverviewAnswer>('overview', {}, 60_000);
  const d = r.data;
  const judged = d?.status?.judged ?? null;
  const exec = d?.status?.executor ?? null;
  const notUp = (judged?.services ?? []).filter((x) => x.shown !== 'up' && x.shown !== 'unknown');
  const b = d?.builder ?? null;
  const acct = d?.account ?? null;
  const v = d?.visitors ?? null;
  const open = d?.tickets.open ?? 0;
  return (
    <Page
      title={judged ? OVERALL_WORDS[judged.overall] : d ? 'Status not readable' : 'Checking…'}
      line={notUp.length ? notUp.map((x) => `${x.name}: ${x.notices[0]?.title ?? x.why[0]?.text ?? SHOWN_TEXT[x.shown]}`).join(' · ') : 'The same verdict as www.valuedesk.so/status, then what waits for you and the last days.'}
      tone={toneOfOverall(judged?.overall)}
      loaded={r}
      wide
    >
      {r.error && <Section><Note kind="error">{r.error}</Note></Section>}
      <Section>
        <Figures>
          <Figure label="Open tickets" value={d ? <a href="#/tickets">{int(open)}</a> : '–'} tone={open ? 'warn' : undefined} sub={d ? `${int(d.tickets.total)} chat${d.tickets.total === 1 ? '' : 's'} in all` : undefined} />
          <Figure label="Builder fees earned" value={acct ? usd(accountEarnedMicro(acct)) : '–'} tone={acct ? 'pos' : undefined} sub={acct ? `above the ${usd(acct.funded * 1e6)} put in` : d ? 'SoDEX did not answer' : undefined} />
          <Figure label="Volume, 7 days" value={b ? usdShort(b.volume.d7) : '–'} sub={b ? `today ${usdShort(b.volume.d1)} · ${int(b.wallets.traded7d)} wallets traded` : undefined} />
          <Figure label="Visitors, 7 days" value={v ? int(v.visitors) : '–'} sub={v ? `${int(v.liveVisits)} on the site now` : d ? 'only who allowed analytics' : undefined} />
        </Figures>
      </Section>
      <div className="dv-split2">
        <Section title="Services" aside={<a className="st-link dv-more" href="#/status">Status</a>}>
          <ul className="dv-rows">
            {(judged?.services ?? []).map((x) => (
              <li key={x.id}>
                <span className="dv-rows__name">{x.name}</span>
                <span className="st-ms">{x.latencyMs === null || x.probe === 'unknown' ? '' : `${int(x.latencyMs)} ms`}</span>
                <ShownPill state={x.shown} />
              </li>
            ))}
            <li>
              <span className="dv-rows__name">Executor health</span>
              <span className="st-ms">{exec?.reachable ? `${int(exec.copies)} copies · ${int(exec.algos)} algos` : ''}</span>
              {!exec ? <Pill tone="dim">Checking</Pill> : !exec.reachable ? <Pill tone="neg">Not reachable</Pill> : !exec.ok ? <Pill tone="warn">Not healthy</Pill> : exec.brake ? <Pill tone="warn">Brake on</Pill> : <Pill tone="pos">Healthy</Pill>}
            </li>
          </ul>
          {!judged && d && <Empty>The status record could not be read on this server.</Empty>}
        </Section>
        <Section title="Waiting for an answer" aside={<a className="st-link dv-more" href="#/tickets">Tickets</a>}>
          {d && d.tickets.latest.length ? (
            <ul className="dv-rows">
              {d.tickets.latest.map((t) => (
                <li key={t.id}>
                  <a className="dv-rows__name dv-rows__link" href={`#/tickets/${t.id}`}>#{t.id} {t.lastText}</a>
                  <span className="st-ms">{ago(t.lastAt)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>{!d ? 'Loading…' : d.tickets.total ? 'Every chat is answered.' : 'No visitor has written yet.'}</Empty>}
        </Section>
      </div>
      <Section title="Volume and builder fees, 14 days" aside={<a className="st-link dv-more" href="#/revenue">Volume & fees</a>}>
        {b ? (
          <div className="dv-charts">
            <BarChart title="Volume" bars={b.days.map((x) => ({ key: x.day, label: dayLabel(x.day), value: x.volume }))} fmt={usd} fmtAxis={usdShort} />
            <BarChart title="Fees" bars={b.days.map((x) => ({ key: x.day, label: dayLabel(x.day), value: x.fees }))} fmt={usd} fmtAxis={usdShort} />
          </div>
        ) : <Empty>{!d ? 'Loading…' : 'The builder ledger is off on this server.'}</Empty>}
      </Section>
      <div className="dv-split2">
        <Section title="Top wallets, 30 days" aside={<a className="st-link dv-more" href="#/users">Users</a>}>
          {d && d.top.length ? (
            <ul className="dv-rows">
              {d.top.map((u) => (
                <li key={u.address}>
                  <span className="dv-rows__name dv-mono" title={u.address}>{short(u.address)}</span>
                  <span className="st-ms">{usd(u.fees)} fees</span>
                  <span className="dv-rows__fig">{usdShort(u.volume30d)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>{!d ? 'Loading…' : 'No wallet traded through the builder in 30 days.'}</Empty>}
        </Section>
        <Section title="Beta access" aside={<a className="st-link dv-more" href="#/access">Access</a>}>
          <ul className="dv-rows">
            <li>
              <span className="dv-rows__name">Wallets with real bots and every algo order</span>
              <span className="dv-rows__fig">{d ? int(d.beta) : '–'}</span>
            </li>
          </ul>
          {d && !d.beta && <Empty>Nobody yet. Add the wallet you trade with on Access.</Empty>}
        </Section>
      </div>
    </Page>
  );
}
