#!/usr/bin/env node
// deploy/release/vercel-web.mjs - the web built while CI and the servers run, made live in seconds at the end (ship.sh).
//
//   node deploy/release/vercel-web.mjs stage <sha> <owner/repo> <tag>   a STAGED production deployment of <sha>: prints its id
//   node deploy/release/vercel-web.mjs wait <id> [seconds]              until it is built: prints READY | ERROR | CANCELED | BUILDING
//   node deploy/release/vercel-web.mjs promote <id>                     make it the production deployment (no rebuild), checked
//   node deploy/release/vercel-web.mjs discard <id>                     cancel it while it builds, else delete it (never a live one)
//   node deploy/release/vercel-web.mjs trial <sha> <owner/repo>         the one-time check (below); writes the trial mark
//
// WHY (2026-11-09). After the servers, ship.sh pushed main and waited for Vercel's Production build of it: 8-10 minutes
// at the very end of every web release, nothing else running. The build itself needs nothing from the servers - the
// site's settings are committed (deploy/vercel/production.settings, the VITE_* values inlined at build time) - only
// its going LIVE must wait for them (the web calls what the servers run). So ship.sh now asks Vercel for the build
// right after the tag is pushed, as a production deployment that is NOT given the domains (the CLI's
// `vercel deploy --prod --skip-domain`: "staged"), and at the end points www.valuedesk.so at it - Vercel's promote,
// which does not rebuild: the bytes that go live are the ones built.
//
// WHY NOT A PREVIEW. A preview deployment gets the preview environment's variables, and VALUESCAN_ORIGIN_SECRET is
// production-only (deploy/vercel/README.md): a preview's /api answers 503. Vercel promotes a preview by REBUILDING it
// with production's variables (docs: "promote-preview-to-production") - no time saved. A staged PRODUCTION deployment
// is built with production's variables from the start, and its promote is instant.
//
// THE GIT REF. The deployment is of the commit on the branch `ship` (ship.sh pushes it with the tag), not `main`: so it
// is never "main's last deployment" (VERCEL_GIT_PREVIOUS_SHA, deploy/vercel/ignore-build.sh), which would let a
// discarded or never-promoted build make Vercel skip a later build of main. ignore-build.sh builds `ship` always (in the
// main project only). After the promote ship.sh pushes main and the branch `ship-live` at the same commit in one
// atomic push; ignore-build.sh skips main's build when `ship-live` names its commit - it is already live.
//
// THE TRIAL (owner, once): `--skip-domain` is the CLI's; through the API it is `autoAssignCustomDomains: false`. Should
// Vercel ever give the domains to such a deployment anyway, the web would go live before CI or the servers. So ship.sh
// takes this path only after `trial` passed on this laptop: it stages the commit that is ALREADY live (origin/main - if
// it did go live, nothing changes), checks that it got no domain, deletes it and writes ~/.valuescan/vercel-early.ok.
// A ship that still sees a staged deployment with domains assigned deletes the mark and falls back to main's build.
//
// SETTINGS: VERCEL_TOKEN (or the file ~/.valuescan/vercel-token): a Vercel access token of the account (scope: the
// team or account of the project). VERCEL_PROJECT: the project's name or id (default valuedesk). VERCEL_TEAM_ID: when
// the project is a team's. Without a token ship.sh takes main's build as before.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const API = 'https://api.vercel.com';
export const TRIAL_MARK = join(homedir(), '.valuescan', 'vercel-early.ok');
export const STAGE_REF = 'ship';

export function settings(env = process.env) {
  let token = (env.VERCEL_TOKEN ?? '').trim();
  const file = join(homedir(), '.valuescan', 'vercel-token');
  if (!token && existsSync(file)) token = readFileSync(file, 'utf8').trim();
  return { token, project: (env.VERCEL_PROJECT ?? '').trim() || 'valuedesk', team: (env.VERCEL_TEAM_ID ?? '').trim() };
}

/** The body of the staged production deployment of `sha` (POST /v13/deployments). */
export function stageBody({ project, repo, sha, tag }) {
  const [org, name] = String(repo).split('/');
  return {
    name: project,
    project,
    target: 'production',
    // The CLI's --skip-domain: built for production, the domains stay on the deployment that serves them now.
    autoAssignCustomDomains: false,
    gitSource: { type: 'github', org, repo: name, ref: STAGE_REF, sha },
    meta: { shipTag: String(tag ?? ''), shipStaged: '1' },
  };
}

/** One deployment's state for ship.sh: READY | ERROR | CANCELED | BUILDING, and whether domains were given to it. */
export function stateOf(d) {
  const s = String(d?.readyState ?? d?.status ?? '').toUpperCase();
  const state = s === 'READY' ? 'READY' : s === 'ERROR' ? 'ERROR' : s === 'CANCELED' || s === 'DELETED' ? 'CANCELED' : 'BUILDING';
  return { state, aliased: Boolean(d?.aliasAssigned) };
}

