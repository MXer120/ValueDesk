/**
 * The beta list: the wallets that may use beta.valuedesk.so, where features go live before they reach
 * everyone (apps/server/src/beta/gate.ts reads this list on every request, so a wallet taken off is
 * out within seconds). Adding or removing one asks the builder wallet for a signature that names
 * that wallet (admin/signIn.ts beta.add / beta.remove).
 */
import { useState } from 'react';
import { call } from '../api';
import { signAction } from '../wallet';
import { useWallet } from '../WalletPicker';
import { isUserRejection } from '../../wallet';
import { ago, int, short, when } from '../format';
import { Empty, Figure, Figures, Note, Page, Section, useAdmin } from '../ui';

interface BetaWallet {
  address: string;
  label: string;
  addedAt: number;
  addedBy: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LABEL_MAX = 60;

export function Beta() {
  const list = useAdmin<{ wallets: BetaWallet[] }>('beta');
  const { ensure } = useWallet();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallets = list.data?.wallets ?? [];
  const typed = address.trim();
  const valid = ADDRESS.test(typed);
  const known = valid && wallets.some((w) => w.address === typed.toLowerCase());

  const write = async (what: string, run: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await run();
      list.reload();
    } catch (e) {
      setError(isUserRejection(e) ? 'You declined the signature in the wallet - nothing was changed.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const add = () => write('add', async () => {
    const c = await ensure();
    const payload = { address: typed.toLowerCase(), label: label.replace(/\s+/g, ' ').trim() };
    const action = await signAction(c, 'beta.add', payload.address, payload, `${known ? 'Rename' : 'Add'} beta tester ${payload.label || payload.address}`);
    await call('beta/add', { ...payload, action });
    setAddress('');
    setLabel('');
  });
  const remove = (w: BetaWallet) => write(w.address, async () => {
    const c = await ensure();
    const payload = { address: w.address };
    const action = await signAction(c, 'beta.remove', w.address, payload, `Remove beta tester ${w.label || w.address}`);
    await call('beta/remove', { ...payload, action });
  });

  const last = wallets.reduce((m, w) => Math.max(m, w.addedAt), 0);
  return (
    <Page
      title={`${int(wallets.length)} beta tester${wallets.length === 1 ? '' : 's'}`}
      line="Only these wallets can open beta.valuedesk.so, where new features go live before everyone gets them. Each change asks the builder wallet to sign; a wallet you remove loses access within seconds."
      tone={wallets.length ? 'pos' : 'unknown'}
      loaded={list}
    >
      {list.error && <Section><Note kind="error">{list.error}</Note></Section>}
      <Section>
        <Figures>
          <Figure label="Testers" value={int(wallets.length)} />
          <Figure label="Last added" value={last ? ago(last) : '–'} sub={last ? when(last) : undefined} />
          <Figure label="Site" value="beta.valuedesk.so" sub="7-day sign-in per tester" />
        </Figures>
      </Section>
      <Section title="Add a tester">
        <form className="dv-beta__form" onSubmit={(e) => { e.preventDefault(); if (valid) void add(); }}>
          <label className="lbp-search dv-beta__address">
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Wallet 0x…" aria-label="Wallet address" spellCheck={false} autoComplete="off" />
          </label>
          <label className="lbp-search dv-beta__label">
            <input type="text" value={label} maxLength={LABEL_MAX} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" aria-label="Name" autoComplete="off" />
          </label>
          <button type="submit" className="dv-btn dv-btn--primary" disabled={!valid || !!busy}>
            {busy === 'add' ? 'Waiting for the signature…' : known ? 'Sign and rename' : 'Sign and add'}
          </button>
        </form>
        {typed && !valid && <p className="dv-dim">A wallet address is 0x and 40 hex characters.</p>}
        {error && <p className="dv-error" role="alert">{error}</p>}
      </Section>
      <Section flush>
        <div className="dv-sheet">
          <table className="dv-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Name</th>
                <th className="right">Added</th>
                <th>By</th>
                <th className="right" aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => (
                <tr key={w.address}>
                  <td className="dv-mono" title={w.address}>{short(w.address)}</td>
                  <td>{w.label || <span className="dv-quiet">–</span>}</td>
                  <td className="right" title={when(w.addedAt)}>{ago(w.addedAt)}</td>
                  <td className="dv-mono dv-quiet" title={w.addedBy}>{short(w.addedBy)}</td>
                  <td className="right">
                    <button type="button" className="dv-btn" disabled={!!busy} onClick={() => void remove(w)}>
                      {busy === w.address ? 'Signing…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!wallets.length && !list.loading && <div className="dv-sheet__none"><Empty>No tester yet. Add a wallet above to open the beta to it.</Empty></div>}
        </div>
      </Section>
    </Page>
  );
}
