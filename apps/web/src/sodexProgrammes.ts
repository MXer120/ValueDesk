/**
 * The one switch in front of everything that needs a SoDEX sign-in.
 *
 * SODEX'S SIGN-IN IS OFF ON THIS SITE. `sodex.com/auth/v2/*` answers only the origins SoDEX allowlists,
 * and the old way past that (a relay with a forged Origin, server routes/pointsAuth.ts) breaches
 * SoDEX's terms s.5.6, so it stays unregistered. A wallet's SoPoints balance, weeks and squad, and its
 * Blind Box progress, history and draw tickets, need the token that sign-in issues. They are built and
 * tested with mocks, and run only once SoDEX confirms it, best by allowlisting this site.
 *
 * Turning this on is a code change on purpose, and it is the only one needed in the app itself: every
 * call then leaves the browser directly for SoDEX, with no proxy of ours and no header set by hand.
 * It also needs `sodex.com` and `mainnet-lottery.sodex.dev` added to connect-src in index.html, and
 * CORS from both hosts: the lottery host sends none today.
 *
 * Typed `boolean` so the code behind it is checked and not flagged as unreachable.
 */
export const SODEX_SIGNIN_LIVE: boolean = false;

/** SoDEX's own pages, where a locked section can actually be used today. */
export const SODEX_SITE = {
  points: 'https://sodex.com/points',
  blindBox: 'https://sodex.com/blind-box',
  wealth: 'https://sodex.com/wealth',
} as const;

/** Thrown by anything that would use the SoDEX sign-in while it is off. */
export class SodexSigninOff extends Error {
  constructor() {
    super("SoDEX's sign-in is not available on this site.");
    this.name = 'SodexSigninOff';
  }
}

/** The guard every token call goes through. `live` is a test seam; no app code passes it. */
export function assertSigninLive(live: boolean = SODEX_SIGNIN_LIVE): void {
  if (!live) throw new SodexSigninOff();
}
