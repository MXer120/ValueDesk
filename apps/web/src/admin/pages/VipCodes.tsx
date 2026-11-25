/**
 * VIP referral codes (owner 2026-11-25: "make it possible for me to via dev upgrade a specific referral code"): whoever
 * joins with an upgraded code pays the VIP fee for a few days. A VIP wallet's code does so by itself, with nothing set here.
 * Upgrading or downgrading asks the builder wallet to sign (admin/signIn.ts codes.add / codes.remove); joins already made
 * keep their days.
 */
import { useState } from 'react';
import { call } from '../api';
import { signAction } from '../wallet';
import { useWallet } from '../WalletPicker';
import { isUserRejection } from '../../wallet';
import { ago, int, short, when } from '../format';
import { Empty, Note, Pill, Section, useAdmin } from '../ui';

interface Code { code: string; addedAt: number; addedBy: string; owner: string | null; joins: number; vipNow: number }
interface Found { code: string; owner: string | null; vip: boolean; upgraded: boolean; joins: number; vipNow: number }

const CODE = /^[A-Z0-9]{4,20}$/;

export function VipCodes() {
  const list = useAdmin<{ days: number; codes: Code[] }>('codes');
  const { ensure } = useWallet();
  const [typed, setTyped] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const code = typed.trim().toUpperCase();
  const valid = CODE.test(code) && code !== 'VALUEDESK';
  const days = list.data?.days ?? 7;
  const codes = list.data?.codes ?? [];

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(isUserRejection(e) ? 'You declined the signature in the wallet - nothing was changed.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const check = () => run('check', async () => { setFound(null); setFound(await call<Found>('codes', { code })); });
  const change = (kind: 'add' | 'remove', c: string) => run(`${kind}-${c}`, async () => {
    const w = await ensure();
    const action = await signAction(w, `codes.${kind}`, c, { code: c }, kind === 'add' ? `Upgrade code ${c}: ${days} days of VIP fee for who joins` : `Downgrade code ${c}`);
    await call(`codes/${kind}`, { code: c, action });
    list.reload();
    if (found?.code === c) setFound(await call<Found>('codes', { code: c }));
  });

  return (
    <>
      <Section title="VIP referral codes" aside={codes.length ? <span className="st-ms">{int(codes.length)} upgraded</span> : undefined}>
        <p className="dv-dim">Whoever joins with an upgraded code pays the VIP fee for {days} days on everything. The code of a VIP wallet (volume, program or beta) does this by itself.</p>
        <form className="dv-beta__form" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void check(); }}>
          <label className="lbp-search dv-beta__address"><input type="text" value={typed} onChange={(e) => { setTyped(e.target.value); setFound(null); setError(null); }} placeholder="Referral code" aria-label="Referral code" spellCheck={false} autoComplete="off" /></label>
          <button type="submit" className="dv-btn" disabled={!valid || !!busy}>{busy === 'check' ? 'Checking…' : 'Check'}</button>
        </form>
        {found && (
          <div className="dv-beta__check" aria-live="polite">
            {!found.owner ? <><Pill tone="dim">Unknown</Pill><span className="dv-dim">SoDEX has no code {found.code}.</span></> : (
              <>
                <Pill tone={found.vip || found.upgraded ? 'pos' : 'dim'}>{found.upgraded ? 'Upgraded' : found.vip ? 'Owner is VIP' : 'Normal code'}</Pill>
                <span className="dv-dim">{found.code} of <span className="dv-mono" title={found.owner}>{short(found.owner)}</span> · {int(found.joins)} joined, {int(found.vipNow)} on the VIP fee now.</span>
                {!found.upgraded && <button type="button" className="dv-btn dv-btn--primary" disabled={!!busy} onClick={() => void change('add', found.code)}>{busy === `add-${found.code}` ? 'Signing…' : 'Upgrade to VIP code'}</button>}
              </>
            )}
          </div>
        )}
        {list.error && <Note kind="error">{list.error}</Note>}
        {error && <Note kind="error">{error}</Note>}
      </Section>
      <Section flush title="Upgraded codes">
        {codes.length === 0 ? <Empty>{list.loading && !list.data ? 'Loading…' : 'No code upgraded yet.'}</Empty> : (
          <div className="dv-sheet">
            <table className="dv-table">
              <thead><tr><th>Code</th><th>Owner</th><th className="right">Joined</th><th className="right">On VIP fee now</th><th className="right">Upgraded</th><th className="right" aria-label="Downgrade" /></tr></thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.code}>
                    <td className="dv-mono"><b className="vip-text">{c.code}</b></td>
                    <td className="dv-mono" title={c.owner ?? undefined}>{c.owner ? short(c.owner) : '–'}</td>
                    <td className="right">{int(c.joins)}</td>
                    <td className="right">{int(c.vipNow)}</td>
                    <td className="right" title={when(c.addedAt)}>{ago(c.addedAt)}</td>
                    <td className="right"><button type="button" className="dv-btn" disabled={!!busy} onClick={() => void change('remove', c.code)}>{busy === `remove-${c.code}` ? 'Signing…' : 'Downgrade'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
