/**
 * Signing in to SoDEX with your wallet, for your own SoPoints (SODEX_POINTS_SIGNIN_LIVE, on since 2026-11-16).
 *
 * THE PROTOCOL, read out of SoDEX's bundle:
 *
 *     POST sodex.com/auth/v2/nonce   {address, type:'sign_in'}         -> {data:{message, nonce, expiresIn:300}}
 *     personal_sign(message)          <- your wallet, here in the browser
 *     POST sodex.com/auth/v2/verify  {address, message, signature, ...} -> {data:{accessToken}}
 *
 * The two calls go through our server's relay (/api/vs/sodex-auth/*, server routes/pointsAuth.ts), because SoDEX's
 * auth host answers no browser on this origin. The relay passes SoDEX's own sign-in text only ("Confirm wallet to
 * reveal your SoDEX referral code. No blockchain transaction or gas fee will occur."), keeps nothing and answers with
 * the token alone. The token (~15 days at SoDEX) is then used from this browser straight against
 * `alpha-biz.sodex.dev`, which allows this site. It reads points; it cannot move funds - every order, transfer and
 * withdrawal needs the wallet's or an API key's signature.
 */
import { signMessage, type Eip1193Provider } from './wallet';
import { assertPointsSigninLive } from './sodexProgrammes';

const RELAY = '/api/vs/sodex-auth';
const AUTH_TIMEOUT_MS = 20_000;

export class PointsAuthError extends Error {}

/** Test seams: the network, the wallet and the switch. App code passes none of them. */
export interface PointsAuthDeps {
  fetchImpl?: typeof fetch;
  sign?: (provider: Eip1193Provider, address: string, message: string) => Promise<string>;
  live?: boolean;
}

async function post<T extends object>(path: string, body: unknown, deps: PointsAuthDeps): Promise<T> {
  assertPointsSigninLive(deps.live);
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${RELAY}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    throw new PointsAuthError(
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `The sign-in service did not answer within ${AUTH_TIMEOUT_MS / 1000}s.`
        : `Could not reach the sign-in service: ${err.message}`,
    );
  }
  let j = null as ({ ok?: boolean; error?: string } & T) | null;
  try {
    j = (await res.json()) as ({ ok?: boolean; error?: string } & T) | null;
  } catch {
    /* the status carries the meaning */
  }
  if (!res.ok || !j?.ok) throw new PointsAuthError(j?.error || `Sign-in answered ${res.status}`);
  return j;
}

/** Step 1: the exact message SoDEX wants signed. Valid for five minutes. */
export async function fetchSignInMessage(address: string, deps: PointsAuthDeps = {}): Promise<string> {
  const d = await post<{ message?: string }>('/nonce', { address }, deps);
  if (!d.message) throw new PointsAuthError('SoDEX returned no message to sign.');
  return d.message;
}

/** Step 2: exchange the signature for the access token. */
export async function verifySignature(
  address: string,
  message: string,
  signature: string,
  deps: PointsAuthDeps = {},
): Promise<string> {
  const d = await post<{ accessToken?: string }>('/verify', { address, message, signature }, deps);
  if (!d.accessToken) throw new PointsAuthError('SoDEX accepted the signature but returned no token.');
  return d.accessToken;
}

/**
 * The whole thing: nonce, one wallet prompt, token.
 *
 * The address is passed explicitly so the token can never be filed under a different account than the
 * one that signed for it: `eth_accounts` reports whichever is selected at the moment it is asked.
 */
export async function signInToPoints(
  provider: Eip1193Provider,
  address: string,
  deps: PointsAuthDeps = {},
): Promise<string> {
  assertPointsSigninLive(deps.live);
  const message = await fetchSignInMessage(address, deps);
  const signature = await (deps.sign ?? signMessage)(provider, address, message);
  return verifySignature(address, message, signature, deps);
}
