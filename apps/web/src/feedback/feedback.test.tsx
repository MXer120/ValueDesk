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

test('a message: the key in the header only; its kind, areas and the connected wallet in the body', async () => {
  const { sendMessage } = await import('./feedback');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"ok":true,"thread":4}', { status: 200 });
  }) as unknown as typeof fetch;
  const r = await sendMessage(TOKEN, { category: 'bug', message: '  It froze  ', areas: [], images: [], context: null, wallet: null, website: '' }, ok);
  assert.deepEqual(r, { ok: true, thread: 4 });
  assert.equal(calls[0]!.url, '/api/vs/feedback', 'never a token in the URL');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { category: 'bug', message: 'It froze' });
  await sendMessage(TOKEN, { category: 'idea', areas: ['charts'], message: 'More', images: ['a'.repeat(24)], context: null, wallet: WALLET, website: '' }, ok);
  const sent = JSON.parse(String(calls[1]!.init.body));
  assert.deepEqual([sent.areas, sent.images, sent.wallet], [['charts'], ['a'.repeat(24)], WALLET]);
  assert.ok(!('contact' in sent), 'there is no contact field any more');
});

test('a private key or a seed phrase is never sent: a red sentence instead', async () => {
  const { sendMessage, secretIn } = await import('./feedback');
  let called = false;
  const f = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
  const r = await sendMessage(TOKEN, { category: 'bug', message: `my key ${'ab'.repeat(32)}`, areas: [], images: [], context: null, wallet: null, website: '' }, f);
  assert.ok(!r.ok && r.secret && /private key/.test(r.error));
  assert.equal(called, false, 'nothing left the browser');
  assert.equal(secretIn('abandon ability able about above absent absorb abstract absurd abuse access accident')?.kind, 'seed-phrase');
  assert.equal(secretIn(`my wallet ${WALLET} shows 0 balance`), null);
  const server = (async () => new Response('{"ok":false,"code":"secret","error":"This message seems to contain a seed phrase."}', { status: 400 })) as unknown as typeof fetch;
  const s = await sendMessage(TOKEN, { category: 'bug', message: 'hello', areas: [], images: [], context: null, wallet: null, website: '' }, server);
  assert.ok(!s.ok && s.secret);
});

