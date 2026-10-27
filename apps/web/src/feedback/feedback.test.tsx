/**
 * THE GO-LIVE GUARD for "Send feedback" (docs/GO-LIVE.md): the workspace bar -
 * on screen on every page - must render the entry, and the shell must render the
 * bar and the feedback host on every page. Plus the chat's pieces: what a message
 * sends, the thread tokens, the reply announcements, the right-clicked element,
 * the page info, the secret check, the screenshot sizing, Settings' FAQ.
 *
 * Run (from apps/web): npx tsx --test src/feedback/feedback.test.tsx
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { registerTestLoader, renderToMarkup } from '../testRender';

// Stylesheets and Vite's import.meta.env, for Node (testRender.ts).
registerTestLoader();

const WALLET = '0x04fb1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b';
const TOKEN = 'A'.repeat(43);

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
const g = globalThis as unknown as { window?: unknown; localStorage?: Storage };
g.localStorage = memoryStorage();
g.window = Object.assign(new EventTarget(), { localStorage: g.localStorage });

test('go-live: the workspace bar renders "Send feedback" and the status link', async () => {
  const { StatusFooter } = await import('../components/StatusFooter');
  const html = renderToMarkup(
    createElement(StatusFooter, {
      connLabel: 'live', connOk: true, session: null, address: null, health: null,
      onGoToWallet: () => {}, onSessionChanged: () => {}, helpOpen: false, onHelpOpen: () => {},
    }),
  );
  assert.match(html, /data-feedback-entry/, 'the feedback entry is gone from the workspace bar');
  assert.match(html, />Send feedback</);
  assert.match(html, /href="\/status"/, 'the status page link is gone from the workspace bar');
});

test('go-live: the shell renders the workspace bar and the feedback host on every page', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const shell = app.slice(app.indexOf('function AppShell('));
  for (const [tag, guard] of [['<StatusFooter', 'Status footer'], ['<FeedbackHost', 'Feedback']] as const) {
    const at = shell.indexOf(tag);
    assert.ok(at > 0, `App.tsx no longer renders ${tag}>`);
    assert.match(shell.slice(Math.max(0, at - 200), at), new RegExp(`<Guarded name="${guard}">\\s*$`), `${tag}> must be rendered unconditionally`);
  }
});

test('the entry opens the chat by event, from anywhere', async () => {
  const { FeedbackButton, OPEN_FEEDBACK_EVENT, openFeedback } = await import('./FeedbackButton');
  assert.match(renderToMarkup(createElement(FeedbackButton)), /<button [^>]*aria-haspopup="dialog"/);
  const seen: unknown[] = [];
  (g.window as EventTarget).addEventListener(OPEN_FEEDBACK_EVENT, (e) => seen.push((e as CustomEvent).detail));
  openFeedback({ thread: TOKEN });
  assert.deepEqual(seen, [{ thread: TOKEN }]);
});

test('VITE_FEEDBACK_URL (the Discord button): https only, anything else means "coming soon"', async () => {
  const { feedbackUrlFrom } = await import('./feedback');
  assert.equal(feedbackUrlFrom('https://discord.gg/abc'), 'https://discord.gg/abc');
  for (const bad of ['', 'http://discord.gg/abc', 'javascript:alert(1)', 'discord.gg/abc', 'https://user:pw@discord.gg/x', undefined, 42]) {
    assert.equal(feedbackUrlFrom(bad), null, String(bad));
  }
});

test('a message: the token in the header only, the page info and wallet only when chosen', async () => {
  const { sendMessage } = await import('./feedback');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"ok":true,"thread":4}', { status: 200 });
  }) as unknown as typeof fetch;
  const r = await sendMessage(TOKEN, { category: 'bug', message: '  It froze  ', images: [], context: null, wallet: null, website: '' }, ok);
  assert.deepEqual(r, { ok: true, thread: 4 });
  assert.equal(calls[0]!.url, '/api/vs/feedback', 'never a token in the URL');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { category: 'bug', message: 'It froze' });
  await sendMessage(TOKEN, { category: 'idea', message: 'More', images: ['a'.repeat(24)], context: null, wallet: WALLET, website: '' }, ok);
  const sent = JSON.parse(String(calls[1]!.init.body));
  assert.deepEqual([sent.images, sent.wallet], [['a'.repeat(24)], WALLET]);
  assert.ok(!('contact' in sent), 'there is no contact field any more');
});

test('a private key or a seed phrase is never sent: a red sentence instead', async () => {
  const { sendMessage, secretIn } = await import('./feedback');
  let called = false;
  const f = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
  const r = await sendMessage(TOKEN, { category: 'bug', message: `my key ${'ab'.repeat(32)}`, images: [], context: null, wallet: null, website: '' }, f);
  assert.ok(!r.ok && r.secret && /private key/.test(r.error));
  assert.equal(called, false, 'nothing left the browser');
  assert.equal(secretIn('abandon ability able about above absent absorb abstract absurd abuse access accident')?.kind, 'seed-phrase');
  assert.equal(secretIn(`my wallet ${WALLET} shows 0 balance`), null);
  const server = (async () => new Response('{"ok":false,"code":"secret","error":"This message seems to contain a seed phrase."}', { status: 400 })) as unknown as typeof fetch;
  const s = await sendMessage(TOKEN, { category: 'bug', message: 'hello', images: [], context: null, wallet: null, website: '' }, server);
  assert.ok(!s.ok && s.secret);
});

test('threads: random 43-character tokens, kept newest first, replies announced once', async () => {
  const t = await import('./threads');
  const a = t.newToken();
  const b = t.newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  t.rememberThread(a, 'first', 1);
  t.rememberThread(b, 'second', 2);
  assert.deepEqual(t.threads().map((x) => x.token), [b, a]);
  let list = t.threads();
  assert.deepEqual(t.unannounced(list, [{ owner: 0 }, { owner: 2 }]).map((x) => [x.token, x.fresh]), [[a, 2]]);
  t.markNotified(a, 2);
  list = t.threads();
  assert.deepEqual(t.unannounced(list, [{ owner: 0 }, { owner: 2 }]), [], 'announced once');
  assert.deepEqual(t.unannounced(list, [{ owner: 0 }, { owner: 3 }]).map((x) => x.fresh), [1]);
  t.markSeen(b, 5);
  assert.deepEqual(t.unannounced(t.threads(), [{ owner: 5 }, null]), [], 'seen in the open chat: nothing to announce');
  const polled: Array<{ url: string; body: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    polled.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('{"ok":true,"threads":[{"owner":1,"lastOwnerAt":5},null]}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await t.pollThreads([a, b], f), [{ owner: 1, lastOwnerAt: 5 }, null]);
  assert.deepEqual(polled, [{ url: '/api/vs/feedback/poll', body: { tokens: [a, b] } }]);
  assert.deepEqual(await t.pollThreads([], f), [], 'no thread, no request');
  assert.equal(polled.length, 1);
});

/** A fake element tree for describeElement. */
interface FakeEl { tagName: string; id: string; classList: string[]; parentElement: FakeEl | null; getAttribute: (n: string) => string | null; textContent: string }
function el(tag: string, attrs: Record<string, string> = {}, classes: string[] = [], text = '', parent: FakeEl | null = null): FakeEl {
  return { tagName: tag.toUpperCase(), id: attrs.id ?? '', classList: classes, parentElement: parent, getAttribute: (n: string) => attrs[n] ?? null, textContent: text };
}

