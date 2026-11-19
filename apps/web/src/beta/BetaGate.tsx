/**
 * beta.valuedesk.so: the door before the app (main.tsx mounts this only in a build with
 * VITE_CHANNEL=beta; the site's own build never contains it).
 *
 * Nothing here is the lock - the beta API is (apps/server/src/beta/gate.ts): without the token of a
 * wallet on the beta list it answers nothing. This page asks /api/beta/me whether the token in the
 * vs_beta cookie is good, and if not walks the tester through it: connect a wallet (the admin
 * suite's own picker), sign a free BetaSignIn (never a transaction), get the 7-day token. The Vercel
 * function hands the cookie to the API as x-vs-beta on every request (deploy/vercel/api-proxy.cjs).
 *
 * It asks again every minute and when the tab comes back, so a wallet taken off the list sees why
 * instead of a page of failed loads.
 */
import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { BETA_COOKIE, BETA_SIGN_IN_STATEMENT, BETA_SIGN_IN_TTL_MS, betaSignInTypedData, type BetaSignIn } from '@sign/beta/signIn';
import { getChainId, isUserRejection, signTypedData } from '../wallet';
import { BrandMark } from '../components/BrandMark';
import { WalletPicker } from '../admin/WalletPicker';
import { nonce, type Connected } from '../admin/wallet';
import { short } from '../admin/format';
import { dropBootShell } from '../bootShell';

type Me = { channel: 'beta'; wallet: string | null; listed: boolean };
type State =
  | { at: 'checking' }
  | { at: 'in'; wallet: string }
  | { at: 'out' }
  | { at: 'refused'; wallet: string; ended: boolean };

const RECHECK_MS = 60_000;

async function me(): Promise<Me> {
  const r = await fetch('/api/beta/me', { cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) throw new Error(`The beta is not reachable right now (${r.status}).`);
  return (await r.json()) as Me;
}

function keepToken(token: string, expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  document.cookie = `${BETA_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`;
}

function dropToken(): void {
  document.cookie = `${BETA_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Strict`;
}

/** Sign the BetaSignIn and trade it for a token; the wallet when it is not on the list. */
async function signIn(c: Connected): Promise<{ ok: true } | { ok: false; listed: false; wallet: string }> {
  const chainId = await getChainId(c.provider).catch(() => 1);
  const t = Date.now();
  const msg: Omit<BetaSignIn, 'signature'> = {
    owner: c.address, statement: BETA_SIGN_IN_STATEMENT, nonce: nonce(), issuedAt: String(t), expiresAt: String(t + BETA_SIGN_IN_TTL_MS - 30_000), chainId,
  };
  const signature = await signTypedData(c.provider, c.address, betaSignInTypedData(msg));
  const r = await fetch('/api/beta/session', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signIn: { ...msg, signature } }),
  });
  const body = (await r.json().catch(() => ({}))) as { token?: string; expiresAt?: number; code?: string; error?: string };
  if (r.ok && body.token && body.expiresAt) {
    keepToken(body.token, body.expiresAt);
    return { ok: true };
  }
  if (body.code === 'beta-list') return { ok: false, listed: false, wallet: c.address };
  throw new Error(body.error || `The sign-in failed (${r.status}).`);
}

export default function BetaGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ at: 'checking' });
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const m = await me();
      setError(null);
      setState((s) => {
        if (m.wallet && m.listed) return s.at === 'in' && s.wallet === m.wallet ? s : { at: 'in', wallet: m.wallet };
        if (m.wallet && !m.listed) return { at: 'refused', wallet: m.wallet, ended: s.at === 'in' };
        // No good token: in the app it ran out; at the door, keep the step the tester is on.
        return s.at === 'in' || s.at === 'checking' ? { at: 'out' } : s;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState((s) => (s.at === 'checking' ? { at: 'out' } : s));
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void check(); }, RECHECK_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check]);

  /* The door takes the screen: index.html's static shell (a picture of the app, bootShell.ts) goes. */
  useLayoutEffect(() => {
    if (state.at !== 'in') dropBootShell();
  }, [state.at]);

  if (state.at === 'in') return <>{children}</>;
  return (
    <div className="dv-root">
      <header className="navbar dv-navbar">
        <div className="navbar-inner">
          <span className="brand">
            <BrandMark />
            ValueDesk
            <span className="dv-devtag dv-devtag--beta">Beta</span>
          </span>
        </div>
      </header>
      <main className="dv-main">
        <div className="st dv-page">
          {state.at === 'checking' ? <Checking /> : state.at === 'refused' ? (
            <Refused wallet={state.wallet} ended={state.ended} onRetry={() => { dropToken(); setState({ at: 'out' }); }} />
          ) : (
            <Door error={error} onIn={() => void check()} onRefused={(wallet) => { dropToken(); setState({ at: 'refused', wallet, ended: false }); }} />
          )}
        </div>
      </main>
    </div>
  );
}

