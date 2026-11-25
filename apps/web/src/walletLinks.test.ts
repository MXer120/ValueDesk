import test from 'node:test';
import assert from 'node:assert/strict';
import { CONNECT_PARAM, PHONE_WALLETS, autoConnectHere, pageForWallet, setHereOff, walletBrowser, withoutConnectParam } from './walletLinks';

const page = 'https://valuedesk.so/trade?ref=ABC#x';
const link = (key: string) => PHONE_WALLETS.find((w) => w.key === key)!.open!(page);

test('each wallet link is the form its own documentation gives', () => {
  // docs.metamask.io use-deeplinks: https://link.metamask.io/dapp/{dappUrl}, the example without a scheme
  assert.equal(link('metamask'), 'https://link.metamask.io/dapp/valuedesk.so/trade?ref=ABC#x');
  // OKX App Universal Link: https://web3.okx.com/download?deeplink= + enc("okx://wallet/dapp/url?dappUrl=" + enc(url))
  assert.equal(link('okx'), `https://web3.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${encodeURIComponent(page)}`)}`);
  const okx = new URL(link('okx'));
  const inner = new URL(okx.searchParams.get('deeplink')!);
  assert.equal(inner.protocol, 'okx:');
  assert.equal(inner.searchParams.get('dappUrl'), page);
  // Trust deeplinking: https://link.trustwallet.com/open_url?coin_id=60&url=...
  const trust = new URL(link('trust'));
  assert.equal(trust.origin + trust.pathname, 'https://link.trustwallet.com/open_url');
  assert.equal(trust.searchParams.get('coin_id'), '60');
  assert.equal(trust.searchParams.get('url'), page);
  // Bitget deeplink: https://bkcode.vip?action=dapp&url=... (Android takes only the https form)
  const bitget = new URL(link('bitget'));
  assert.equal(bitget.host, 'bkcode.vip');
  assert.equal(bitget.searchParams.get('action'), 'dapp');
  assert.equal(bitget.searchParams.get('url'), page);
});

test('a wallet that documents no link gets none, and says where to paste instead', () => {
  for (const key of ['rabby', 'safepal']) {
    const w = PHONE_WALLETS.find((x) => x.key === key)!;
    assert.equal(w.open, null);
    assert.ok(w.pasteHint && w.pasteHint.length > 10);
  }
});

test('the page handed to a wallet carries the referral this browser keeps (the wallet\'s browser has none of it)', () => {
  assert.equal(new URL(pageForWallet('https://valuedesk.so/trade', 'EDDIE')).searchParams.get('ref'), 'EDDIE');
  assert.equal(new URL(pageForWallet('https://valuedesk.so/trade?ref=ABC', 'EDDIE')).searchParams.get('ref'), 'ABC');
  assert.equal(new URL(pageForWallet('https://valuedesk.so/trade', null)).searchParams.has('ref'), false);
});

test('the page handed to a wallet asks to connect, and the mark comes off again', () => {
  const sent = pageForWallet(page);
  assert.equal(new URL(sent).searchParams.get(CONNECT_PARAM), '1');
  assert.equal(new URL(sent).searchParams.get('ref'), 'ABC');
  assert.equal(withoutConnectParam(sent), '/trade?ref=ABC#x');
  assert.equal(withoutConnectParam(page), null);
  assert.equal(withoutConnectParam('https://valuedesk.so/points?vsConnect=1'), '/points');
});

test('a wallet browser is told apart by what the wallet documents, on a phone only', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 13) Mobile';
  assert.equal(walletBrowser({ ethereum: { isMetaMask: true } }, ua, false), null, 'a desktop extension is not a wallet browser');
  assert.equal(walletBrowser({}, ua, true), null, 'a phone browser with no provider');
  assert.equal(walletBrowser({ ethereum: { isMetaMask: true } }, `${ua} OKApp/6.1`, true)?.key, 'okx');
  assert.equal(walletBrowser({ okxwallet: {}, ethereum: {} }, ua, true)?.key, 'okx');
  assert.equal(walletBrowser({ bitkeep: { ethereum: {} }, ethereum: { isMetaMask: true } }, ua, true)?.key, 'bitget');
  assert.equal(walletBrowser({ ethereum: {} }, `${ua} SafePal/4.0`, true)?.key, 'safepal');
  assert.equal(walletBrowser({ ethereum: { isRabby: true, isMetaMask: true } }, ua, true)?.key, 'rabby');
  assert.equal(walletBrowser({ ethereum: { isTrust: true, isMetaMask: true } }, ua, true)?.key, 'trust');
  assert.equal(walletBrowser({ ethereum: { isMetaMask: true } }, ua, true)?.key, 'metamask');
  const unknown = walletBrowser({ ethereum: {} }, ua, true);
  assert.equal(unknown?.key, null);
  assert.equal(unknown?.label, 'your wallet');
});

test('connecting by itself: once a tab, never after a Disconnect there', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const g = globalThis as unknown as { localStorage: unknown; sessionStorage: unknown };
  g.localStorage = mem();
  g.sessionStorage = mem();
  assert.equal(autoConnectHere(false), false, 'not in a wallet');
  assert.equal(autoConnectHere(true), true);
  assert.equal(autoConnectHere(true), false, 'the same tab does not ask twice');
  g.sessionStorage = mem();
  setHereOff(true);
  assert.equal(autoConnectHere(true), false, 'disconnected here before');
  setHereOff(false);
  assert.equal(autoConnectHere(true), true);
});
