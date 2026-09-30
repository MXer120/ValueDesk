/**
 * Signing in to SoPoints with your wallet.
 *
 * WHAT THIS REPLACES. The points page used to ask you to paste a bearer token
 * copied out of a SoDEX tab, and then briefly asked for the email on your SoDEX
 * account. Both were wrong. SoDEX's own points page signs you in with the WALLET
 * you have connected - connect, press a button, approve one signature - and this
 * is that same flow, run from here.
 *
 * THE PROTOCOL, read out of their bundle (`Tie` in features-*.js):
 *
 *     POST sodex.com/auth/v2/nonce   {address, type:'sign_in'}
 *       -> {data:{message, nonce, expiresIn:300}}
 *
 *     personal_sign(message)          <- your wallet, here in the browser
 *
 *     POST sodex.com/auth/v2/verify  {address, message, signature, type:'sign_in'}
 *       -> {data:{accessToken}}
 *
 * The access token is a SoDEX identity JWT, good for about 15 days, and it is
 * the bearer `alpha-biz.sodex.dev/biz/sopoints/*` asks for. Nothing about it
 * involves an email address: on SoDEX the account IS the wallet.
 *
 * The message reads "Confirm wallet to reveal your SoDEX referral code. No
 * blockchain transaction or gas fee will occur." - their wording, not ours. It
 * is an off-chain signature: it moves nothing and approves no spending.
 *
 * WHY THE TWO CALLS GO THROUGH OUR BACKEND. `sodex.com/auth/v2/*` returns CORS
 * headers only for origins on their allowlist (their domains plus
 * `http://localhost:3000`); every other origin gets no `Access-Control-Allow-
 * Origin` at all, and the browser refuses the response. A server has no such
 * limit, so those two calls are forwarded by our own backend and sign-in works
 * on any port and any domain. See server/src/routes/pointsAuth.ts.
 *
 * NOTE WHAT IS *NOT* PROXIED. The signature is produced here, by your wallet,
 * and the points endpoints on alpha-biz are read straight from the browser -
 * that host reflects any origin. Our backend sees a nonce request and an
 * already-signed message, cannot produce a signature of its own, and stores
 * nothing.
 */
import { signMessage, type Eip1193Provider } from './wallet';

const API = '/api/points/auth';

/**
 * Every other client call in this app is bounded; these two were not.
 *
 * In practice they settle in well under a second - the whole nonce/sign/verify
 * round trip measures ~780ms - so anything approaching this is already a
 * failure, and an unbounded `fetch` is one more way for a button to sit on
 * "Waiting…" with nothing to say. Matches the timeout api.ts uses.
 */
const AUTH_TIMEOUT_MS = 20_000;

export class PointsAuthError extends Error {}

interface SodexEnvelope<T> {
  code?: number;
  message?: string;
  msg?: string;
  data?: T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (e) {
    /* A network refusal, a CSP block and a timeout all land here - none of them
       reach a status code, and the timeout is the one worth naming, because it
       means the request went out and nothing came back. */
    const err = e as Error;
    throw new PointsAuthError(
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `The sign-in service did not answer within ${AUTH_TIMEOUT_MS / 1000}s.`
        : `Could not reach the sign-in service: ${err.message}`,
    );
  }

  let j: SodexEnvelope<T> | null = null;
  try {
    j = (await res.json()) as SodexEnvelope<T>;
  } catch {
    /* leave null; the status carries the meaning */
  }

  if (!res.ok) throw new PointsAuthError(j?.message || j?.msg || `SoDEX ${res.status}`);
  /* Their envelope reports failure in the body with a 200 status, so the code
     has to be checked separately from the HTTP status. */
  if (j?.code !== 0) throw new PointsAuthError(j?.message || j?.msg || `SoDEX code ${j?.code}`);
  return j.data as T;
}

/** Step 1: the exact message SoDEX wants signed. Valid for five minutes. */
export async function fetchSignInMessage(address: string): Promise<string> {
  const d = await post<{ message?: string }>('/nonce', { address });
  if (!d?.message) throw new PointsAuthError('SoDEX returned no message to sign.');
  return d.message;
}

/** Step 2: exchange the signature for the access token. */
export async function verifySignature(
  address: string,
  message: string,
  signature: string,
): Promise<string> {
  const d = await post<{ accessToken?: string }>('/verify', { address, message, signature });
  if (!d?.accessToken) throw new PointsAuthError('SoDEX accepted the signature but returned no token.');
  return d.accessToken;
}

/**
 * The whole thing: nonce, one wallet prompt, token.
 *
 * The address is passed explicitly rather than read back from the provider so
 * that the token can never end up filed under a different account than the one
 * that signed for it - the wallet may have more than one, and `eth_accounts`
 * reports whichever is selected at the moment it is asked.
 */
export async function signInToPoints(
  provider: Eip1193Provider,
  address: string,
): Promise<string> {
  const message = await fetchSignInMessage(address);
  const signature = await signMessage(provider, address, message);
  return verifySignature(address, message, signature);
}
