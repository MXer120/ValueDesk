/**
 * Fee programs (owner 2026-11-08): a lower ValueDesk builder fee for one wallet or many, on any of futures, spot,
 * copy trading and bots, for a while - "VIP for 30 days", "0 for the launch week", or a custom fee from a time to a
 * time. Never below 0. The server and the executor pay the lowest of the wallet's volume tier, its running programs
 * and VIP, worked out on every read: when a program ends the wallet is back on its tier by itself
 * (apps/server/src/builder/programs.ts). Each change asks the builder wallet to sign (admin/signIn.ts fees.add /
 * fees.end). The lookup shows what a wallet pays on each product now, and why.
 */
import { useMemo, useState } from 'react';
import { call } from '../api';
import { signAction } from '../wallet';
import { useWallet } from '../WalletPicker';
import { isUserRejection } from '../../wallet';
import { ago, int, short, when } from '../format';
import { Empty, Figure, Figures, Note, Page, Section, useAdmin } from '../ui';

type Product = 'perps' | 'spot' | 'copy' | 'bots';
const PRODUCTS: Array<{ id: Product; label: string }> = [
  { id: 'perps', label: 'Futures' },
  { id: 'spot', label: 'Spot' },
  { id: 'copy', label: 'Copy trading' },
  { id: 'bots', label: 'Bots' },
];
interface Program { id: number; address: string; products: Product[]; fee: number; from: number; until: number | null; label: string; addedAt: number; addedBy: string }
interface Lookup { address: string; vip: boolean; volume14dUsd: number | null; pays: Record<Product, { fee: number | null; why: string; until: number | null }> }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400_000;
const PRESETS = [
  { id: 'vip30', label: 'VIP for 30 days', fee: 'vip' as const, days: 30, name: 'VIP 30 days' },
  { id: 'zero7', label: '0 fees for 7 days', fee: 0, days: 7, name: 'No fees, 7 days' },
  { id: 'custom', label: 'Custom', fee: null, days: null, name: '' },
];
const bp = (tenths: number) => `${(tenths / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} bp`;
const feeWords = (f: number) => (f < 0 ? 'VIP (lowest tier)' : f === 0 ? 'No fee' : bp(f));
const localInput = (t: number) => new Date(t - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function Fees() {
  const list = useAdmin<{ programs: Program[] }>('fees');
  const { ensure } = useWallet();
  const [wallets, setWallets] = useState('');
  const [products, setProducts] = useState<Product[]>(['perps', 'spot', 'copy', 'bots']);
  const [preset, setPreset] = useState('vip30');
  const [fee, setFee] = useState('0');
  const [from, setFrom] = useState(() => localInput(Date.now()));
  const [until, setUntil] = useState(() => localInput(Date.now() + 30 * DAY));
  const [forever, setForever] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [look, setLook] = useState('');
  const [found, setFound] = useState<Lookup | null>(null);

  const addresses = useMemo(() => [...new Set(wallets.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))], [wallets]);
  const bad = addresses.filter((a) => !ADDRESS.test(a));
  const p = PRESETS.find((x) => x.id === preset)!;
  const feeNum = Number(fee);
  const feeOk = p.fee !== null || (fee.trim() !== '' && Number.isFinite(feeNum) && feeNum >= 0);
  const programs = list.data?.programs ?? [];
  const now = Date.now();
  const running = programs.filter((g) => g.from <= now && (g.until === null || g.until > now));
  const can = addresses.length > 0 && !bad.length && products.length > 0 && feeOk && !busy;

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
    const start = p.days !== null ? Date.now() : new Date(from).getTime();
    const end = p.days !== null ? start + p.days * DAY : forever ? null : new Date(until).getTime();
    // Tenths of a bp, as the server keeps it: the form takes bp.
    const f = p.fee !== null ? p.fee : Math.round(feeNum * 10);
    const order = PRODUCTS.map((x) => x.id).filter((x) => products.includes(x));
    const name = (label.trim() || p.name || (f === 0 ? 'No fees' : `Fee ${feeWords(f as number)}`)).replace(/\s+/g, ' ').slice(0, 80);
    const payload = { addresses, products: order, fee: f, from: start, until: end, label: name };
    const target = addresses.length === 1 ? addresses[0]! : `${addresses.length} wallets`;
    const action = await signAction(c, 'fees.add', target, payload, `${name}: ${order.join(', ')} for ${target}`);
    await call('fees/add', { ...payload, action });
    setWallets('');
  });
  const end = (g: Program) => write(`end-${g.id}`, async () => {
    const c = await ensure();
    const action = await signAction(c, 'fees.end', String(g.id), { id: g.id }, `End "${g.label}" for ${short(g.address)}`);
    await call('fees/end', { id: g.id, action });
  });
  const lookup = async () => {
    setFound(null);
    setError(null);
    try {
      setFound(await call<Lookup>('fees/lookup', { address: look.trim().toLowerCase() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Page
      title={`${int(running.length)} fee program${running.length === 1 ? '' : 's'} running`}
      line="Lower the ValueDesk fee for chosen wallets, on any product, for a while. A wallet pays the lowest of its volume tier, its programs and VIP; when a program ends it is back on its tier by itself. Each change asks the builder wallet to sign."
      tone={running.length ? 'pos' : 'unknown'}
      loaded={list}
    >
      {list.error && <Section><Note kind="error">{list.error}</Note></Section>}
      <Section>
        <Figures>
          <Figure label="Running" value={int(running.length)} />
          <Figure label="Wallets" value={int(new Set(running.map((g) => g.address)).size)} />
          <Figure label="Ending next" value={(() => { const n = running.filter((g) => g.until !== null).sort((a, b) => a.until! - b.until!)[0]; return n ? ago(n.until!).replace(' ago', '') : '–'; })()} sub="Back to the tier then" />
        </Figures>
      </Section>

      <Section title="What a wallet pays now">
        <form className="dv-beta__form" onSubmit={(e) => { e.preventDefault(); if (ADDRESS.test(look.trim())) void lookup(); }}>
          <label className="lbp-search dv-beta__address"><input type="text" value={look} onChange={(e) => setLook(e.target.value)} placeholder="Wallet 0x…" aria-label="Wallet to look up" spellCheck={false} autoComplete="off" /></label>
          <button type="submit" className="dv-btn" disabled={!ADDRESS.test(look.trim())}>Look up</button>
        </form>
        {found && (
          <div className="dv-sheet">
            <table className="dv-table">
              <thead><tr><th>Product</th><th className="right">Pays</th><th>Why</th><th className="right">Until</th></tr></thead>
              <tbody>
                {PRODUCTS.map((x) => (
                  <tr key={x.id}>
                    <td>{x.label}</td>
                    <td className="right dv-mono">{found.pays[x.id].fee === null ? '–' : bp(found.pays[x.id].fee!)}</td>
                    <td>{found.pays[x.id].why}</td>
                    <td className="right">{found.pays[x.id].until ? when(found.pays[x.id].until!) : <span className="dv-quiet">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dv-dim">{found.vip ? 'VIP: the lowest tier on every product.' : 'Not VIP.'} 14-day volume {found.volume14dUsd === null ? 'unknown' : `$${int(found.volume14dUsd)}`}.</p>
          </div>
        )}
      </Section>

      <Section title="Start a program">
        <div className="dv-fees__form">
          <label className="dv-fees__wide">
            <span>Wallets (one or many, by line, comma or space)</span>
            <textarea value={wallets} onChange={(e) => setWallets(e.target.value)} rows={3} placeholder="0x…" spellCheck={false} />
            <small className={bad.length ? 'dv-error' : 'dv-dim'}>{bad.length ? `${bad.length} not a wallet address: ${short(bad[0]!)}` : `${addresses.length} wallet${addresses.length === 1 ? '' : 's'}`}</small>
          </label>
          <div className="dv-fees__wide">
            <span>Products</span>
            <div className="dv-chips">
              {PRODUCTS.map((x) => (
                <button key={x.id} type="button" className={`dv-chip${products.includes(x.id) ? ' is-on' : ''}`} aria-pressed={products.includes(x.id)} onClick={() => setProducts((ps) => (ps.includes(x.id) ? ps.filter((y) => y !== x.id) : [...ps, x.id]))}>{x.label}</button>
              ))}
            </div>
          </div>
          <div className="dv-fees__wide">
            <span>Program</span>
            <div className="dv-chips">
              {PRESETS.map((x) => <button key={x.id} type="button" className={`dv-chip${preset === x.id ? ' is-on' : ''}`} aria-pressed={preset === x.id} onClick={() => setPreset(x.id)}>{x.label}</button>)}
            </div>
          </div>
          {preset === 'custom' && (
            <>
              <label><span>Fee (bp, 0 or more)</span><input type="number" min={0} step={0.1} value={fee} onChange={(e) => setFee(e.target.value)} /></label>
              <label><span>From</span><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label><span>Until</span><input type="datetime-local" value={until} disabled={forever} onChange={(e) => setUntil(e.target.value)} /></label>
              <label className="dv-fees__check"><input type="checkbox" checked={forever} onChange={(e) => setForever(e.target.checked)} /> No end (until ended here)</label>
            </>
          )}
          <label className="dv-fees__wide"><span>Name (optional)</span><input type="text" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder={p.name || 'e.g. Launch week'} /></label>
        </div>
        <button type="button" className="dv-btn dv-btn--primary" disabled={!can} onClick={() => void add()}>{busy === 'add' ? 'Waiting for the signature…' : `Sign and start for ${addresses.length || 0} wallet${addresses.length === 1 ? '' : 's'}`}</button>
        {error && <p className="dv-error" role="alert">{error}</p>}
      </Section>

      <Section flush title="Programs">
        {programs.length === 0 ? <Empty>No program yet.</Empty> : (
          <div className="dv-sheet">
            <table className="dv-table">
              <thead><tr><th>Wallet</th><th>Program</th><th>Products</th><th className="right">Fee</th><th className="right">From</th><th className="right">Until</th><th className="right" aria-label="End" /></tr></thead>
              <tbody>
                {programs.map((g) => {
                  const on = g.from <= now && (g.until === null || g.until > now);
                  return (
                    <tr key={g.id} className={on ? '' : 'dv-quiet'}>
                      <td className="dv-mono" title={g.address}>{short(g.address)}</td>
                      <td>{g.label}{!on && <span className="dv-quiet"> · {g.from > now ? 'starts later' : 'ended'}</span>}</td>
                      <td>{g.products.map((x) => PRODUCTS.find((y) => y.id === x)?.label ?? x).join(', ')}</td>
                      <td className="right dv-mono">{feeWords(g.fee)}</td>
                      <td className="right" title={when(g.from)}>{when(g.from)}</td>
                      <td className="right">{g.until === null ? 'No end' : when(g.until)}</td>
                      <td className="right">{on || g.from > now ? <button type="button" className="dv-btn" disabled={!!busy} onClick={() => void end(g)}>{busy === `end-${g.id}` ? 'Signing…' : 'End now'}</button> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Page>
  );
}