test('the right-clicked element: a path, its role and label, its panel - no balances, no addresses, no typed text', async () => {
  const { describeElement, elementSummary } = await import('./element');
  const body = el('body');
  const panel = el('div', { 'data-panel': 'positions' }, ['dash-panel', 'is-active'], '', body);
  const row = el('tr', {}, ['acct-row', 'r-9f3a2b1c7d'], '', panel);
  const btn = el('button', { title: 'Close BTC-USD' }, ['mini'], 'Close', row);
  const d = describeElement(btn, '/trade');
  assert.equal(d.path, 'div.dash-panel > tr.acct-row > button.mini');
  assert.deepEqual([d.role, d.label, d.panel], ['button', 'Close BTC-USD', 'positions']);
  assert.equal(elementSummary(d), 'Button “Close BTC-USD” in positions');
  const cell = el('td', {}, [], `Balance 12,345.67 USDC of ${WALLET}`, row);
  const c = describeElement(cell, '/portfolio');
  assert.ok(!c.label!.includes('12,345') && !c.label!.includes(WALLET.slice(2)), c.label!);
  const input = el('input', { placeholder: 'Amount', value: '987654' }, [], '987654', panel);
  assert.equal(describeElement(input, '/trade').label, 'Amount', 'an input is named, its value never read');
});