export function client({ token, team, fetchImpl = fetch }) {
  const q = (path) => `${API}${path}${team ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(team)}` : ''}`;
  return async (method, path, body) => {
    const r = await fetchImpl(q(path), {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(e?.message ?? e) } }) }));
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j };
  };
}

const why = (r) => `${r.status}${r.body?.error?.message ? `: ${r.body.error.message}` : ''}`;

export async function stage(api, { project, repo, sha, tag }) {
  const r = await api('POST', '/v13/deployments?forceNew=1&skipAutoDetectionConfirmation=1', stageBody({ project, repo, sha, tag }));
  if (!r.ok || !r.body?.id) throw new Error(`Vercel did not create the deployment (${why(r)})`);
  return r.body.id;
}

export async function state(api, id) {
  const r = await api('GET', `/v13/deployments/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`deployment ${id}: ${why(r)}`);
  return stateOf(r.body);
}

export async function waitFor(api, id, { seconds = 900, every = 15, sleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000)) } = {}) {
  let s = { state: 'BUILDING', aliased: false };
  for (let t = 0; ; t += every) {
    s = await state(api, id);
    if (s.state !== 'BUILDING' || t >= seconds) return s;
    await sleep(every);
  }
}

/** Promote, then read the project back until its production deployment IS this one (up to `seconds`). */
export async function promote(api, project, id, { seconds = 90, every = 5, sleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000)) } = {}) {
  const p = await api('GET', `/v9/projects/${encodeURIComponent(project)}`);
  if (!p.ok || !p.body?.id) throw new Error(`project ${project}: ${why(p)}`);
  const r = await api('POST', `/v10/projects/${encodeURIComponent(p.body.id)}/promote/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`Vercel refused the promote (${why(r)})`);
  for (let t = 0; t <= seconds; t += every) {
    const now = await api('GET', `/v9/projects/${encodeURIComponent(p.body.id)}`);
    if (now.ok && now.body?.targets?.production?.id === id) return true;
    await sleep(every);
  }
  throw new Error(`the promote was accepted, but the project's production deployment is not ${id} after ${seconds} s`);
}

/** Never a deployment that serves the site: one with domains is left alone. */
export async function discard(api, id) {
  const s = await state(api, id).catch(() => null);
  if (!s) return 'gone';
  if (s.aliased) return 'kept (it has domains)';
  if (s.state === 'BUILDING') { await api('PATCH', `/v12/deployments/${encodeURIComponent(id)}/cancel`); return 'cancelled'; }
  const r = await api('DELETE', `/v13/deployments/${encodeURIComponent(id)}`);
  return r.ok ? 'deleted' : `not deleted (${why(r)})`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, a, b, c] = process.argv.slice(2);
  const cfg = settings();
  if (!cfg.token) { console.error('no Vercel token (VERCEL_TOKEN, or ~/.valuescan/vercel-token)'); process.exit(2); }
  const api = client(cfg);
  try {
    if (cmd === 'stage' && a && b) console.log(await stage(api, { project: cfg.project, repo: b, sha: a, tag: c }));
    else if (cmd === 'wait' && a) { const s = await waitFor(api, a, { seconds: Number(b ?? 900) }); console.log(`${s.state}${s.aliased ? ' aliased' : ''}`); }
    else if (cmd === 'promote' && a) { await promote(api, cfg.project, a); console.log('promoted'); }
    else if (cmd === 'discard' && a) console.log(await discard(api, a));
    else if (cmd === 'trial' && a && b) {
      const id = await stage(api, { project: cfg.project, repo: b, sha: a, tag: 'trial' });
      console.error(`trial: staged ${id} of ${a.slice(0, 12)} (the commit already live), waiting for its build`);
      const s = await waitFor(api, id, { seconds: 1200 });
      const gone = s.aliased ? 'kept' : await discard(api, id);
      if (s.state === 'READY' && !s.aliased) {
        mkdirSync(join(homedir(), '.valuescan'), { recursive: true });
        writeFileSync(TRIAL_MARK, `${new Date().toISOString()} ${id} ${a}\n`);
        console.log(`trial passed: built, no domain assigned (${gone}); ship.sh now builds the web early (${TRIAL_MARK})`);
      } else {
        rmSync(TRIAL_MARK, { force: true });
        console.log(`trial FAILED: ${s.state}${s.aliased ? ', and Vercel GAVE IT THE DOMAINS (the same commit as before, so the site is unchanged)' : ''}; ship.sh keeps main's build`);
        process.exit(1);
      }
    } else { console.error('usage: node deploy/release/vercel-web.mjs stage <sha> <owner/repo> <tag> | wait <id> [s] | promote <id> | discard <id> | trial <sha> <owner/repo>'); process.exit(2); }
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
