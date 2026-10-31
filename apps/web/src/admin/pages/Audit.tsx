/** The admin audit log (admin/store.ts, hash-chained) and the open sessions. Signing everyone out is in the navbar's menu. */
import { ago, short, when } from '../format';
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
};

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
      <Section title="Open sessions" aside={<span className="st-ms">each ends 24 h after its sign-in</span>} flush>
        <div className="ad-sheet">
          <table className="ad-table">
            <thead><tr><th>Session</th><th>Wallet</th><th>Since</th><th>Ends</th><th>Client</th><th>Country</th></tr></thead>
            <tbody>{(me.data?.sessions ?? []).map((s) => <tr key={s.id}><td className="ad-mono">{s.id}</td><td className="ad-mono">{short(s.wallet)}</td><td>{when(s.createdAt)}</td><td>{when(s.expiresAt)}</td><td className="ad-mono">{s.client}</td><td>{s.country ?? '–'}</td></tr>)}</tbody>
          </table>
        </div>
      </Section>
      <Section title="Log" aside={refused ? <Pill tone="warn">{refused} refused in 24 h</Pill> : undefined} flush>
        <div className="ad-sheet">
          <table className="ad-table">
            <thead><tr><th>When</th><th>What</th><th>Result</th><th>Wallet</th><th>Client</th><th>Country</th><th>Detail</th></tr></thead>
            <tbody>
              {(audit.data?.rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td title={when(r.at)}>{ago(r.at)}</td>
                  <td>{KIND[r.kind] ?? r.kind}</td>
                  <td>{r.ok ? <Pill tone="pos">Done</Pill> : <Pill tone="neg">Refused</Pill>}</td>
                  <td className="ad-mono">{short(r.wallet)}</td>
                  <td className="ad-mono">{r.client ?? '–'}</td>
                  <td>{r.country ?? '–'}</td>
                  <td className="ad-quiet">{r.detail ? Object.entries(r.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(audit.data?.rows ?? []).length && !audit.loading && <div className="ad-sheet__none"><Empty>Nothing logged yet.</Empty></div>}
        </div>
      </Section>
    </Page>
  );
}
