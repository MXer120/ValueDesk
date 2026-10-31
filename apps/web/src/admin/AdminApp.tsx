/**
 * The owner's admin suite on dev.valuedesk.so: sign-in, then the pages.
 *
 * Nothing here is a lock - the server is (apps/server/src/routes/admin.ts): no
 * session, no data; no fresh signature, no write. The page asks for the wallet's
 * signature and the password, keeps the session token, and on every write asks
 * the wallet again.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { call, loadSession, onSession, saveSession, type AdminSession } from './api';
import { signIn, type Connected } from './wallet';
import { WalletContext, WalletPicker } from './WalletPicker';
import { isUserRejection } from '../wallet';
import { duration, short } from './format';
import { Overview } from './pages/Overview';
import { Tickets } from './pages/Tickets';
import { Users } from './pages/Users';
import { Revenue } from './pages/Revenue';
import { Analytics } from './pages/Analytics';
import { Status } from './pages/Status';
import { Audit } from './pages/Audit';

const PAGES: Array<{ id: string; label: string; render: (arg: string) => ReactNode }> = [
  { id: 'overview', label: 'Overview', render: () => <Overview /> },
  { id: 'tickets', label: 'Tickets', render: (arg) => <Tickets selected={arg ? Number(arg) : null} /> },
  { id: 'users', label: 'Users', render: () => <Users /> },
  { id: 'revenue', label: 'Volume & fees', render: () => <Revenue /> },
  { id: 'analytics', label: 'Analytics', render: () => <Analytics /> },
  { id: 'status', label: 'Status', render: () => <Status /> },
  { id: 'audit', label: 'Audit & sessions', render: () => <Audit /> },
];

/** #/tickets/12 -> ['tickets', '12']. */
function routeOf(hash: string): [string, string] {
  const [page = 'overview', arg = ''] = hash.replace(/^#\/?/, '').split('/');
  return [PAGES.some((p) => p.id === page) ? page : 'overview', arg];
}

export function AdminApp() {
  const [session, setSession] = useState<AdminSession | null>(() => loadSession());
  const [connected, setConnected] = useState<Connected | null>(null);
  const [route, setRoute] = useState(() => routeOf(location.hash));
  const [asking, setAsking] = useState(false);
  const waiters = useRef<Array<{ ok: (c: Connected) => void; no: (e: Error) => void }>>([]);

  useEffect(() => onSession(setSession), []);
  useEffect(() => {
    const on = () => setRoute(routeOf(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  // The server ends a session after 24 h; the page signs out at the same moment.
  useEffect(() => {
    if (!session) return;
    const t = setTimeout(() => saveSession(null), Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [session]);

  const ensure = useCallback((): Promise<Connected> => {
    if (connected && session && connected.address === session.wallet) return Promise.resolve(connected);
    setAsking(true);
    return new Promise((ok, no) => waiters.current.push({ ok, no }));
  }, [connected, session]);
  const settle = (c: Connected | null) => {
    setAsking(false);
    if (c) setConnected(c);
    for (const w of waiters.current.splice(0)) (c ? w.ok(c) : w.no(new Error('No wallet was connected.')))
  };

  if (!session) return <SignIn onConnected={setConnected} connected={connected} />;

  const [page, arg] = route;
  const signOut = () => {
    void call('signout').catch(() => null).finally(() => saveSession(null));
  };
  return (
    <WalletContext.Provider value={{ connected, ensure }}>
      <div className="ad-shell">
        <aside className="ad-nav">
          <div className="ad-brand">ValueDesk <span>Dev</span></div>
          <nav>
            {PAGES.map((p) => (
              <a key={p.id} href={`#/${p.id}`} className={p.id === page ? 'is-on' : undefined} aria-current={p.id === page ? 'page' : undefined}>{p.label}</a>
            ))}
          </nav>
          <div className="ad-nav__foot">
            <div className="ad-dim">Signed in as</div>
            <div className="ad-mono" title={session.wallet}>{short(session.wallet)}</div>
            <div className="ad-dim">session ends in {duration(session.expiresAt - Date.now())}</div>
            <div className="ad-dim">{connected ? `wallet: ${connected.name}` : 'wallet not connected (asked for at the first change)'}</div>
            <button type="button" className="ad-btn" onClick={signOut}>Sign out</button>
          </div>
          <button type="button" className="ad-btn ad-nav__out" onClick={signOut}>Sign out</button>
        </aside>
        <main className="ad-main">{PAGES.find((p) => p.id === page)!.render(arg)}</main>
      </div>
      {asking && (
        <div className="ad-modal" role="dialog" aria-modal="true" aria-label="Connect the builder wallet">
          <div className="ad-modal__card">
            <h2>Sign this change with the builder wallet</h2>
            <p className="ad-dim">Every change needs a fresh signature from {short(session.wallet)}.</p>
            <WalletPicker wantAddress={session.wallet} onConnected={settle} />
            <button type="button" className="ad-btn" onClick={() => settle(null)}>Cancel</button>
          </div>
        </div>
      )}
    </WalletContext.Provider>
  );
}

function SignIn({ connected, onConnected }: { connected: Connected | null; onConnected: (c: Connected) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!connected || !password) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(connected, password);
    } catch (e) {
      setError(isUserRejection(e) ? 'You declined the signature in the wallet.' : e instanceof Error ? e.message : String(e));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <div className="ad-signin">
      <div className="ad-signin__card">
        <div className="ad-signin__hero">
          <div className="ad-brand">ValueDesk <span>Dev</span></div>
          <h1>Sign in</h1>
          <p>The builder wallet's signature and the admin password open this suite for 24 hours. Each change you make asks the wallet again.</p>
        </div>
        <ol className="ad-steps">
          <li className={connected ? 'is-done' : undefined}>
            <div className="ad-steps__title"><span className="ad-steps__n">{connected ? '✓' : '1'}</span>Connect the builder wallet</div>
            {connected ? <div className="ad-mono">{connected.name}: {short(connected.address)}</div> : <WalletPicker onConnected={onConnected} />}
          </li>
          <li>
            <div className="ad-steps__title"><span className="ad-steps__n">2</span>Password, then sign</div>
            <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
              <input
                type="password"
                className="ad-input"
                autoComplete="current-password"
                aria-label="Admin password"
                placeholder="Admin password"
                value={password}
                disabled={!connected || busy}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="submit" className="ad-btn ad-btn--primary" disabled={!connected || !password || busy}>{busy ? 'Signing…' : 'Sign and sign in'}</button>
            </form>
          </li>
        </ol>
        {error && <p className="ad-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