test('the page info: everything useful, nothing identifying, and the form lists every line', async () => {
  const { buildContext, contextRows, osFamily } = await import('./context');
  const ctx = buildContext({
    pathname: `/scan/${WALLET}`,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2, language: 'de-DE', timeZone: 'Europe/Berlin',
    sockets: 'hub open · perps open', walletConnected: true, modes: ['hosted', 'hosted'], errors: ['0123456789abcdef'],
  }, null);
  assert.deepEqual({ ...ctx, build: 'x' }, {
    route: '/scan/:address', build: 'x', browser: 'safari 18', os: 'macos', viewport: '1440x900', dpr: 2, lang: 'de-DE', timeZone: 'Europe/Berlin',
    sockets: 'hub open · perps open', walletConnected: true, modes: ['hosted'], errors: ['0123456789abcdef'], element: null,
  });
  const rows = Object.fromEntries(contextRows(ctx));
  assert.equal(rows.Wallet, 'connected (address not included)');
  assert.ok(!JSON.stringify(ctx).includes(WALLET.slice(2)));
  assert.equal(osFamily('Mozilla/5.0 (Linux; Android 14)'), 'android');
});

test('screenshots: drawn at most 2560 px on the long side, only image types tried', async () => {
  const { acceptable, fitSize } = await import('./images');
  assert.deepEqual(fitSize(3840, 2160), { w: 2560, h: 1440 });
  assert.deepEqual(fitSize(800, 600), { w: 800, h: 600 });
  assert.equal(acceptable({ type: 'image/png' }), true);
  for (const t of ['image/svg+xml', 'image/gif', 'application/pdf', 'text/html', '']) assert.equal(acceptable({ type: t }), false, t);
});

test('right-click: the browser\'s menu stays where people need it', async () => {
  const { keepNativeMenu } = await import('./FeedbackMenu');
  const target = null;
  assert.equal(keepNativeMenu({ defaultPrevented: true, shiftKey: false, target }, ''), true);
  assert.equal(keepNativeMenu({ defaultPrevented: false, shiftKey: true, target }, ''), true);
  assert.equal(keepNativeMenu({ defaultPrevented: false, shiftKey: false, target }, 'selected words'), true);
  // An element: the browser's menu in fields, on links, in the dashboard (its own menu) and in dialogs.
  const at = (inside: string[]) => ({ closest: (sel: string) => (sel.split(', ').some((s) => inside.includes(s)) ? {} : null) });
  const plain = { defaultPrevented: false, shiftKey: false };
  assert.equal(keepNativeMenu({ ...plain, target: at(['input']) }, ''), true);
  assert.equal(keepNativeMenu({ ...plain, target: at(['a[href]']) }, ''), true);
  assert.equal(keepNativeMenu({ ...plain, target: at(['.dash-scroll']) }, ''), true);
  assert.equal(keepNativeMenu({ ...plain, target: at(['.modal-scrim']) }, ''), true);
  assert.equal(keepNativeMenu({ ...plain, target: at([]) }, ''), false, 'anywhere else: "Send feedback about this"');
});

test('Settings: a Help & FAQ section with Send feedback, and answers that match the code', async () => {
  const menu = readFileSync(new URL('../components/SettingsMenu.tsx', import.meta.url), 'utf8');
  assert.match(menu, /id: 'help', label: 'Help & FAQ'/);
  assert.match(menu, /section === 'help' && <HelpSection/);
  const { FAQ, HelpSection } = await import('./HelpSection');
  assert.match(renderToMarkup(createElement(HelpSection, { close: () => {} })), /Send feedback/);
  const text = FAQ.map((f) => f.a).join('\n');
  const { COPY_FEE_LADDER, COPY_FEE_MAX, COPY_FEE_WINDOW_DAYS } = await import('@copy-engine');
  const bp = (fee: number) => `${fee / 10} bp`;
  for (const step of COPY_FEE_LADDER) assert.ok(text.includes(bp(step.fee)), `the FAQ names the ${bp(step.fee)} step`);
  assert.ok(text.includes(`${(COPY_FEE_MAX / 1000).toFixed(3)}%`), 'the approval ceiling');
  assert.ok(text.includes(`last ${COPY_FEE_WINDOW_DAYS} days`));
  const { CLOSE_ONLY_CODES, SANCTIONED_COUNTRIES } = await import('../legal/jurisdictions.mjs');
  for (const c of SANCTIONED_COUNTRIES) assert.ok(text.includes(c.name), c.name);
  assert.ok(['US', 'GB', 'CA'].every((c) => (CLOSE_ONLY_CODES as readonly string[]).includes(c)));
  assert.match(text, /United States, the United Kingdom and Canada it is close-only/);
  assert.match(text, /2x leverage/);
});
