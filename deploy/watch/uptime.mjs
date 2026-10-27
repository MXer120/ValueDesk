#!/usr/bin/env node
// The OFF-BOX watcher: probes the public site from outside both servers and outside
// Vercel (GitHub Actions, .github/workflows/uptime.yml), and sends Telegram when
// something goes down and when it is back. It catches what the servers' own health
// checks cannot: both servers dead at once, or the network in front of them.
//
//   node deploy/watch/uptime.mjs --state=<file>     one round: probe, compare with the
//                                                   last round's state, alert, write the state
//   node deploy/watch/uptime.mjs --state=<file> --dry-run   probe and print, send nothing
//
// WHAT (UPTIME_URLS overrides: name=url,name=url):
//   site   https://www.valuedesk.so/                    the web app (Vercel) answers 200
//   api    https://www.valuedesk.so/api/health          Vercel -> server 1's API: {ok:true}
//   copy   https://www.valuedesk.so/api/copy/v1/health  Vercel -> server 1 -> server 2's executor: {ok:true}
// Each is tried up to three times, ten seconds apart, before it counts as down.
//
// ALERTS (TELEGRAM_TOKEN, TELEGRAM_CHAT_ID - repository secrets): when a probe goes
// down, when another one does, every six hours while it stays down, and when all are
// back. The state (what was down since when, the last alert) is one small JSON file the
// workflow keeps between runs with actions/cache. A round that finds something down
// exits 1, so the run is also red in GitHub (and GitHub mails the owner about it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URLS = 'site=https://www.valuedesk.so/,api=https://www.valuedesk.so/api/health,copy=https://www.valuedesk.so/api/copy/v1/health';
const REALERT_MS = 6 * 3600_000;

export function parseUrls(text) {
  return String(text || DEFAULT_URLS).split(',').map((e) => e.trim()).filter(Boolean).map((e) => {
    const i = e.indexOf('=');
    if (i < 1) throw new Error(`UPTIME_URLS: "${e}" is not name=url`);
    const url = e.slice(i + 1).trim();
    if (!/^https:\/\//.test(url)) throw new Error(`UPTIME_URLS: ${url} is not https`);
    return { name: e.slice(0, i).trim(), url };
  });
}

/** One probe with retries: { ok, note }. */
export async function probe({ url }, { attempts = 3, gapMs = 10_000, timeoutMs = 15_000, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let note = '';
  for (let i = 1; i <= attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetchImpl(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'valuedesk-uptime/1 (github actions)' } });
      const type = String(res.headers?.get?.('content-type') ?? '');
      let body = null;
      if (type.includes('json')) body = await res.json().catch(() => null);
      else await res.text().catch(() => '');
      if (res.status !== 200) note = `answered ${res.status}`;
      else if (body && body.ok === false) note = 'answered ok:false';
      else return { ok: true, note: `200 in ${Date.now() - t0} ms${i > 1 ? ` (try ${i})` : ''}` };
    } catch (e) {
      note = e?.name === 'AbortError' ? `no answer in ${timeoutMs / 1000} s` : `unreachable (${e?.cause?.code ?? e?.message ?? e})`;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts) await sleep(gapMs);
  }
  return { ok: false, note: `${note} (${attempts} tries)` };
}

/**
 * From the last state and this round's results: { message | null, next }.
 * Pure, for the tests.
 */
export function decide(prev, results, now) {
  const p = { down: {}, lastAlertAt: 0, ...prev };
  const down = {};
  for (const [name, r] of Object.entries(results)) if (!r.ok) down[name] = p.down[name] ?? now;
  const wasDown = Object.keys(p.down);
  const isDown = Object.keys(down);
  const fresh = isDown.filter((n) => !wasDown.includes(n));
  const back = wasDown.filter((n) => !isDown.includes(n));
  const lines = (names) => names.map((n) => `- ${n}: ${results[n]?.note ?? ''}`).join('\n');
  let message = null;
  let lastAlertAt = p.lastAlertAt;
  if (fresh.length) {
    message = `ValueDesk DOWN (seen from outside, GitHub)\n${lines(isDown)}`;
  } else if (isDown.length && now - p.lastAlertAt > REALERT_MS) {
    const since = Math.min(...isDown.map((n) => down[n]));
    message = `ValueDesk STILL DOWN for ${Math.round((now - since) / 360_000) / 10} h (seen from outside)\n${lines(isDown)}`;
  } else if (!isDown.length && back.length) {
    const since = Math.min(...back.map((n) => p.down[n]));
    message = `ValueDesk UP again (seen from outside): ${back.join(', ')} after ${Math.max(1, Math.round((now - since) / 60_000))} min`;
  } else if (back.length) {
    message = `ValueDesk partly back: ${back.join(', ')} up again; still down:\n${lines(isDown)}`;
  }
  if (message) lastAlertAt = now;
  return { message, next: { down, lastAlertAt, at: now } };
}

async function main() {
  const arg = (n) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
  const stateFile = arg('state') ?? '.uptime-state/state.json';
  const dry = process.argv.includes('--dry-run');
  const targets = parseUrls(process.env.UPTIME_URLS);
  const results = Object.fromEntries(await Promise.all(targets.map(async (t) => [t.name, await probe(t)])));
  for (const [n, r] of Object.entries(results)) console.log(`${r.ok ? 'up  ' : 'DOWN'}  ${n.padEnd(6)} ${r.note}`);
  let prev = {};
  try {
    if (existsSync(stateFile)) prev = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch { /* a damaged state is a fresh start */ }
  const d = decide(prev, results, Date.now());
  let next = d.next;
  if (d.message) {
    console.log(`message: ${d.message.split('\n')[0]}`);
    if (!dry) {
      const { sendTelegram } = await import(pathToFileURL(`${HERE}/../server/bin/telegram.mjs`).href);
      const r = await sendTelegram({ token: (process.env.TELEGRAM_TOKEN ?? '').trim(), chatId: (process.env.TELEGRAM_CHAT_ID ?? '').trim(), text: d.message });
      if (!r.ok) {
        console.error(`uptime: Telegram not sent: ${r.error}`);
        // Not delivered: keep the old state, so the next round tries again.
        next = { ...prev, at: Date.now() };
      }
    }
  }
  if (!dry) {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(next));
  }
  process.exitCode = Object.values(results).every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
