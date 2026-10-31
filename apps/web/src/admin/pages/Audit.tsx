/** The admin audit log (admin/store.ts, hash-chained) and the open sessions. */
import { useState } from 'react';
import { call } from '../api';
import { signAction } from '../wallet';
import { useWallet } from '../WalletPicker';
import { isUserRejection } from '../../wallet';
import { saveSession } from '../api';
import { ago, short, when } from '../format';
import { Badge, Note, PageHead, Panel, useAdmin } from '../ui';
import type { AuditRow, OpenSession } from '../types';

export function Audit() {
  const audit = useAdmin<{ rows: AuditRow[]; chain: { rows: number; brokenAt: number | null } }>('audit');
  const me = useAdmin<{ wallet: string; expiresAt: number; sessions: OpenSession[] }>('me');
  const { ensure } = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await ensure();
      const action = await signAction(c, 'sessions.revoke', 'all sessions', {}, 'Sign every admin session out, this one too');
      await call('sessions/revoke', { action });
      saveSession(null);
    } catch (e) {
      setError(isUserRejection(e) ? 'You declined the signature - nothing changed.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const chain = audit.data?.chain;
  return (
    <>
      <PageHead title="Audit & sessions" line="Every sign-in, refusal and change, each row chained to the one before; the sessions open now." loaded={audit} />
      {audit.error && <Note kind="error">{audit.error}</Note>}
      <Panel title="Open sessions" actions={<button type="button" className="ad-btn" onClick={() => void revoke()} disabled={busy}>{busy ? 'Signing…' : 'Sign out everywhere'}</button>}>
        <div className="ad-tablewrap">
          <table className="ad-table ad-table--compact">
            <thead><tr><th>Id</th><th>Wallet</th><th>Since</th><th>Ends</th><th>Client</th><th>Country</th></tr></thead>
            <tbody>{(me.data?.sessions ?? []).map((s) => <tr key={s.id}><td className="ad-mono">{s.id}</td><td className="ad-mono">{short(s.wallet)}</td><td>{when(s.createdAt)}</td><td>{when(s.expiresAt)}</td><td className="ad-mono">{s.client}</td><td>{s.country ?? '–'}</td></tr>)}</tbody>
          </table>
        </div>
        {error && <p className="ad-error" role="alert">{error}</p>}
      </Panel>
      <Panel title="Audit log" actions={chain && (chain.brokenAt === null ? <Badge tone="pos">chain intact · {chain.rows} rows</Badge> : <Badge tone="neg">chain broken at row {chain.brokenAt}</Badge>)}>
        <div className="ad-tablewrap">
          <table className="ad-table ad-table--compact">
            <thead><tr><th>When</th><th>What</th><th>Result</th><th>Wallet</th><th>Client</th><th>Country</th><th>Detail</th></tr></thead>
            <tbody>
              {(audit.data?.rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td title={when(r.at)}>{ago(r.at)}</td>
                  <td className="ad-mono">{r.kind}</td>
                  <td>{r.ok ? <Badge tone="pos">ok</Badge> : <Badge tone="neg">refused</Badge>}</td>
                  <td className="ad-mono">{short(r.wallet)}</td>
                  <td className="ad-mono">{r.client ?? '–'}</td>
                  <td>{r.country ?? '–'}</td>
                  <td className="ad-dim">{r.detail ? Object.entries(r.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
