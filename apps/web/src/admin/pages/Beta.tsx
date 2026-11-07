/**
 * Access: the beta list (admin/store.ts beta_wallets). A wallet on it gets real bots and every advanced
 * algo order on valuedesk.so (beta/access.ts offers them; the executor checks the signer again,
 * apps/executor/src/service.ts liveBotFor) and may sign in to beta.valuedesk.so (beta/gate.ts).
 *
 * Owner 2026-11-07: "what wallet do i need to use to get access to bots etc? Need to be able to whitelist
 * address on dev.valuedesk.so". The page used to speak only of beta.valuedesk.so, so it never read as the
 * whitelist for bots, and no add was ever sent (prod audit log and API log: 0 beta.add). It now says what
 * a listed wallet gets and how soon, checks any address as it is typed, and confirms every change.
 *
 * Adding, renaming or removing needs only the signed-in session (owner 2026-11-07: "i dont want to sign for everyone
 * that gets added to beta"); each change is in the audit log with the session's wallet.
 */
import { useEffect, useState } from 'react';
import { call } from '../api';
import { ago, int, short, when } from '../format';
import { Empty, Note, Page, Pill, Section, useAdmin } from '../ui';

interface BetaWallet {
  address: string;
  label: string;
  addedAt: number;
  addedBy: string;
}

