/**
 * The first-signup flow's rules, apart from its screens: which steps, who sees them, what is kept.
 *
 * WHAT COUNTS AS FIRST SIGNUP. A wallet connecting (on ValueDesk the account is the wallet) with:
 *   - no username on the server,
 *   - no trace on the server of having traded through ValueDesk (the builder ledger, `known`),
 *   - and a browser that has never finished account setup (`vs.setup.done`), the mark every browser
 *     used before this flow existed already carries.
 * Anyone else is a returning user and never sees it: they get a green dot on the Settings icon,
 * which leads to Settings > Profile (the username and the referral code live there).
 *
 * WHAT IS KEPT. The username on the server, signed (apps/server/src/profiles). The step reached, or
 * that the flow was finished or skipped, in this browser, per wallet: closing the tab resumes at the
 * same step; Skip ends the flow for good on this browser. Settings > Profile stays open for later.
 */

export const STEPS = ['username', 'referral', 'traders', 'copy', 'heatmap', 'flow', 'overview', 'theme'] as const;
export type Step = (typeof STEPS)[number];

/** The steps for this wallet: no username step once it has a name, no referral step unless the code can apply. */
export const stepsOf = (hasName: boolean, offerReferral: boolean): readonly Step[] =>
  STEPS.filter((s) => (s !== 'username' || !hasName) && (s !== 'referral' || offerReferral));

export interface Progress {
  /** The step to come back to. */
  step: Step;
  /** Finished the last step, or pressed Skip: it never opens by itself again. */
  closed: boolean;
}

const key = (address: string): string => `vs.onboard.v1.${address.toLowerCase()}`;
export const SETUP_DONE_KEY = 'vs.setup.done';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function readProgress(address: string, store: Store | null = local()): Progress | null {
  try {
    const raw = store?.getItem(key(address));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Progress>;
    if (!p || typeof p !== 'object') return null;
    const step = (STEPS as readonly string[]).includes(String(p.step)) ? (p.step as Step) : STEPS[0];
    return { step, closed: p.closed === true };
  } catch {
    return null;
  }
}

export function writeProgress(address: string, p: Progress, store: Store | null = local()): void {
  try {
    store?.setItem(key(address), JSON.stringify(p));
  } catch {
    /* private mode: this tab only */
  }
}

export function setupDoneBefore(store: Store | null = local()): boolean {
  try {
    return store?.getItem(SETUP_DONE_KEY) != null;
  } catch {
    /* no storage at all: do not trap anyone in a flow that cannot remember */
    return true;
  }
}

/**
 * The flow replaces the account-setup sheets for a wallet that went through it: finishing or
 * skipping marks setup done, so one new user does not get two wizards in a row. Indexing starts as
 * it did from those sheets, the layout stays the default, the device probe still runs.
 */
export function markSetupDone(store: Store | null = local()): void {
  try {
    store?.setItem(SETUP_DONE_KEY, '1');
  } catch {
    /* as above */
  }
}

export interface DecideInput {
  progress: Progress | null;
  setupDone: boolean;
  username: string | null;
  known: boolean;
  /** The wallet has no inviter on SoDEX yet (referral.ts). */
  offerReferral: boolean;
}

/** Whether the flow opens by itself for this wallet, and at which step. null: it does not. */
export function decide(i: DecideInput): Step | null {
  if (i.progress?.closed) return null;
  // Started here and not finished: resume, even with the name already taken in that first step.
  const steps = stepsOf(!!i.username, i.offerReferral);
  if (i.progress) return steps.includes(i.progress.step) ? i.progress.step : steps[0]!;
  if (i.setupDone || i.username || i.known) return null;
  return steps[0]!;
}

/** The trader watchlist changed outside the search palette, which reads it again. */
export const WATCHLIST_EVENT = 'vs:watchlist';

const seenKey = (address: string): string => `vs.profile.seen.${address.toLowerCase()}`;

/** Settings > Profile was opened for this wallet: the green dot on the Settings icon has done its job. */
export function profileSeen(address: string, store: Store | null = local()): boolean {
  try {
    return store?.getItem(seenKey(address)) != null;
  } catch {
    return true;
  }
}

export function markProfileSeen(address: string, store: Store | null = local()): void {
  try {
    store?.setItem(seenKey(address), '1');
  } catch {
    /* for this tab only */
  }
}
