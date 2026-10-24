/**
 * Amazon S3 for the knowledge folders' files, without the AWS SDK: Signature
 * Version 4 by hand (node:crypto), credentials from the instance's role.
 *
 *   presignUrl    a link the BROWSER uses for a few minutes: a PUT of exactly
 *                 one upload's bytes (its length is signed), or a GET of one file
 *                 with the type and the attachment disposition S3 must answer with
 *   s3Request     a call from THIS SERVER (HEAD, a ranged GET, PUT, DELETE),
 *                 signed in its Authorization header
 *
 * CREDENTIALS. On the instance: the role attached to it, read through IMDSv2
 * (a session token first, then the role's temporary keys; refreshed five
 * minutes before they expire). For a test against a real bucket from a PC:
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN) in the
 * environment. Nothing here logs a key, a signature or a signed link.
 *
 * Checked against the worked examples of the S3 documentation ("Authenticating
 * Requests: Using Query Parameters" and "...: Using the Authorization Header",
 * test/folders.test.ts).
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ms; absent for long-lived keys. */
  expiresAt?: number;
}

export interface S3Location {
  bucket: string;
  region: string;
  /** Override for tests (an S3 stand-in): scheme://host[:port], path-style. */
  endpoint?: string;
}

const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
export const EMPTY_SHA256 = sha256('');

/** RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** A key's path: every segment encoded, the slashes kept. */
const encPath = (key: string): string => key.split('/').map(enc).join('/');

const stamp = (now: number) => {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20130524T000000Z
  return { amzDate: iso, date: iso.slice(0, 8) };
};

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
}

/** Where a key lives: virtual-hosted style on AWS, path style on a stand-in. */
export function objectUrl(loc: S3Location, key: string): { url: URL; host: string; path: string } {
  if (loc.endpoint) {
    const base = new URL(loc.endpoint);
    const path = `/${enc(loc.bucket)}/${encPath(key)}`;
    return { url: new URL(path, base), host: base.host, path };
  }
  const host = `${loc.bucket}.s3.${loc.region}.amazonaws.com`;
  const path = `/${encPath(key)}`;
  return { url: new URL(`https://${host}${path}`), host, path };
}

const canonicalQuery = (q: Record<string, string>): string =>
  Object.keys(q)
    .sort()
    .map((k) => `${enc(k)}=${enc(q[k]!)}`)
    .join('&');

/**
 * A presigned link. `headers` are signed too and the browser must send them
 * exactly (a PUT's content-length: the one size it may upload). `query` holds
 * S3's response overrides (response-content-type, response-content-disposition).
 */
export function presignUrl(o: {
  method: 'GET' | 'PUT';
  loc: S3Location;
  key: string;
  creds: AwsCredentials;
  expiresIn: number;
  now?: number;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** Tests: the documentation's host. */
  host?: string;
}): string {
  const { amzDate, date } = stamp(o.now ?? Date.now());
  const where = objectUrl(o.loc, o.key);
  const host = o.host ?? where.host;
  const scope = `${date}/${o.loc.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host, ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])) };
  const names = Object.keys(headers).sort();
  const q: Record<string, string> = {
    ...(o.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${o.creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(o.expiresIn),
    'X-Amz-SignedHeaders': names.join(';'),
    ...(o.creds.sessionToken ? { 'X-Amz-Security-Token': o.creds.sessionToken } : {}),
  };
  const canonical = [o.method, where.path, canonicalQuery(q), names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(o.creds.secretAccessKey, date, o.loc.region)).update(toSign).digest('hex');
  const out = new URL(where.url);
  out.search = `${canonicalQuery(q)}&X-Amz-Signature=${signature}`;
  if (o.host) out.host = o.host;
  return out.toString();
}

/** The headers of a server-side request, Authorization included. */
export function signHeaders(o: {
  method: string;
  loc: S3Location;
  key: string;
  creds: AwsCredentials;
  payloadHash: string;
  headers?: Record<string, string>;
  now?: number;
  host?: string;
}): Record<string, string> {
  const { amzDate, date } = stamp(o.now ?? Date.now());
  const where = objectUrl(o.loc, o.key);
  const scope = `${date}/${o.loc.region}/s3/aws4_request`;
  const headers: Record<string, string> = {
    host: o.host ?? where.host,
    'x-amz-content-sha256': o.payloadHash,
    'x-amz-date': amzDate,
    ...(o.creds.sessionToken ? { 'x-amz-security-token': o.creds.sessionToken } : {}),
    ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
  };
  const names = Object.keys(headers).sort();
  const canonical = [o.method, where.path, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), o.payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(o.creds.secretAccessKey, date, o.loc.region)).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.creds.accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}`;
  return headers;
}

