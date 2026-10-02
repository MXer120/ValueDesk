// Headless Chrome over the DevTools Protocol, for the smoke test. No dependencies:
// Node 22+'s global WebSocket and fetch. (The same approach as apps/web/tools/perf,
// kept separate so a deploy gate does not depend on measurement tooling.)
//
// Chrome is found at CHROME_PATH, else at the usual place for the platform.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = {
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = (CANDIDATES[platform()] ?? []).find((p) => existsSync(p));
  if (!found) throw new Error('Chrome was not found: set CHROME_PATH');
  return found;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Headless Chrome with a throwaway profile (no extensions, no wallet, nothing of
 * the user's), driven over CDP on `port`.
 *
 * `offline: true` makes every host but loopback unresolvable: the browser can
 * load the site from 127.0.0.1 and nothing else leaves the machine. The policy
 * checks still work - a request the CSP refuses is refused before any lookup.
 */
export async function launchChrome({ port, width = 1600, height = 1000, offline = false, extraArgs = [] }) {
  const userDir = mkdtempSync(join(tmpdir(), 'vs-smoke-chrome-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--metrics-recording-only', '--mute-audio', '--hide-scrollbars',
    `--window-size=${width},${height}`,
    ...(offline ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(chromePath(), args, { stdio: 'ignore' });
  let exited = false;
  proc.once('exit', () => { exited = true; });
  let version;
  for (let i = 0; i < 150 && !exited; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!version) {
    try { proc.kill(); } catch { /* already gone */ }
    throw new Error(`Chrome did not start on port ${port} (${chromePath()})`);
  }
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  return {
    cdp,
    pid: proc.pid,
    version: version.Browser,
    async close() {
      try { await cdp.send('Browser.close'); } catch { /* already closing */ }
      cdp.close();
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
      if (!exited) { try { proc.kill(); } catch { /* gone */ } }
      await sleep(200);
      try { rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a locked profile file: the OS temp cleaner takes it */ }
    },
  };
}

export class CDP {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to Chrome')); });
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
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
        else p.res(m.result);
        return;
      }
      for (const key of [`${m.sessionId ?? ''}|${m.method}`, `*|${m.method}`]) {
        for (const fn of [...(this.listeners.get(key) ?? [])]) fn(m.params, m.sessionId);
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.rej(new Error(`${p.method}: the connection to Chrome closed`));
      this.pending.clear();
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(id);
        rej(e);
      }
    });
  }

  /** Listen on one session, or on every session with '*'. Returns the remover. */
  on(method, fn, sessionId = '*') {
    const key = `${sessionId}|${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    return () => this.listeners.get(key)?.delete(fn);
  }

  close() {
    try { this.ws.close(); } catch { /* closed */ }
  }
}

/** One page in the browser's default context, attached with a flat session. */
export async function openPage(cdp, { width = 1600, height = 1000 } = {}) {
  // No width/height here: Chrome only takes a position for a new window. The size is emulated below.
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    sessionId,
    targetId,
    send,
    on: (m, fn) => cdp.on(m, fn, sessionId),
    async close() {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* gone */ }
    },
  };
}

/**
 * Attach to every shared worker from now on. The exchange sockets live in a
 * SharedWorker, which is a browser-level target: a page session never sees its
 * network or its console. Each worker is held at its first line until
 * `onAttach(session)` has subscribed, so nothing it does on start is missed.
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
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'shared_worker' }],
  });
  return async () => {
    off();
    await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  };
}

export async function evaluate(session, expression, awaitPromise = true) {
  const r = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** Ctrl+K (Cmd+K on a Mac keyboard maps to the same handler). */
export async function pressCtrlK(page) {
  const key = { modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75 };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

export async function typeText(page, text) {
  for (const ch of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(40);
  }
}