test("threads: random 43-character tokens, kept newest first; the bell asks only with the wallet's session", async () => {
  const t = await import('./threads');
  const a = t.newToken();
  const b = t.newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  t.rememberThread(a, 'first', null, 1);
  t.rememberThread(b, 'second', null, 2);
  assert.deepEqual(t.threads().map((x) => x.token), [b, a]);
  const polled: Array<{ body: unknown; auth: string | undefined }> = [];
  const f = (async (_url: string, init: RequestInit) => {
    polled.push({ body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
    return new Response('{"ok":true,"wallet":{"owner":1,"lastOwnerAt":5}}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await t.pollWallet('S'.repeat(20), f), { wallet: { owner: 1, lastOwnerAt: 5 } });
  assert.deepEqual(polled, [{ body: {}, auth: `Bearer ${'S'.repeat(20)}` }], 'no browser token goes along');
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
    sockets: 'hub open · perps open', walletConnected: true, online: true, pageAgeS: 42.4, modes: ['hosted', 'hosted'], errors: ['0123456789abcdef'],
  }, null);
  assert.deepEqual({ ...ctx, build: 'x' }, {
    route: '/scan/:address', build: 'x', browser: 'safari 18', os: 'macos', viewport: '1440x900', dpr: 2, lang: 'de-DE', timeZone: 'Europe/Berlin',
    sockets: 'hub open · perps open', walletConnected: true, online: true, pageAgeS: 42, modes: ['hosted'], errors: ['0123456789abcdef'], element: null,
  });
  const rows = Object.fromEntries(contextRows(ctx));
  assert.equal(rows['Wallet connected'], 'yes');
  assert.deepEqual([rows.Online, rows['Page open for']], ['yes', '42 s']);
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

test("Area: several at once, in the list's order, from the server's own list; the button says when one is needed", async () => {
  const { AreaPicker, toggleArea } = await import('./AreaPicker');
  const { FEEDBACK_AREAS } = await import('@sign/ops/feedbackAreas.js');
  assert.deepEqual(toggleArea(['funds'], 'algo'), ['algo', 'funds']);
  assert.deepEqual(toggleArea(['algo', 'funds'], 'algo'), ['funds']);
  const labels = FEEDBACK_AREAS.map((a) => a.label);
  for (const want of ['Layout & UI', 'Algo orders', 'Deposits & withdrawals', 'Wallet connection', 'Other']) assert.ok(labels.includes(want), want);
  const html = renderToMarkup(createElement(AreaPicker, { value: [], onChange: () => {}, required: true, onLayer: () => {} }));
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /Choose at least one/);
  const chosen = renderToMarkup(createElement(AreaPicker, { value: ['charts', 'copy'], onChange: () => {}, required: true, onLayer: () => {} }));
  assert.match(chosen, /Charts, Copy trading/);
  assert.match(chosen, /aria-label="Remove Copy trading"/);
});

test('Send: the form only asks; the warning and the slide are a second window, and only the slide sends', async () => {
  const src = readFileSync(new URL('./FeedbackDialog.tsx', import.meta.url), 'utf8');
  const form = src.slice(src.indexOf('<form'), src.indexOf('</form>'));
  assert.ok(!form.includes('fb-warn'), 'the warning is no longer in the form');
  assert.match(form, /onSubmit=\{[^}]*askToSend\(\)/);
  assert.ok(!/onSubmit=[\s\S]{0,80}send\(\)/.test(form.replace('askToSend', '')), 'submit never sends by itself');
  const confirm = src.slice(src.indexOf('export function SendConfirm'));
  assert.match(confirm, /<b>Never send a private key, a seed phrase, passwords or API keys\.<\/b>/);
  assert.match(confirm, /<SlideConfirm label=\{CONFIRM_LABEL\} tone="sell" onConfirm=\{onConfirm\}/);
  assert.match(src, /<SendConfirm open=\{open && confirming\}[\s\S]{0,80}onConfirm=\{\(\) => void send\(\)\}/);
  const { CONFIRM_LABEL } = await import('./FeedbackDialog');
  assert.equal(CONFIRM_LABEL, 'Slide to confirm: I included no private keys, seed phrases or passwords');
  const { SlideConfirm } = await import('../components/algo/SlideConfirm');
  const slide = renderToMarkup(createElement(SlideConfirm, { label: CONFIRM_LABEL, tone: 'sell', onConfirm: () => {} }));
  assert.match(slide, /role="slider"/);
  assert.ok(slide.includes(CONFIRM_LABEL));
  assert.ok(!src.includes('New conversation'), 'one ongoing chat: no "new conversation"');
});

test('reading: a browser token gets "wallet", an expired sign-in "session" - the form asks for the signature', async () => {
  const { loadThread } = await import('./threads');
  const { sendMessage } = await import('./feedback');
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(await loadThread(TOKEN, answer(401, { ok: false, code: 'wallet' })), { status: 'wallet' });
  assert.deepEqual(await loadThread(TOKEN, answer(401, { ok: false, code: 'session' })), { status: 'session' });
  assert.deepEqual(await loadThread(TOKEN, answer(404, { ok: false })), { status: 'none' });
  assert.deepEqual(await loadThread(TOKEN, answer(200, { ok: true, thread: { wallet: WALLET }, messages: [] })), { status: 'ok', messages: [], wallet: WALLET });
  const r = await sendMessage(TOKEN, { category: 'other', areas: [], message: 'hi', images: [], context: null, wallet: null, website: '' }, answer(401, { ok: false, code: 'session', error: 'x' }));
  assert.ok(!r.ok && r.auth === 'session');
});

test('the chat is always the wallet\'s: no opt-in, sending unsigned with the address, reading only signed in; one token per wallet', async () => {
  const src = readFileSync(new URL('./FeedbackDialog.tsx', import.meta.url), 'utf8');
  assert.ok(!src.includes('Keep chat on wallet'), 'no opt-in button any more');
  assert.match(src, /const key = signedSend \? session!\.token : tokenFor\(sendWallet\)/, 'the session only for its own wallet\'s chat, else the browser token for the address named - no signature asked');
  assert.match(src, /sendMessage\(key, \{ category, areas, message: text, images: ids, context, wallet: sendWallet, website \}\)/, 'with the wallet the form names');
  assert.match(src, /setWalletText\(wallet \?\? ''\)/, 'the field starts as the connected wallet');
  assert.match(src, /loadThread\(session\.token\)/, 'the chat is read with the session only');
  assert.match(src, /we can't reply to this/, 'no wallet: said before sending');
  assert.match(src, /only its owner can read it/, 'another wallet: said before sending');
  const privacy = readFileSync(new URL('../legal/privacy.ts', import.meta.url), 'utf8');
  assert.ok(!privacy.includes('Keep chat on wallet'));
  assert.match(privacy, /Sending needs no signature; reading the conversation and the team\\'s replies does/);
  const t = await import('./threads');
  g.localStorage!.clear();
  const anon = t.tokenFor(null);
  t.rememberThread(anon, 'no wallet', null, 1);
  assert.equal(t.tokenFor(null), anon, 'the same token next time');
  const mine = t.tokenFor(WALLET);
  assert.notEqual(mine, anon, 'a wallet gets its own');
  t.rememberThread(mine, 'with wallet', WALLET, 2);
  assert.equal(t.tokenFor(WALLET.toUpperCase().replace('0X', '0x')), mine);
  assert.equal(t.threads().find((x) => x.token === mine)?.wallet, WALLET);
});

test("wallet sign-in: the wallet signs the feedback statement (the server's check passes), the browser's chat goes along to attach", async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const { privateKeyToAddress, bytesToHex } = await import('@sign/signing/eip712.js');
  const { checkFeedbackSignIn, feedbackSignInDigest } = await import('@sign/ops/feedbackAuth.js');
  const { signInFeedback, heldSession, keepSession } = await import('./session');
  const key = new Uint8Array(32).fill(7);
  const owner = privateKeyToAddress(key).toLowerCase();
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x1';
      assert.equal(method, 'eth_signTypedData_v4');
      const td = JSON.parse(String(params![1])) as { primaryType: string; domain: { name: string; chainId: number }; message: { owner: string; statement: string; nonce: string; issuedAt: string; expiresAt: string } };
      assert.equal(td.primaryType, 'FeedbackSignIn');
      assert.equal(td.domain.name, 'ValueDesk Feedback');
      const sig = secp256k1.sign(feedbackSignInDigest({ ...td.message, chainId: td.domain.chainId }), key, { lowS: true, prehash: false });
      const rsv = new Uint8Array(65);
      // @noble/curves 1.x here (toCompactRawBytes), 2.x on the server (toBytes).
      const s = sig as unknown as { toCompactRawBytes?: () => Uint8Array; toBytes?: (f: string) => Uint8Array; recovery: number };
      rsv.set(s.toCompactRawBytes ? s.toCompactRawBytes() : s.toBytes!('compact'), 0);
      rsv[64] = 27 + s.recovery;
      return bytesToHex(rsv);
    },
  };
  const bodies: Array<{ signIn: unknown; attach?: string }> = [];
  const f = (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as { signIn: unknown; attach?: string };
    bodies.push(b);
    const v = checkFeedbackSignIn(b.signIn);
    return new Response(JSON.stringify(v.ok ? { ok: true, owner, token: `${owner}.${Date.now() + 86_400_000}.0.${'x'.repeat(43)}`, expiresAt: Date.now() + 86_400_000, attached: 'adopted' } : { ok: false, error: v.error }), { status: v.ok ? 200 : 401 });
  }) as unknown as typeof fetch;
  const r = await signInFeedback(provider, owner, TOKEN, f);
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.attached, 'adopted');
  assert.equal(bodies[0]!.attach, TOKEN);
  assert.equal(heldSession(owner)?.token, r.session.token);
  // A session about to run out is not used.
  keepSession(owner, r.session.token, Date.now() + 30_000);
  assert.equal(heldSession(owner), null);
});

test("the bell: replies only through the wallet's session, announced once; without it nothing is asked - only a generic row", async () => {
  const t = await import('./threads');
  const { keepSession, heldSession } = await import('./session');
  const { findNewReplies } = await import('./FeedbackHost');
  const owner = '0x' + '12'.repeat(20);
  g.localStorage!.clear();
  t.rememberThread(t.newToken(), 'sent unsigned', owner, 1);
  let asked = 0;
  const f = (async (_url: string, init: RequestInit) => {
    asked++;
    assert.deepEqual(JSON.parse(String(init.body)), {}, 'no browser token goes along');
    return new Response(JSON.stringify({ ok: true, wallet: { owner: 2, lastOwnerAt: 9 } }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await findNewReplies(owner, f), [], 'not signed in: nothing asked, nothing known');
  assert.equal(asked, 0);
  const session = `${owner}.${Date.now() + 86_400_000}.0.${'y'.repeat(43)}`;
  keepSession(owner, session, Date.now() + 86_400_000);
  const found = await findNewReplies(owner, f);
  assert.deepEqual(found!.map((x) => [x.ref, x.fresh]), [['wallet', 2]]);
  found![0]!.mark();
  assert.equal(heldSession(owner)!.notifiedOwner, 2);
  assert.deepEqual(await findNewReplies(owner, f), [], 'announced once');
  // The unsigned sender's row: fixed words, pushed at send time - never from the chat.
  const src = readFileSync(new URL('./FeedbackDialog.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes("pushNotice({ id: SIGN_IN_NOTICE, kind: 'info', title: 'Feedback sent'"));
  const host = readFileSync(new URL('./FeedbackHost.tsx', import.meta.url), 'utf8');
  assert.ok(!/pollThreads|unannounced/.test(host), 'no token counts any more');
});

test('the dot: one bit per browser token for the connected wallet, no signature, no count', async () => {
  const t = await import('./threads');
  const { findUnread } = await import('./FeedbackHost');
  const owner = '0x' + '34'.repeat(20);
  g.localStorage!.clear();
  const mine = t.newToken();
  t.rememberThread(mine, 'sent unsigned', owner, 1);
  t.rememberThread(t.newToken(), 'another wallet', '0x' + '56'.repeat(20), 2);
  const asked: string[] = [];
  let answer = true;
  const f = (async (url: string, init: RequestInit) => {
    asked.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
    return new Response(JSON.stringify({ ok: true, unread: answer }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await findUnread(owner, f), true);
  assert.deepEqual(asked, [`/api/vs/feedback/unread Bearer ${mine}`], "only this wallet's token, in the header");
  answer = false;
  assert.equal(await findUnread(owner, f), false);
  assert.equal(await findUnread(null, f), false, 'no no-wallet token: nothing asked');
  assert.equal(asked.length, 2);
  t.setUnread(true);
  assert.equal(t.hasUnread(), true);
  t.setUnread(false);
});
