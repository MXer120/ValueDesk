/**
 * Signing in to SoDEX with your wallet, behind SODEX_SIGNIN_LIVE (sodexProgrammes.ts: off today).
 *
 * THE PROTOCOL, read out of SoDEX's bundle:
 *
 *     POST sodex.com/auth/v2/nonce   {address, type:'sign_in'}
 *       -> {data:{message, nonce, expiresIn:300}}
 *
 *     personal_sign(message)          <- your wallet, here in the browser
 *
 *     POST sodex.com/auth/v2/verify  {address, message, signature, type:'sign_in'}
 *       -> {data:{accessToken}}
 *
 * The access token is a SoDEX identity JWT, good for about 15 days, and it is the bearer
 * `alpha-biz.sodex.dev/biz/sopoints/*` and `mainnet-lottery.sodex.dev` ask for.
 *
 * STRAIGHT FROM THE BROWSER, OR NOT AT ALL. `sodex.com/auth/v2/*` returns CORS headers only for origins
 * on SoDEX's allowlist. These calls never go through a server of ours and never set an Origin: until
 * SoDEX lists this site they cannot succeed, and while the switch is off they are not even sent.
 */
import { signMessage, type Eip1193Provider } from './wallet';
import { assertSigninLive } from './sodexProgrammes';

const API = 'https://sodex.com/auth/v2';
const AUTH_TIMEOUT_MS = 20_000;

export class PointsAuthError extends Error {}

interface SodexEnvelope<T> {
  code?: number;
  message?: string;
  msg?: string;
  data?: T;
}

/** Test seams: the network, the wallet and the switch. App code passes none of them. */
export interface PointsAuthDeps {
  fetchImpl?: typeof fetch;
  sign?: (provider: Eip1193Provider, address: string, message: string) => Promise<string>;
  live?: boolean;
}

async function post<T>(path: string, body: unknown, deps: PointsAuthDeps): Promise<T> {
  assertSigninLive(deps.live);
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${API}${path}`, {
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

  let j: SodexEnvelope<T> | null = null;
  try {
    j = (await res.json()) as SodexEnvelope<T>;
  } catch {
    /* leave null; the status carries the meaning */
  }

  if (!res.ok) throw new PointsAuthError(j?.message || j?.msg || `SoDEX ${res.status}`);
  /* Their envelope reports failure in the body with a 200 status. */
  if (j?.code !== 0) throw new PointsAuthError(j?.message || j?.msg || `SoDEX code ${j?.code}`);
  return j.data as T;
}

/** Step 1: the exact message SoDEX wants signed. Valid for five minutes. */
export async function fetchSignInMessage(address: string, deps: PointsAuthDeps = {}): Promise<string> {
  const d = await post<{ message?: string }>('/nonce', { address, type: 'sign_in' }, deps);
  if (!d?.message) throw new PointsAuthError('SoDEX returned no message to sign.');
  return d.message;
}

/** Step 2: exchange the signature for the access token. */
export async function verifySignature(
  address: string,
  message: string,
  signature: string,
  deps: PointsAuthDeps = {},
): Promise<string> {
  const d = await post<{ accessToken?: string }>('/verify', { address, message, signature, type: 'sign_in' }, deps);
  if (!d?.accessToken) throw new PointsAuthError('SoDEX accepted the signature but returned no token.');
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
  assertSigninLive(deps.live);
  const message = await fetchSignInMessage(address, deps);
  const signature = await (deps.sign ?? signMessage)(provider, address, message);
  return verifySignature(address, message, signature, deps);
}
