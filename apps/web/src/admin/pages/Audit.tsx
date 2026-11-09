/** The admin audit log (admin/store.ts, hash-chained) and the open sessions. Signing everyone out is in the navbar's menu. */
import { ago, duration, short, when } from '../format';
import { Empty, Note, Page, Pill, Section, useAdmin } from '../ui';
import type { AuditRow, OpenSession } from '../types';

const KIND: Record<string, string> = {
  signin: 'Signed in',
  'signin.password': 'Wrong password',
  'signin.signature': 'Sign-in refused',
  signout: 'Signed out',
  'sessions.revoke': 'Signed everyone out',
  'password.set': 'Password set',
  'password.off': 'Suite turned off',
  'ticket.reply': 'Answered a ticket',
  'ticket.status': 'Changed a ticket\'s status',
  'page.error': 'The page hit an error',
  'beta.add': 'Gave beta access',
  'beta.remove': 'Took beta access',
  'board.add': 'Planned a card',
  'board.move': 'Moved a card',
};

/** A row's detail in words: the wallet or ticket it was about first, the rest after. */
function detailOf(d: Record<string, unknown> | null): string {
  if (!d) return '';
  return Object.entries(d)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) ? short(v) : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

export function Audit() {
  const audit = useAdmin<{ rows: AuditRow[]; chain: { rows: number; brokenAt: number | null } }>('audit');
  const me = useAdmin<{ wallet: string; expiresAt: number; sessions: OpenSession[] }>('me');
  const chain = audit.data?.chain;
  const refused = (audit.data?.rows ?? []).filter((r) => !r.ok && Date.now() - r.at < 86_400_000).length;
  return (
    <Page
      title={!chain ? 'Audit log' : chain.brokenAt === null ? `Audit log intact · ${chain.rows} entries` : `Audit log broken at entry ${chain.brokenAt}`}
      line="Every sign-in, refusal and change, each entry chained to the one before it - an entry changed or removed later shows here. And the sessions open now."
      tone={!chain ? 'unknown' : chain.brokenAt !== null ? 'down' : refused ? 'warn' : 'pos'}
      loaded={audit}
      wide
    >
      {audit.error && <Section><Note kind="error">{audit.error}</Note></Section>}
      {me.error && !audit.error && <Section><Note kind="error">Open sessions: {me.error}</Note></Section>}
      <Section title="Open sessions" aside={<span className="st-ms">each ends 24 h after its sign-in</span>}>
        <ul className="dv-rows">
          {(me.data?.sessions ?? []).map((s) => (
            <li key={s.id}>
              <span className="dv-rows__name"><span className="dv-mono">{short(s.wallet)}</span>{me.data?.expiresAt === s.expiresAt && <span className="dv-tag is-on">This one</span>}</span>
              <span className="st-ms">{s.country ?? 'country unknown'} · since {ago(s.createdAt)}</span>
              <span className="dv-rows__fig" title={when(s.expiresAt)}>ends in {duration(s.expiresAt - Date.now())}</span>
            </li>
          ))}
        </ul>
        {me.data && !me.data.sessions.length && <Empty>No open session.</Empty>}
      </Section>
      <Section title="Log" aside={refused ? <Pill tone="warn">{refused} refused in 24 h</Pill> : undefined} flush>
        <div className="dv-sheet">
          <table className="dv-table">
            <thead><tr><th>When</th><th>What</th><th>Result</th><th>Wallet</th><th>Country</th><th>Detail</th></tr></thead>
            <tbody>
              {(audit.data?.rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td title={when(r.at)}>{ago(r.at)}</td>
                  <td>{KIND[r.kind] ?? r.kind}</td>
                  <td>{r.ok ? <Pill tone="pos">Done</Pill> : <Pill tone="neg">Refused</Pill>}</td>
                  <td className="dv-mono">{short(r.wallet)}</td>
                  <td>{r.country ?? '–'}</td>
                  <td className="dv-quiet dv-cell-wrap" title={r.client ? `client ${r.client}` : undefined}>{detailOf(r.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(audit.data?.rows ?? []).length && !audit.loading && <div className="dv-sheet__none"><Empty>Nothing logged yet.</Empty></div>}
        </div>
      </Section>
    </Page>
  );
}