interface BetaAnswer {
  wallets: BetaWallet[];
  takesEffect?: { betaSiteMs: number; mainSiteMs: number; executorMs: number };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LABEL_MAX = 60;
/** The owner's test wallet: real algos through the executor's own allowlist on server 2 (EXECUTOR_LIVE_ALGOS_WALLETS). */
const TEST_WALLET = '0x04fb8f9d0d8cd5495aa47e81ca9804cdf32a277d';

const secs = (ms: number | undefined, fallback: string): string => (ms ? (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`) : fallback);

export function Beta() {
  const list = useAdmin<BetaAnswer>('beta');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; address: string; at: number } | null>(null);
  const [fresh, setFresh] = useState<BetaWallet[] | null>(null);
  const wallets = fresh ?? list.data?.wallets ?? [];
  // The server's answer replaces the one a write handed back.
  useEffect(() => setFresh(null), [list.data]);
  const fx = list.data?.takesEffect;
  const typed = address.trim();
  const valid = ADDRESS.test(typed);
  const found = valid ? wallets.find((w) => w.address === typed.toLowerCase()) ?? null : null;
  const cleanLabel = label.replace(/\s+/g, ' ').trim();

  const write = async (what: string, run: () => Promise<{ wallets?: BetaWallet[] }>, said: (w: string) => string, target: string) => {
    setBusy(what);
    setError(null);
    setDone(null);
    try {
      const r = await run();
      if (Array.isArray(r.wallets)) setFresh(r.wallets);
      setDone({ text: said(target), address: target, at: Date.now() });
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const add = () => {
    const payload = { address: typed.toLowerCase(), label: cleanLabel };
    const rename = !!found;
    return write('add', async () => {
      const r = await call<{ wallets?: BetaWallet[] }>('beta/add', payload);
      setAddress('');
      setLabel('');
      return r;
    }, (w) => (rename ? `Renamed ${short(w)}.` : `${short(w)} is on the list. Real bots and every algo order open for it within ${secs(fx?.executorMs, 'a minute')} (or on a reload of the site); beta.valuedesk.so lets it in now.`), payload.address);
  };
  const remove = (w: BetaWallet) => write(w.address, async () => {
    return call<{ wallets?: BetaWallet[] }>('beta/remove', { address: w.address });
  }, (a) => `${short(a)} is off the list. Its bots are held within ${secs(fx?.executorMs, 'a minute')}; beta.valuedesk.so turns it away within ${secs(fx?.betaSiteMs, '10 s')}.`, w.address);

  const n = wallets.length;
  return (
    <Page
      title={n ? `${int(n)} wallet${n === 1 ? '' : 's'} with beta access` : 'No wallet has beta access yet'}
      line="Add the wallet you trade with, the one you connect on valuedesk.so. No signature needed: your sign-in covers it."
      tone={n ? 'pos' : 'unknown'}
      loaded={list}
    >
      {list.error && <Section><Note kind="error">{list.error}</Note></Section>}
      <Section title="What a listed wallet gets">
        <ul className="dv-grants">
          <li>
            <span className="dv-grants__icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6.5" width="12" height="9" rx="2.5" /><path d="M10 3.5v3M7.5 10.5v1M12.5 10.5v1M2 10v2.5M18 10v2.5" /></svg>
            </span>
            <div><b>Real bots</b><span>Market-making and grid bots with real orders on valuedesk.so and the beta site. Without access they run as practice only.</span></div>
            <Pill tone="dim">within {secs(fx?.executorMs, '1 min')}</Pill>
          </li>
          <li>
            <span className="dv-grants__icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 14.5 7.5 10l3 3L17 6.5" /><path d="M13 6.5h4v4" /></svg>
            </span>
            <div><b>Every algo order in the ticket</b><span>VWAP, POV, Iceberg, Chase, Scale, DCA, Swarm, Bracket and Basket, as practice runs while real algos are off for everyone. TWAP, Trailing stop, Fill fast and Conditional stay open to all.</span></div>
            <Pill tone="dim">within {secs(fx?.mainSiteMs, '1 min')}</Pill>
          </li>
          <li>
            <span className="dv-grants__icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="7" /><path d="M3 10h14M10 3c2 2.2 2.8 4.5 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3Z" /></svg>
            </span>
            <div><b>beta.valuedesk.so</b><span>Sign-in to the beta site, where features go live first. A wallet taken off is turned away.</span></div>
            <Pill tone="dim">within {secs(fx?.betaSiteMs, '10 s')}</Pill>
          </li>
        </ul>
        <p className="dv-dim">The test wallet {short(TEST_WALLET)} also runs real algos through the executor's own allowlist on server 2. That list is set on the server, not here.</p>
      </Section>
      <Section title="Check or add a wallet">
        <form className="dv-beta__form" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void add(); }}>
          <label className="lbp-search dv-beta__address">
            <input type="text" value={address} onChange={(e) => { setAddress(e.target.value); setDone(null); setError(null); }} placeholder="Wallet address 0x…" aria-label="Wallet address" spellCheck={false} autoComplete="off" inputMode="text" />
          </label>
          <label className="lbp-search dv-beta__label">
            <input type="text" value={label} maxLength={LABEL_MAX} onChange={(e) => setLabel(e.target.value)} placeholder={found?.label || 'Name (optional)'} aria-label="Name" autoComplete="off" />
          </label>
          <button type="submit" className="dv-btn dv-btn--primary" disabled={!valid || !!busy || (!!found && (!cleanLabel || cleanLabel === found.label))}>
            {busy === 'add' ? 'Saving…' : found ? 'Rename' : 'Give access'}
          </button>
        </form>
        <div className="dv-beta__check" aria-live="polite">
          {!typed ? null : !valid ? (
            <span className="dv-dim">A wallet address is 0x and 40 hex characters{typed.length !== 42 ? ` (this one has ${typed.length})` : ''}.</span>
          ) : found ? (
            <>
              <Pill tone="pos">On the list</Pill>
              <span className="dv-dim">{found.label ? `${found.label} · ` : ''}added {ago(found.addedAt)}. Type a new name to rename it, or remove it below.</span>
            </>
          ) : (
            <>
              <Pill tone="dim">Not on the list</Pill>
              <span className="dv-dim">Bots run as practice only and the advanced orders are locked for this wallet.</span>
            </>
          )}
        </div>
        {done && <Note kind="info"><b>Done.</b> {done.text}</Note>}
        {error && <Note kind="error">{error}</Note>}
      </Section>
      <Section title="On the list" aside={n ? <span className="st-ms">{int(n)} wallet{n === 1 ? '' : 's'}</span> : undefined}>
        {n ? (
          <ul className="dv-wlist">
            {[...wallets].sort((a, b) => b.addedAt - a.addedAt).map((w) => (
              <li key={w.address} className={done?.address === w.address ? 'is-new' : undefined}>
                <div className="dv-wlist__who">
                  <span className="dv-wlist__name">{w.label || 'No name'}{done?.address === w.address && <Pill tone="pos">Just changed</Pill>}</span>
                  <span className="dv-mono dv-wlist__addr" title={w.address}>{w.address}</span>
                </div>
                <span className="st-ms dv-wlist__when" title={`${when(w.addedAt)} by ${w.addedBy}`}>added {ago(w.addedAt)}</span>
                <button type="button" className="dv-btn" disabled={!!busy} onClick={() => void remove(w)}>
                  {busy === w.address ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        ) : !list.loading || list.data ? (
          <Empty>No wallet yet. Paste the address you trade with above and give it access.</Empty>
        ) : (
          <Empty>Loading…</Empty>
        )}
      </Section>
    </Page>
  );
}
