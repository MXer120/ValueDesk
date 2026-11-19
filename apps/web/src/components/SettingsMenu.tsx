/**
 * Settings: the wallet menu, More without a wallet, or the gear on a phone open one window in the
 * middle of the screen, its sections down the left (owner, 2026-10-25: "in the
 * middle, completely redesigned, sections").
 *
 *   Privacy     hide my data - what, and how it is hidden
 *   Layout      lock the trade page's panels, edit them
 *   Trading     which trades ask first (components/TradeConfirm.tsx), each on or off
 *   Security    this browser's trading key: its state, a password or passkey lock
 *               on it (trading/keyLock.ts), auto-lock, a check before money moves
 *   News        the News widget's sources, each on or off, and its SoSoValue credit
 *   Players     the consents for the Live Feed's and Fed live's players
 *   Legal       the legal pages
 *   Help & FAQ  answers to the common questions, and Send feedback (feedback/HelpSection.tsx)
 *
 * The gear carries a dot while anything is hidden: a half-on privacy mode that
 * looks off is how you screenshot your balance believing it was covered.
 *
 * The layout rows talk to the mounted Dashboard by window event - it owns
 * `locked` and its layout menu, and is not a descendant of the header. On a page
 * without a movable layout they are shown disabled.
 *
 * This module is the gear, the badge and the open state; the window and its sections are SettingsWindow.tsx, a
 * chunk of its own fetched after the page's load event (and on a press of the gear), so it opens at once.
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { Guarded } from './ErrorBoundary';
import { PrefsIcon } from './PrefsIcon';
import { usePrivacy } from '../privacy';
import { SETTINGS_EVENT, type SettingsSection } from '../settingsBus';
import { markProfileSeen, profileSeen } from '../onboarding/model';
import { useUsername } from '../onboarding/profile';
import { useReferral, useReferralKnown } from '../onboarding/referral';
import { lazyPage } from '../lazyPage';
import { prefetchAfterLoad } from '../afterLoad';
import type { SettingsWindowProps } from './SettingsWindow';
import './SettingsMenu.css';

const Window = lazyPage<SettingsWindowProps>('settings', () => import('./SettingsWindow').then((m) => m.SettingsWindow));

type Section = SettingsSection;

const PROFILE_SEEN_EVENT = 'vs:profile-seen';

/** What Settings has to say while closed: Profile is waiting (green dot), or some figures are hidden. */
export function useSettingsBadge(address: string | null): { profile: boolean; anyHidden: boolean } {
  const { anyHidden } = usePrivacy();
  const username = useUsername(address);
  const referral = useReferralKnown(address);
  const [, seen] = useState(0);
  useEffect(() => {
    const onSeen = () => seen((n) => n + 1);
    window.addEventListener(PROFILE_SEEN_EVENT, onSeen);
    return () => window.removeEventListener(PROFILE_SEEN_EVENT, onSeen);
  }, []);
  /* A wallet with no username, or no referral yet, until it has opened Profile once. */
  const wants = !!address && (username === null || referral === 'none' || referral === 'pending');
  return { profile: wants && !profileSeen(address!), anyHidden };
}

/** With `trigger` off only the window is here: it opens by openSettings() (the wallet menu, More). */
export function SettingsMenu({ hasLayout, dashLocked, address = null, trigger = true }: { hasLayout: boolean; dashLocked: boolean; address?: string | null; trigger?: boolean }) {
  useReferral(address); // The one that reads it from SoDEX; the badges only look.
  const { profile: dot, anyHidden } = useSettingsBadge(address);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>('profile');
  useEffect(() => {
    if (!open || section !== 'profile' || !address || profileSeen(address)) return;
    markProfileSeen(address);
    window.dispatchEvent(new CustomEvent(PROFILE_SEEN_EVENT));
  }, [open, section, address]);
  const gear = useRef<HTMLButtonElement>(null);
  /* The window is mounted from its first opening on, so it plays its close like any dialog. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => { if (open) setMounted(true); }, [open]);
  /* Its code after the page's load event (and on a press of the gear): an open finds it in. */
  useEffect(() => prefetchAfterLoad(Window.preload), []);

  // Opened at a section from elsewhere (settingsBus.ts: a panel's right-click menu).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const want = (e as CustomEvent<{ section?: Section }>).detail?.section;
      if (want) setSection(want);
      setOpen(true);
    };
    window.addEventListener(SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(SETTINGS_EVENT, onOpen);
  }, []);

  return (
    <div className="privacy settings">
      {trigger && <button
        ref={gear}
        type="button"
        className="navicon settings__btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={dot ? 'Settings, your profile is waiting' : 'Settings'}
        title={dot ? 'Settings - your profile' : anyHidden ? 'Settings - some of your data is hidden' : 'Settings'}
        onPointerDown={() => { void Window.preload().catch(() => {}); }}
        onClick={() => { if (dot) setSection('profile'); setOpen(true); }}
      >
        <PrefsIcon size={20} />
        {dot ? <span className="settings__dot settings__dot--go" aria-hidden="true" /> : anyHidden && <span className="settings__dot" aria-hidden="true" />}
      </button>}

      {(mounted || open) && (
        <Guarded name="Settings" bare>
        <Suspense fallback={null}>
          <Window open={open} onClose={() => setOpen(false)} section={section} setSection={setSection} hasLayout={hasLayout} dashLocked={dashLocked} address={address} gear={gear} />
        </Suspense>
        </Guarded>
      )}
    </div>
  );
}