/* --------------------------------------------------------- credentials ----- */

const IMDS = 'http://169.254.169.254';

async function withTimeout(url: string, init: RequestInit, ms = 2000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** The instance role's temporary keys, through IMDSv2 (the instance requires tokens). */
export async function credentialsFromImds(): Promise<AwsCredentials> {
  const tok = await withTimeout(`${IMDS}/latest/api/token`, { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' } });
  if (!tok.ok) throw new Error(`IMDS token: HTTP ${tok.status}`);
  const token = await tok.text();
  const h = { 'X-aws-ec2-metadata-token': token };
  const roles = await withTimeout(`${IMDS}/latest/meta-data/iam/security-credentials/`, { headers: h });
  if (!roles.ok) throw new Error(`IMDS: no instance role (HTTP ${roles.status})`);
  const role = (await roles.text()).split('\n')[0]?.trim();
  if (!role) throw new Error('IMDS: no instance role');
  const c = await withTimeout(`${IMDS}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { headers: h });
  if (!c.ok) throw new Error(`IMDS credentials: HTTP ${c.status}`);
  const j = (await c.json()) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string };
  if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error('IMDS credentials: incomplete answer');
  return { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token, expiresAt: j.Expiration ? Date.parse(j.Expiration) : undefined };
}

export function credentialsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): AwsCredentials | null {
  const id = env.AWS_ACCESS_KEY_ID?.trim();
  const secret = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!id || !secret) return null;
  return { accessKeyId: id, secretAccessKey: secret, sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined };
}

/**
 * Keys from the environment, else the instance role; cached until fifteen minutes before they
 * expire - a signed link stops working with the keys it was signed with, and an upload's link
 * lasts ten minutes.
 */
export function credentialSource(o: { env?: Readonly<Record<string, string | undefined>>; fetchImds?: () => Promise<AwsCredentials>; now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  const fixed = credentialsFromEnv(o.env ?? process.env);
  let held: AwsCredentials | null = null;
  let pending: Promise<AwsCredentials> | null = null;
  return async (): Promise<AwsCredentials> => {
    if (fixed) return fixed;
    if (held && (!held.expiresAt || held.expiresAt - now() > 15 * 60_000)) return held;
    pending ??= (o.fetchImds ?? credentialsFromImds)()
      .then((c) => (held = c))
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/* ---------------------------------------------------------------- calls ----- */

export class S3Error extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One signed request from this server. Resolves with the response; a status of 400 or more is an S3Error (404 aside, when allowed). */
export async function s3Request(o: {
  method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
  loc: S3Location;
  key: string;
  creds: AwsCredentials;
  body?: Uint8Array;
  headers?: Record<string, string>;
  allow404?: boolean;
  timeoutMs?: number;
}): Promise<Response> {
  const payloadHash = o.body ? sha256(o.body) : EMPTY_SHA256;
  const headers = signHeaders({ method: o.method, loc: o.loc, key: o.key, creds: o.creds, payloadHash, headers: o.headers });
  const { url } = objectUrl(o.loc, o.key);
  delete headers.host;
  const res = await withTimeout(url.toString(), { method: o.method, headers, body: o.body }, o.timeoutMs ?? 15_000);
  if (res.status >= 400 && !(o.allow404 && res.status === 404)) {
    const text = o.method === 'HEAD' ? '' : (await res.text()).slice(0, 300);
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP ${res.status}`;
    throw new S3Error(res.status, `S3 ${o.method}: ${code}`);
  }
  return res;
}
