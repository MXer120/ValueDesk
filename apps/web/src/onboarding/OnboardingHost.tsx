/**
 * Decides whether the first-signup flow opens, holds the account-setup sheets back until it knows,
 * and loads the flow's own chunk only when someone is about to see it.
 *
 * It waits its turn: never over the terms popup (the first visit's), never before the wallet can
 * sign. The Dev panel can open it with openOnboarding.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { browseAccepted, lookedAround, useAcceptanceRevision } from '../legal/acceptance';
import { lazyChunk } from '../lazyPage';
import { setIndexEnabled } from '../setup/indexer';
import type { Eip1193Provider } from '../wallet';
import { decide, markSetupDone, readProgress, setupDoneBefore, writeProgress, type Step } from './model';
import { loadProfile } from './profile';
import { loadReferral } from './referral';

const Onboarding = lazyChunk(() => import('./Onboarding').then((m) => ({ default: m.Onboarding })));

const OPEN_EVENT = 'vd:onboarding';

/** Open the flow from its first step (the Dev panel). */
export function openOnboarding(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export interface OnboardingGate {
  /** Whether the account-setup sheets must wait: the answer is out, or the flow is open. */
  holdSetup: boolean;
  open: { step: Step | null; offerReferral: boolean } | null;
  close: () => void;
}

/** The decision, per wallet. App.tsx reads holdSetup; OnboardingHost below shows the flow. */
export function useOnboardingGate(address: string | null): OnboardingGate {
  const [answered, setAnswered] = useState<string | null>(null);
  const [open, setOpen] = useState<OnboardingGate['open']>(null);
  const addressRef = useRef(address);
  addressRef.current = address;

  useEffect(() => {
    if (!address) {
      setAnswered(null);
      setOpen(null);
      return;
    }
    let dead = false;
    const wallet = address.toLowerCase();
    const progress = readProgress(wallet);
    // Nothing to ask: this browser finished or skipped it, or it was used before the flow existed.
    if (progress?.closed || (!progress && setupDoneBefore())) {
      setAnswered(wallet);
      return;
    }
    setAnswered(null);
    // SoDEX not answering only leaves the referral step out.
    Promise.all([loadProfile(wallet), loadReferral(wallet)]).then(
      ([a, referral]) => {
        if (dead) return;
        const offerReferral = referral === 'none';
        const step = decide({ progress, setupDone: setupDoneBefore(), username: a.username, known: a.known, offerReferral });
        setAnswered(wallet);
        if (step) setOpen({ step, offerReferral });
      },
      () => {
        /* The server did not answer: nobody is stopped at the door over it. Asked again next visit. */
        if (!dead) setAnswered(wallet);
      },
    );
    return () => { dead = true; };
  }, [address]);

  useEffect(() => {
    const on = () => {
      const wallet = addressRef.current;
      if (!wallet) return;
      void loadReferral(wallet).then((referral) => setOpen({ step: null, offerReferral: referral === 'none' }));
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);

  const close = useCallback(() => setOpen(null), []);
  return { holdSetup: !!address && (answered !== address.toLowerCase() || !!open), open, close };
}

export function OnboardingHost({ gate, address, provider, onFinish }: {
  gate: OnboardingGate;
  address: string | null;
  provider: Eip1193Provider | null;
  /** The flow ended on its last step: where the user goes next. */
  onFinish: () => void;
}) {
  useAcceptanceRevision();
  const { open, close } = gate;
  const termsUp = !browseAccepted() && !lookedAround();
  if (!open || !address || termsUp) return null;
  /* A wallet really connected, not one remembered from last visit. */
  if (!provider) return null;
  const end = (finished: boolean) => {
    markSetupDone();
    // What the setup sheets started on a first connect: the wallet's history, read in the background.
    setIndexEnabled(true, address);
    writeProgress(address, { step: open.step ?? 'username', closed: true });
    close();
    if (finished) onFinish();
  };
  return (
    <Suspense fallback={null}>
      <Onboarding startAt={open.step} offerReferral={open.offerReferral} address={address} onEnd={end} />
    </Suspense>
  );
}
