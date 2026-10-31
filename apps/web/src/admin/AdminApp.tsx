/**
 * The owner's admin suite on dev.valuedesk.so: sign-in, then the pages.
 *
 * The shell is the main app's own: its navbar (styles.css .navbar, .brand with the
 * BrandMark, .navlinks with the active link in --text, the wallet button and its menu
 * on the right), the pages the Status page's cards - on a white page, so this is never
 * mistaken for the site (owner, 2026-10-31: "a white version for the dev page ... squares
 * in current bg color").
 *
 * Nothing here is a lock - the server is (apps/server/src/routes/admin.ts): no
 * session, no data; no fresh signature, no write. The page asks for the wallet's
 * signature and the password, keeps the session token, and on every write asks
 * the wallet again.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { call, loadSession, onSession, saveSession, type AdminSession } from './api';
import { signAction, signIn, type Connected } from './wallet';
import { WalletContext, WalletPicker } from './WalletPicker';
import { isUserRejection } from '../wallet';
import { BrandMark } from '../components/BrandMark';
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
  { id: 'audit', label: 'Audit', render: () => <Audit /> },
];

/** #/tickets/12 -> ['tickets', '12']. */
function routeOf(hash: string): [string, string] {
  const [page = 'overview', arg = ''] = hash.replace(/^#\/?/, '').split('/');
  return [PAGES.some((p) => p.id === page) ? page : 'overview', arg];
}

function Wordmark() {
  return (
    <span className="brand">
      <BrandMark />
      ValueDesk
      <span className="ad-devtag">Dev</span>
    </span>
  );
}

export function AdminApp() {
  const [session, setSession] = useState<AdminSession | null>(() => loadSession());
  const [connected, setConnected] = useState<Connected | null>(null);
  const [route, setRoute] = useState(() => routeOf(location.hash));
  const [asking, setAsking] = useState(false);
  const waiters = useRef<Array<{ ok: (c: Connected) => void; no: (e: Error) => void }>>([]);

  useEffect(() => onSession(setSession), []);
  useEffect(() => {
    const on = () => {
      setRoute(routeOf(location.hash));
      scrollTo({ top: 0 });
    };
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
    for (const w of waiters.current.splice(0)) (c ? w.ok(c) : w.no(new Error('No wallet was connected.')));
  };

  if (!session) return <SignIn onConnected={setConnected} connected={connected} />;

  const [page, arg] = route;
  return (
    <WalletContext.Provider value={{ connected, ensure }}>
      <div className="ad-root">
        <header className="navbar ad-navbar">
          <div className="navbar-inner">
            <a href="#/overview" className="ad-brandlink" aria-label="Overview"><Wordmark /></a>
            <nav className="navlinks">
              {PAGES.map((p) => (
                <a key={p.id} href={`#/${p.id}`} className={`navlink${p.id === page ? ' active' : ''}`} aria-current={p.id === page ? 'page' : undefined}>{p.label}</a>
              ))}
            </nav>
            <div className="navstatus">
              <SessionMenu session={session} connected={connected} ensure={ensure} />
            </div>
          </div>
        </header>
        <main className="ad-main">{PAGES.find((p) => p.id === page)!.render(arg)}</main>
      </div>
      {asking && (
        <div className="ad-modal" role="dialog" aria-modal="true" aria-label="Connect the builder wallet">
          <div className="ad-modal__card">
            <h2>Sign this change with the builder wallet</h2>
            <p>Every change needs a fresh signature from {short(session.wallet)}.</p>
            <WalletPicker wantAddress={session.wallet} onConnected={settle} />
            <button type="button" className="ad-btn" onClick={() => settle(null)}>Cancel</button>
          </div>
        </div>
      )}
    </WalletContext.Provider>
  );
}

/** The navbar's wallet button, as on the site: the address; its menu the session and signing out. */
function SessionMenu({ session, connected, ensure }: { session: AdminSession; connected: Connected | null; ensure: () => Promise<Connected> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('mousedown', away);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('mousedown', away);
      removeEventListener('keydown', key);
    };
  }, [open]);
  const signOut = () => void call('signout').catch(() => null).finally(() => saveSession(null));
  const everywhere = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await ensure();
      const action = await signAction(c, 'sessions.revoke', 'all sessions', {}, 'Sign every admin session out, this one too');
      await call('sessions/revoke', { action });
      saveSession(null);
    } catch (e) {
      setError(isUserRejection(e) ? 'You declined - nothing changed.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="navaddr" ref={box}>
      <button type="button" className="navbtn navaddr__btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ad-livedot" aria-hidden="true" />
        {short(session.wallet)}
      </button>
      {open && (
        <div className="menu-popup navaddr__menu" role="menu">
          <div className="navaddr__full">{session.wallet}</div>
          <div className="menu-group-label">Session</div>
          <p className="ad-menu-line">Ends in {duration(session.expiresAt - Date.now())}</p>
          <p className="ad-menu-line">{connected ? `Wallet for changes: ${connected.name}` : 'Wallet for changes: asked at the first change'}</p>
          <div className="menu-group">
            <button type="button" role="menuitem" className="menu-row" onClick={signOut}><span className="menu-row__label">Sign out</span></button>
            <button type="button" role="menuitem" className="menu-row" disabled={busy} onClick={() => void everywhere()}>
              <span className="menu-row__label">{busy ? 'Waiting for the signature…' : 'Sign out everywhere'}</span>
              <span className="menu-row__hint">signed</span>
            </button>
          </div>
          {error && <p className="ad-error">{error}</p>}
        </div>
      )}
    </div>
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
    <div className="ad-root">
      <header className="navbar ad-navbar">
        <div className="navbar-inner"><Wordmark /></div>
      </header>
      <main className="ad-main">
        <div className="st ad-page">
          <article className="st-card ad-card--narrow">
            <header className="st-hero is-unknown">
              <svg className="st-hero__icon" viewBox="0 0 20 20" width="36" height="36" aria-hidden="true">
                <circle className="st-hero__shape" cx="10" cy="10" r="8.6" />
                <path className="st-hero__sign" d="M7 9V7.6a3 3 0 0 1 6 0V9M6.4 9h7.2v4.8H6.4z" fill="none" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              <div className="st-hero__text">
                <h1 className="st-hero__title">Sign in</h1>
                <p className="st-hero__line">The builder wallet's signature and the admin password open this suite for 24 hours. Each change you make asks the wallet again.</p>
              </div>
            </header>
            <ol className="ad-steps">
              <li className={connected ? 'is-done' : undefined}>
                <div className="ad-steps__title"><span className="ad-steps__n">{connected ? '✓' : '1'}</span>Connect the builder wallet</div>
                {connected ? <div className="ad-mono ad-dim">{connected.name} · {short(connected.address)}</div> : <WalletPicker onConnected={onConnected} />}
              </li>
              <li>
                <div className="ad-steps__title"><span className="ad-steps__n">2</span>Password, then sign</div>
                <form className="ad-signin__form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                  <label className="lbp-search ad-password">
                    <input
                      type="password"
                      autoComplete="current-password"
                      aria-label="Admin password"
                      placeholder="Admin password"
                      value={password}
                      disabled={!connected || busy}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                  <button type="submit" className="ad-btn ad-btn--primary" disabled={!connected || !password || busy}>{busy ? 'Signing…' : 'Sign and sign in'}</button>
                </form>
              </li>
            </ol>
            {error && <p className="ad-error ad-pad-x">{error}</p>}
          </article>
        </div>
      </main>
    </div>
  );
}