function Hero({ tone, icon, title, line }: { tone: 'is-unknown' | 'is-down'; icon: string; title: string; line: ReactNode }) {
  return (
    <header className={`st-hero ${tone}`}>
      <svg className="st-hero__icon" viewBox="0 0 20 20" width="36" height="36" aria-hidden="true">
        <circle className="st-hero__shape" cx="10" cy="10" r="8.6" />
        <path className="st-hero__sign" d={icon} fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="st-hero__text">
        <h1 className="st-hero__title">{title}</h1>
        <p className="st-hero__line">{line}</p>
      </div>
    </header>
  );
}

const LOCK = 'M7 9V7.6a3 3 0 0 1 6 0V9M6.4 9h7.2v4.8H6.4z';
const CROSS = 'M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6';

function Checking() {
  return (
    <article className="st-card dv-card--narrow" aria-busy="true">
      <Hero tone="is-unknown" icon={LOCK} title="Opening the beta…" line="Checking whether this browser is signed in to the beta." />
    </article>
  );
}

function Door({ error, onIn, onRefused }: { error: string | null; onIn: () => void; onRefused: (wallet: string) => void }) {
  const [connected, setConnected] = useState<Connected | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const sign = async () => {
    if (!connected) return;
    setBusy(true);
    setFailed(null);
    try {
      const r = await signIn(connected);
      if (r.ok) onIn();
      else onRefused(r.wallet);
    } catch (e) {
      setFailed(isUserRejection(e) ? 'You declined the signature in the wallet.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="st-card dv-card--narrow">
      <Hero
        tone="is-unknown"
        icon={LOCK}
        title="ValueDesk beta"
        line="New features go live here before everyone gets them. It is open to invited wallets only: sign in with yours to continue. The sign-in lasts 7 days."
      />
      <ol className="dv-steps">
        <li className={connected ? 'is-done' : undefined}>
          <div className="dv-steps__title"><span className="dv-steps__n">{connected ? '✓' : '1'}</span>Connect your wallet</div>
          {connected
            ? <div className="dv-mono dv-dim">{connected.name} · {short(connected.address)}</div>
            : <WalletPicker onConnected={setConnected} />}
        </li>
        <li>
          <div className="dv-steps__title"><span className="dv-steps__n">2</span>Sign in to the beta</div>
          <p className="dv-dim dv-beta-gate__note">A free signature that proves the wallet is yours. Never a transaction, nothing is moved.</p>
          <button type="button" className="dv-btn dv-btn--primary dv-beta-gate__sign" disabled={!connected || busy} onClick={() => void sign()}>
            {busy ? 'Waiting for the signature…' : 'Sign and enter'}
          </button>
        </li>
      </ol>
      {(failed || error) && <p className="dv-error dv-pad-x" role="alert">{failed ?? error}</p>}
    </article>
  );
}

function Refused({ wallet, ended, onRetry }: { wallet: string; ended: boolean; onRetry: () => void }) {
  return (
    <article className="st-card dv-card--narrow">
      <Hero
        tone="is-down"
        icon={CROSS}
        title={ended ? 'Your beta access ended' : 'This wallet is not on the beta list'}
        line={<><span className="dv-mono" title={wallet}>{short(wallet)}</span> {ended ? 'was taken off the beta list.' : 'has no beta access.'} Ask the ValueDesk team to add it, or sign in with another wallet.</>}
      />
      <div className="dv-pad-x dv-beta-gate__actions">
        <button type="button" className="dv-btn dv-btn--primary" onClick={onRetry}>Use another wallet</button>
        <a className="dv-btn" href="https://www.valuedesk.so/">Go to valuedesk.so</a>
      </div>
    </article>
  );
}
