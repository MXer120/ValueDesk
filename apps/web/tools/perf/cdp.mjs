// Minimal Chrome DevTools Protocol client and headless Chrome launcher.
// No dependencies: Node 22+'s global WebSocket and fetch.
//
// Chrome is found at CHROME_PATH, else the usual install location for the platform.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME =
  process.env.CHROME_PATH ||
  (platform() === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : platform() === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Headless Chrome with a throwaway profile, driven over CDP on `port`.
 * `software: true` rasterises without the GPU - slower, but deterministic
 * enough for pixel comparisons.
 */
export async function launchChrome({ port = 9333, width = 1920, height = 1080, software = false, extraArgs = [] } = {}) {
  const userDir = mkdtempSync(join(tmpdir(), 'vsperf-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--mute-audio', '--hide-scrollbars',
    '--force-color-profile=srgb', '--font-render-hinting=none',
    `--window-size=${width},${height}`,
    ...(software ? ['--disable-gpu', '--disable-gpu-compositing'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 100; i++) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!ver) throw new Error(`Chrome did not start (${CHROME}); set CHROME_PATH`);
  const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
  return {
    cdp,
    proc,
    async close() {
      try { await cdp.send('Browser.close'); } catch {}
      cdp.close();
      await sleep(500);
      try { proc.kill(); } catch {}
      await sleep(300);
      try { rmSync(userDir, { recursive: true, force: true }); } catch {}
    },
  };
}

export class CDP {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new CDP(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result);
        }
        return;
      }
      for (const k of [`${m.sessionId || ''}|${m.method}`, `*|${m.method}`]) {
        const ls = this.listeners.get(k);
        if (ls) for (const l of [...ls]) l(m.params, m.sessionId);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => this.pending.set(id, { res, rej, method }));
  }
  on(method, fn, sessionId = '*') {
    const key = `${sessionId === '*' ? '*' : sessionId}|${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    return () => this.listeners.get(key)?.delete(fn);
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

/** A browser context of its own: empty HTTP cache and storage. Pass its id to newPage as `context`. */
export async function newContext(cdp) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  return { id: browserContextId, dispose: () => cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}) };
}

/**
 * One page, attached with a flat session - in a fresh browser context (empty cache
 * and storage) unless `context` names one to share (a return visit).
 */
export async function newPage(cdp, { width = 1920, height = 1080, dpr = 1, context } = {}) {
  const browserContextId = context ?? (await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId, width, height });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
  return {
    sessionId,
    targetId,
    browserContextId,
    send,
    on: (m, fn) => cdp.on(m, fn, sessionId),
    async close() {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch {}
      if (!context) { try { await cdp.send('Target.disposeBrowserContext', { browserContextId }); } catch {} }
    },
  };
}

/**
 * The exchange sockets live in a SharedWorker (exchange/ws/link.ts), which is a
 * browser-level target: a page session never sees its network. This attaches to
 * every shared worker started from now on - held at its first line until
 * `onAttach(session)` has subscribed, so nothing it does on start is missed.
 * Returns a function that stops watching.
 */
export async function watchSharedWorkers(cdp, onAttach) {
  const off = cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo.type !== 'shared_worker') return;
    const session = {
      sessionId,
      url: targetInfo.url,
      send: (m, p) => cdp.send(m, p, sessionId),
      on: (m, fn) => cdp.on(m, fn, sessionId),
    };
    try {
      await onAttach(session);
    } catch { /* a worker that is already gone */ } finally {
      if (waitingForDebugger) await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    }
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'shared_worker' }] });
  return async () => {
    off();
    await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  };
}

export async function evaluate(page, expr, awaitPromise = true) {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

/** `--name=value` flags into an object; everything else stays positional. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(a);
  }
  return { flags, positional };
}
