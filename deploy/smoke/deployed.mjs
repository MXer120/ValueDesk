// Checks that only make sense against a DEPLOYED site (smoke.mjs --site=https://...):
// what the real edge sends (CloudFront, or Vercel - deploy/vercel serves the same
// header table), and that the origin behind it serves nobody but the edge. No
// browser; plain requests from this machine.
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { headersFor } from './prod-headers.mjs';

const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const reason = (e) => e?.code ?? e?.cause?.code ?? e?.message ?? String(e);

/**
 * One GET on a connection of its own (no pool: a kept-alive socket that the other
 * side has just closed must not turn into a finding). Redirects are not followed.
 * @returns {Promise<{ status: number, headers: Record<string, string> }>}
 */
function get(url, timeoutMs) {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: 'GET', agent: false, headers: { accept: '*/*', 'user-agent': 'valuedesk-smoke' } },
      (res) => {
        res.resume();
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
        res.once('end', () => ok({ status: res.statusCode ?? 0, headers }));
        res.once('error', fail);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('no answer in time'), { code: 'TIMEOUT' })));
    req.once('error', fail);
    req.end();
  });
}

/**
 * The response headers of the deployed site, path by path, against the table
 * deploy/aws/edge.yaml and the publish script were written from (prod-headers.mjs).
 *
 * @param {string} site   origin, no trailing slash
 * @param {string[]} paths request paths ('/', '/assets/index-abc.js', '/scan/', ...)
 * @returns {Promise<Array<{ path: string, status: number | null, problems: string[] }>>}
 */
