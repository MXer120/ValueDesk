/**
 * Settings: one gear (the rail, or the navbar without it) opens one window in the
 * middle of the screen, its sections down the left (owner, 2026-10-25: "in the
 * middle, completely redesigned, sections").
 *
 *   Privacy     hide my data - what, and how it is hidden
 *   Layout      lock the trade page's panels, edit them
 *   Security    this browser's trading key: its state, a password or passkey lock
 *               on it (trading/keyLock.ts), auto-lock, a check before money moves
 *   News        the News widget's sources, each on or off, and its SoSoValue credit
 *   Players     the consents for the Live Feed's and Fed live's players
 *   Legal       the legal pages
 *
 * The gear carries a dot while anything is hidden: a half-on privacy mode that
 * looks off is how you screenshot your balance believing it was covered.
 *
 * The layout rows talk to the mounted Dashboard by window event - it owns
 * `locked` and its layout menu, and is not a descendant of the header. On a page
 * without a movable layout they are shown disabled.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PrefsIcon } from './PrefsIcon';
import {
  MODE_HINTS, MODE_LABELS, PRIVACY_HINTS, PRIVACY_KEYS, PRIVACY_LABELS,
  PRIVACY_MODES, usePrivacy,
} from '../privacy';
import { Modal } from './Modal';
import { getTradingState, subscribeTrading } from '../trading/session';
import { requestAdvanced, requestDisableTrading, requestEnableTrading } from './account/actions';
import {
  lockNow, passkeySupported, removeLock, setAskOnMoney, setAutoLockMinutes, setPasskeyLock, setPasswordLock, useKeyLock,
  type LockKind,
} from '../trading/keyLock';
import { EMBED_PLATFORMS, EMBED_PROVIDERS, revokeEmbed, useEmbedConsent } from '../legal/embeds';
import { LegalLink } from '../legal/LegalGate';
import { LEGAL_LABELS, LEGAL_PAGES } from '../router';
import { NEWS_SOURCES, logoUrl, useCreditHidden, useNewsSources } from './news/newsSources';
import './SettingsMenu.css';

type Section = 'privacy' | 'layout' | 'security' | 'news' | 'players' | 'legal';
const SECTIONS: Array<{ id: Section; label: string; hint: string; icon: ReactNode }> = [
  { id: 'privacy', label: 'Privacy', hint: 'Hide your figures', icon: <path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5ZM10 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z" /> },
  { id: 'layout', label: 'Layout', hint: 'Panels on the trade page', icon: <><rect x="3" y="3.5" width="14" height="13" rx="2" /><path d="M9 3.5v13M9 9.5h8" /></> },
  { id: 'security', label: 'Security', hint: 'Trading key, lock', icon: <><rect x="4.5" y="9" width="11" height="8" rx="2" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></> },
  { id: 'news', label: 'News', hint: 'Sources', icon: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M6 7.5h5M6 10h8M6 12.5h8" /></> },
  { id: 'players', label: 'Players & cookies', hint: 'Video consents', icon: <><rect x="2.5" y="4.5" width="15" height="11" rx="2" /><path d="m8.5 8 4 2-4 2Z" /></> },
  { id: 'legal', label: 'Legal', hint: 'Terms, privacy, licences', icon: <><path d="M6 3h6l3 3v11H6Z" /><path d="M12 3v3h3M8.5 10h4M8.5 13h4" /></> },
];

const AUTO_LOCK: Array<[number, string]> = [[5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour'], [240, '4 hours'], [0, 'Tab closes']];

export function SettingsMenu({ hasLayout, dashLocked }: { hasLayout: boolean; dashLocked: boolean }) {
  const { anyHidden } = usePrivacy();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>('privacy');
  const gear = useRef<HTMLButtonElement>(null);

  return (
    <div className="privacy settings">
      <button
        ref={gear}
        type="button"
        className="navicon settings__btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Settings"
        title={anyHidden ? 'Settings - some of your data is hidden' : 'Settings'}
        onClick={() => setOpen(true)}
      >
        <PrefsIcon size={20} />
        {anyHidden && <span className="settings__dot" aria-hidden="true" />}
      </button>

      <Modal open={open} title="Settings" onClose={() => setOpen(false)} size="lg" className="stg">
        <div className="stg__body">
          <nav className="stg__nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" className={`stg__tab${section === s.id ? ' is-on' : ''}`} aria-current={section === s.id ? 'page' : undefined} onClick={() => setSection(s.id)}>
                <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{s.icon}</svg>
                <span><b>{s.label}</b><small>{s.hint}</small></span>
              </button>
            ))}
          </nav>
          <div className="stg__pane">
            {section === 'privacy' && <PrivacySection />}
            {section === 'layout' && <LayoutSection hasLayout={hasLayout} dashLocked={dashLocked} gear={gear} close={() => setOpen(false)} />}
            {section === 'security' && <SecuritySection />}
            {section === 'news' && <NewsSection />}
            {section === 'players' && <PlayersSection />}
            {section === 'legal' && <LegalSection />}
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`stg__switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

function Row({ title, line, children, off, icon }: { title: string; line?: ReactNode; children?: ReactNode; off?: boolean; icon?: ReactNode }) {
  return (
    <div className={`stg__row${off ? ' is-off' : ''}`}>
      {icon}
      <span className="stg__rowtext"><b>{title}</b>{line && <small>{line}</small>}</span>
      {children}
    </div>
  );
}

function Head({ title, line }: { title: string; line: string }) {
  return <header className="stg__head"><h3>{title}</h3><p>{line}</p></header>;
}

function PrivacySection() {
  const { hidden, mode, setMode, allHidden, anyHidden, set, setAll, toggle } = usePrivacy();
  return (
    <>
      <Head title="Privacy" line="Hide your own figures for screenshots or a shared screen. Market data stays visible." />
      <div className="stg__card">
        <Row title="Hide my data" line="Balances, positions and your address, in one press">
          <Toggle checked={anyHidden} onChange={() => toggle()} label="Hide my data" />
        </Row>
      </div>
      <div className="stg__label">
        <span>What to hide</span>
        <button type="button" className="stg__link" onClick={() => setAll(!allHidden)}>{allHidden ? 'Show all' : 'Hide all'}</button>
      </div>
      <div className="stg__card">
        {PRIVACY_KEYS.map((k) => (
          <Row key={k} title={PRIVACY_LABELS[k]} line={PRIVACY_HINTS[k]}>
            <Toggle checked={hidden[k]} onChange={(v) => set(k, v)} label={PRIVACY_LABELS[k]} />
          </Row>
        ))}
      </div>
      <div className="stg__label"><span>How</span></div>
      <div className="stg__choices">
        {PRIVACY_MODES.map((m) => (
          <button key={m} type="button" className={`stg__choice${mode === m ? ' is-on' : ''}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
            <span className={`stg__sample is-${m}`} aria-hidden="true">$12,480.55</span>
            <b>{MODE_LABELS[m]}</b>
            <small>{MODE_HINTS[m]}</small>
          </button>
        ))}
      </div>
      <p className="stg__note">Blurred and pixelated hide a <b>generic</b> figure, not yours. Performance charts are not drawn at all, because the shape is the information.</p>
    </>
  );
}

function LayoutSection({ hasLayout, dashLocked, gear, close }: { hasLayout: boolean; dashLocked: boolean; gear: React.RefObject<HTMLButtonElement | null>; close: () => void }) {
  return (
    <>
      <Head title="Layout" line="The trade page's panels: keep them where they are, or arrange them." />
      <div className="stg__card">
        <Row title="Lock layout" line={hasLayout ? 'Panels cannot be moved or resized' : 'This page has no movable layout'} off={!hasLayout}>
          <Toggle checked={hasLayout && dashLocked} disabled={!hasLayout} onChange={() => window.dispatchEvent(new CustomEvent('dash:lock:toggle'))} label="Lock layout" />
        </Row>
        <Row title="Edit layout" line="Show, hide and reset panels" off={!hasLayout}>
          <button
            type="button"
            className="stg__btn"
            disabled={!hasLayout}
            onClick={() => {
              // Anchor the layout menu under the gear; Dashboard clamps it to the viewport.
              const r = gear.current?.getBoundingClientRect();
              close();
              window.dispatchEvent(new CustomEvent('dash:menu', { detail: { x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 } }));
            }}
          >
            Edit…
          </button>
        </Row>
      </div>
    </>
  );
}

const fmtLeft = (ms: number) => {
  const h = Math.max(0, Math.round(ms / 3_600_000));
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`;
};

function SecuritySection() {
  const t = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  const owner = t.owner;
  const lock = useKeyLock(owner);
  const [setting, setSetting] = useState<LockKind | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [passkeys, setPasskeys] = useState<boolean | null>(null);
  useEffect(() => { void passkeySupported().then(setPasskeys).catch(() => setPasskeys(false)); }, []);

  const run = async (f: () => Promise<void>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await f();
      setMsg({ ok: true, text: done });
      setSetting(null);
      setPw('');
      setPw2('');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const enabled = t.status === 'enabled';
  const statusLine = !owner ? 'No wallet connected'
    : t.status === 'enabled' ? `Enabled${t.expiresAt ? ` · renews in ${fmtLeft(t.expiresAt - Date.now())}` : ''}${t.remembered ? ' · remembered on this device' : ' · this tab only'}`
    : t.status === 'restoring' ? 'Opening…'
    : t.status === 'expired' ? 'Expired - enable it again to trade'
    : 'Off on this device';
  const pwOk = pw.length >= 8 && pw === pw2;

  return (
    <>
      <Head title="Security" line="Orders are signed in this browser by a trading key that can never send your funds anywhere but your own account. Lock it so nobody using this computer can trade with it." />
      <div className="stg__card">
        <Row title="Trading key" line={statusLine}>
          {owner && (enabled
            ? <button type="button" className="stg__btn is-danger" onClick={requestDisableTrading}>Turn off</button>
            : <button type="button" className="stg__btn is-go" onClick={requestEnableTrading}>Enable</button>)}
        </Row>
        <Row title="Encrypted on this device" line="Sealed with AES-GCM under a key the browser cannot export" >
          <span className="stg__pill is-ok">On</span>
        </Row>
        <Row title="Advanced keys" line="Create, import or move a key by hand">
          <button type="button" className="stg__btn" disabled={!owner} onClick={requestAdvanced}>Open…</button>
        </Row>
      </div>

      <div className="stg__label"><span>Lock the key</span>{lock.kind !== 'none' && <span className={`stg__pill${lock.unlocked ? ' is-ok' : ''}`}>{lock.unlocked ? 'Unlocked' : 'Locked'}</span>}</div>
      <div className="stg__choices is-three">
        {([
          ['none', 'No lock', 'Opens with the browser'],
          ['password', 'Password', 'Asked to unlock trading'],
          ['passkey', 'Passkey', passkeys === false ? 'Not available in this browser' : 'Face, fingerprint or security key'],
        ] as Array<[LockKind, string, string]>).map(([k, label, line]) => (
          <button
            key={k}
            type="button"
            className={`stg__choice${lock.kind === k ? ' is-on' : ''}${setting === k ? ' is-picking' : ''}`}
            disabled={!owner || busy || (k === 'passkey' && passkeys === false)}
            aria-pressed={lock.kind === k}
            onClick={() => {
              setMsg(null);
              if (k === lock.kind) { setSetting(null); return; }
              if (k === 'none') void run(() => removeLock(owner!), 'The lock is off.');
              else if (k === 'passkey') void run(() => setPasskeyLock(owner!), 'Passkey lock on. Trading asks for it to unlock.');
              else setSetting('password');
            }}
          >
            <b>{label}</b>
            <small>{line}</small>
          </button>
        ))}
      </div>
      {setting === 'password' && owner && (
        <form className="stg__card stg__form" onSubmit={(e) => { e.preventDefault(); if (pwOk) void run(() => setPasswordLock(owner, pw), 'Password lock on. Trading asks for it to unlock.'); }}>
          <label>New password<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" /></label>
          <label>Repeat it<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          <p className="stg__note">It never leaves this browser and cannot be recovered: forgotten, you turn trading off and enable it again with your wallet.</p>
          <div className="stg__actions">
            <button type="button" className="stg__btn" onClick={() => setSetting(null)}>Cancel</button>
            <button type="submit" className="stg__btn is-go" disabled={!pwOk || busy}>Set password</button>
          </div>
        </form>
      )}
      {msg && <p className={`stg__msg${msg.ok ? ' is-ok' : ' is-err'}`} role="status">{msg.text}</p>}

      <div className="stg__card">
        <Row title="Auto-lock" line="Lock again after this long without trading" off={lock.kind === 'none'}>
          <select className="stg__select" value={lock.autoLockMinutes} disabled={lock.kind === 'none'} onChange={(e) => setAutoLockMinutes(Number(e.target.value))}>
            {AUTO_LOCK.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Row>
        <Row title="Confirm withdrawals and transfers" line="Asks for the lock before your wallet is asked to sign" off={lock.kind === 'none'}>
          <Toggle checked={lock.kind !== 'none' && lock.askOnMoney} disabled={lock.kind === 'none'} onChange={setAskOnMoney} label="Confirm withdrawals and transfers" />
        </Row>
        <Row title="Lock now" line="Until you unlock it again" off={lock.kind === 'none' || !lock.unlocked}>
          <button type="button" className="stg__btn" disabled={!owner || lock.kind === 'none' || !lock.unlocked} onClick={() => owner && lockNow(owner)}>Lock</button>
        </Row>
      </div>
      <p className="stg__note">Withdrawals and transfers are always signed by your wallet too: the lock adds a check here, it does not replace your wallet's.</p>
    </>
  );
}

function NewsSection() {
  const [isOn, setOn] = useNewsSources();
  const [creditHidden, setCreditHidden] = useCreditHidden();
  return (
    <>
      <Head title="News" line="Where the News widget's stories come from. Switched off, a source's stories leave every list." />
      <div className="stg__card">
        {NEWS_SOURCES.map((s) => (
          <Row key={s.id} title={s.name} line={s.line} icon={<img className="stg__logo" src={logoUrl(s.site)} alt="" width={20} height={20} />}>
            <Toggle checked={isOn(s.id)} onChange={(v) => setOn(s.id, v)} label={s.name} />
          </Row>
        ))}
        <Row title="The Kobeissi Letter" line="Posts only on X, which needs X's paid API to read" off icon={<img className="stg__logo" src={logoUrl('thekobeissiletter.com')} alt="" width={20} height={20} />}>
          <span className="stg__pill">Not available</span>
        </Row>
      </div>
      <div className="stg__card">
        <Row title="Powered by SoSoValue" line="The credit under the news">
          <Toggle checked={!creditHidden} onChange={(v) => setCreditHidden(!v)} label="Show the SoSoValue credit" />
        </Row>
      </div>
    </>
  );
}

function PlayersSection() {
  const consent = useEmbedConsent();
  return (
    <>
      <Head title="Players & cookies" line="Video players load only after you allow their platform. Withdraw a consent at any time." />
      <div className="stg__card">
        {EMBED_PLATFORMS.map((p) => {
          const at = consent.allowed[p];
          return (
            <Row key={p} title={EMBED_PROVIDERS[p].name} line={at ? `Allowed ${new Date(at).toLocaleDateString()}` : 'Not allowed'}>
              {at ? <button type="button" className="stg__btn" onClick={() => revokeEmbed(p)}>Withdraw</button> : <span className="stg__pill">Off</span>}
            </Row>
          );
        })}
      </div>
      <p className="stg__note">Everything else is on the <LegalLink page="cookies">Cookies</LegalLink> page.</p>
    </>
  );
}

function LegalSection() {
  return (
    <>
      <Head title="Legal" line="The terms you accepted and how your data is handled." />
      <div className="stg__card stg__links">
        {LEGAL_PAGES.map((p) => (
          <LegalLink key={p} page={p}>
            <span className="stg__linkrow"><b>{LEGAL_LABELS[p]}</b><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
          </LegalLink>
        ))}
      </div>
    </>
  );
}
