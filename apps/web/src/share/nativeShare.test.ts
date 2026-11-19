import test from 'node:test';
import assert from 'node:assert/strict';
import { canShareNative, prefersNativeShare, shareNative } from './nativeShare';

const file = new File([new Uint8Array([1, 2, 3])], 'card.png', { type: 'image/png' });

function fakeNav(opts: { files?: boolean; fail?: string } = {}) {
  const calls: ShareData[] = [];
  return {
    calls,
    nav: {
      share: async (d?: ShareData) => {
        calls.push(d ?? {});
        if (opts.fail) throw new DOMException('x', opts.fail);
      },
      canShare: (d?: ShareData) => !d?.files || !!opts.files,
    } as Pick<Navigator, 'share' | 'canShare'>,
  };
}

test('no sheet: unsupported, so the caller keeps its own buttons', async () => {
  assert.equal(canShareNative(undefined), false);
  assert.equal(await shareNative({ url: 'https://valuedesk.so' }, {} as Navigator), 'unsupported');
  assert.equal(prefersNativeShare({} as Navigator, true), false);
});

test('the sheet comes first on a touch phone only', () => {
  const { nav } = fakeNav();
  assert.equal(prefersNativeShare(nav, true), true);
  assert.equal(prefersNativeShare(nav, false), false, 'a desktop with navigator.share keeps copy first');
});

test('a card goes with its picture where the browser takes files', async () => {
  const { nav, calls } = fakeNav({ files: true });
  assert.equal(await shareNative({ text: 't', url: 'https://valuedesk.so/?ref=A', file }, nav), 'shared');
  assert.deepEqual(calls[0]!.files, [file]);
  assert.equal(calls[0]!.url, 'https://valuedesk.so/?ref=A');
});

test('a browser that takes no files shares the link and says so', async () => {
  const { nav, calls } = fakeNav({ files: false });
  assert.equal(await shareNative({ text: 't', url: 'u', file }, nav), 'shared-text');
  assert.equal(calls[0]!.files, undefined);
});

test('closing the sheet is not a failure; a refusal is', async () => {
  assert.equal(await shareNative({ url: 'u' }, fakeNav({ fail: 'AbortError' }).nav), 'closed');
  assert.equal(await shareNative({ url: 'u' }, fakeNav({ fail: 'NotAllowedError' }).nav), 'failed');
});