export async function checkDeployedHeaders(site, paths) {
  const rows = [];
  for (const path of [...new Set(paths)]) {
    const row = { path, status: null, problems: [] };
    try {
      const r = await get(site + path, 20_000);
      row.status = r.status;
      if (r.status !== 200) row.problems.push(`answered ${r.status}`);
      for (const [name, want] of Object.entries(headersFor(path))) {
        const got = r.headers[name.toLowerCase()];
        if (got === undefined) row.problems.push(`${name} is missing`);
        else if (oneLine(got) !== oneLine(want)) row.problems.push(`${name} is "${oneLine(got).slice(0, 140)}", expected "${oneLine(want).slice(0, 140)}"`);
      }
      const type = r.headers['content-type'] ?? '';
      if (/\.m?js$/.test(path) && !/javascript/.test(type)) row.problems.push(`a script served as "${type}" does not run under nosniff`);
      if (/\.css$/.test(path) && !/text\/css/.test(type)) row.problems.push(`a stylesheet served as "${type}" is not applied under nosniff`);
    } catch (e) {
      row.problems.push(`no answer: ${reason(e)}`);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * http:// must only ever redirect to https:// (CloudFront: redirect-to-https).
 * @returns {Promise<{ ok: boolean, note: string }>}
 */
export async function checkHttpsRedirect(site) {
  const u = new URL(site);
  if (u.protocol !== 'https:') return { ok: true, note: 'the site is not https: not checked' };
  try {
    const r = await get(`http://${u.host}/trade`, 15_000);
    const to = r.headers.location ?? '';
    if ([301, 302, 307, 308].includes(r.status) && to.startsWith(`https://${u.host}/`)) return { ok: true, note: `http answers ${r.status} -> ${to}` };
    return { ok: false, note: `http://${u.host}/trade answered ${r.status}${to ? ` -> ${to}` : ''}, expected a redirect to https` };
  } catch (e) {
    // Port 80 closed is as good as a redirect.
    return { ok: true, note: `http does not answer (${reason(e)})` };
  }
}

const connects = (host, port, timeoutMs) => new Promise((done) => {
  const s = net.connect({ host, port });
  const end = (state) => { s.destroy(); done(state); };
  s.setTimeout(timeoutMs, () => end('closed (no answer)'));
  s.once('connect', () => end('open'));
  s.once('error', (e) => end(`closed (${reason(e)})`));
});

/**
 * The origin (the instance) as seen from a machine that is NOT the edge.
 *
 * edge 'cloudfront' (deploy/aws/edge.yaml):
 *   - its TLS port must not accept a connection (the security group admits
 *     CloudFront's addresses only);
 * edge 'vercel' (deploy/vercel: the /api function has no fixed addresses, so the
 * security group opens 443 to everyone):
 *   - the TLS port answers, but Caddy must refuse every request that does not carry
 *     the origin secret (deploy/server/caddy/Caddyfile.template): /api/health, an
 *     index route and the copy executor's /api/copy/v1/health asked without it must
 *     not be served;
 * both:
 *   - the API's own port and the copy executor's must not be reachable at all;
 *   - port 80 may answer (Caddy's ACME challenge and its redirect) but must
 *     never serve the API.
 *
 * @param {string} host
 * @param {{ edge?: 'cloudfront' | 'vercel', tlsPort?: number, httpPort?: number, apiPort?: number, executorPort?: number, timeoutMs?: number, tlsScheme?: 'https' | 'http' }} [o]
 *   the ports and tlsScheme are options for tests only
 * @returns {Promise<{ host: string, checks: Record<string, string>, problems: string[] }>}
 */
export async function probeOrigin(host, { edge = 'cloudfront', tlsPort = 443, httpPort = 80, apiPort = 8797, executorPort = 8799, timeoutMs = 6000, tlsScheme = 'https' } = {}) {
  const checks = {};
  const problems = [];
  // A name that does not resolve would read as "closed" on every port: a typo must not pass.
  try {
    checks.address = (await lookup(host)).address;
  } catch (e) {
    checks.address = `does not resolve (${reason(e)})`;
    return { host, checks: { ...checks, tls: 'not asked', api: 'not asked', executor: 'not asked', http: 'not asked' }, problems: [`${host} does not resolve: is --origin the instance's name (ORIGIN_DOMAIN_NAME)?`] };
  }
  checks.tls = await connects(host, tlsPort, timeoutMs);
  if (edge === 'vercel') {
    // Open on purpose; what matters is that nothing passes without the secret.
    for (const [key, path] of [['gateHealth', '/api/health'], ['gateIndex', '/api/vs/leaderboard?venue=hyperliquid&window=1d&limit=1'],
      ['gateCopy', '/api/copy/v1/health']]) {
      try {
        const r = await get(`${tlsScheme}://${host}:${tlsPort}${path}`, timeoutMs + 4000);
        checks[key] = `answers ${r.status} without the secret`;
        if (r.status >= 200 && r.status < 300) {
          problems.push(`${tlsScheme}://${host}:${tlsPort}${path.split('?')[0]} answers ${r.status} without the origin secret: the Caddy gate (X-Origin-Verify) is not in effect`);
        }
      } catch (e) {
        checks[key] = `refused (${reason(e)})`;
      }
    }
  } else if (checks.tls === 'open') {
    problems.push(`${host}:${tlsPort} accepts a connection from this machine: the security group is not limited to CloudFront's prefix list`);
  }
  checks.api = await connects(host, apiPort, timeoutMs);
  if (checks.api === 'open') problems.push(`${host}:${apiPort} is reachable: the API must listen on loopback only and its port must not be in the security group`);
  checks.executor = await connects(host, executorPort, timeoutMs);
  if (checks.executor === 'open') problems.push(`${host}:${executorPort} is reachable: the copy executor must listen on loopback only and its port must not be in the security group`);
  try {
    const r = await get(`http://${host}:${httpPort}/api/health`, timeoutMs + 4000);
    checks.http = `answers ${r.status}${r.headers.location ? ` -> ${r.headers.location}` : ''}`;
    if (r.status === 200) problems.push(`http://${host}:${httpPort}/api/health answers 200: the API is served in clear text on port ${httpPort}`);
  } catch (e) {
    checks.http = `closed (${reason(e)})`;
  }
  return { host, checks, problems };
}
