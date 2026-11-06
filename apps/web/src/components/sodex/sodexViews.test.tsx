/**
 * The designed states, as markup: the locked section and the wallet's boxes, from plain data.
 * Nothing here touches a wallet or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { installViteStubs, staticMarkup } from '../macro/testEnv';
import { SODEX_SIGNIN_LIVE, SODEX_SITE } from '../../sodexProgrammes';

installViteStubs();
const { LockedSection, fmtLeft, fmtTokens, fmtUsdTight } = await import('./parts');
const { BoxArt, boxArtSrc } = await import('./BoxArt');
const { setNumStyle } = await import('../../numStyle');
const { WalletBoxesView } = await import('./BoxVault');
const toMarkup = await staticMarkup();
const render = async (el: ReactElement): Promise<string> => toMarkup(el);

test('locked: says what is unavailable and leads somewhere real, with no legal sentence', async () => {
  assert.equal(SODEX_SIGNIN_LIVE, false);
  const html = await render(<LockedSection title="Your progress" items={['Draw tickets and history']} href={SODEX_SITE.blindBox} hrefLabel="Open on SoDEX" />);
  assert.match(html, /Your progress/);
  assert.match(html, /cannot be read here yet/);
  assert.match(html, /Draw tickets and history/);
  assert.match(html, /href="https:\/\/sodex\.com\/blind-box"/);
  assert.doesNotMatch(html, /<button/, 'no dead button');
  assert.doesNotMatch(html, /not affiliated|powered by|disclaimer/i);
});

test('boxes: exact shows ids and tiers, nothing to open or merge', async () => {
  const html = await render(<WalletBoxesView boxes={{ count: 3, exact: true, byLevel: { Common: ['7', '8'], Uncommon: [], Rare: ['9'], SuperRare: [] } }} />);
  assert.match(html, /#7/);
  assert.match(html, /#9/);
  assert.match(html, /Rare/);
  assert.doesNotMatch(html, /Merge|Select|Claim/);
  assert.doesNotMatch(html, />Open/);
});

test('boxes: not exact shows the count and says why, with no id or tier', async () => {
  const html = await render(<WalletBoxesView boxes={{ count: 5, exact: false, byLevel: { Common: [], Uncommon: [], Rare: [], SuperRare: [] } }} />);
  assert.match(html, />5</);
  assert.match(html, /only the count/);
  assert.doesNotMatch(html, /#\d/);
  assert.doesNotMatch(html, /SuperRare/);
});

test('boxes: none is an empty state', async () => {
  const html = await render(<WalletBoxesView boxes={{ count: 0, exact: true, byLevel: { Common: [], Uncommon: [], Rare: [], SuperRare: [] } }} />);
  assert.match(html, /No boxes in this wallet/);
});

test('boxes: a long tier folds', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1));
  const html = await render(<WalletBoxesView boxes={{ count: 30, exact: true, byLevel: { Common: ids, Uncommon: [], Rare: [], SuperRare: [] } }} />);
  assert.match(html, /\+6 more/);
  assert.match(html, /#24/);
  assert.doesNotMatch(html, /#25</);
});

test('fmtLeft and fmtTokens', () => {
  assert.equal(fmtLeft(90_061_000, 0), '1d 01h 01m 01s');
  assert.equal(fmtLeft(0, 5), '00h 00m 00s');
  assert.match(fmtTokens('0.001386'), /0[.,]001386/);
  assert.match(fmtTokens('104.34'), /104[.,]34/);
});

test('fmtUsdTight: whole dollars drop the cents, and the number style of the app decides the marks', () => {
  assert.doesNotMatch(fmtUsdTight('10000.00'), /[.,]00$/);
  assert.match(fmtUsdTight('10.20'), /^\$10[.,]20$/);
  assert.match(fmtUsdTight(8), /^\$8$/);
  void setNumStyle;
});

test('box art: self-hosted, never from the hosts of SoDEX', async () => {
  assert.equal(boxArtSrc('SuperRare'), '/sodex-art/box-superrare.webp');
  const html = await render(<BoxArt level="Rare" size={40} />);
  assert.match(html, /src="\/sodex-art\/box-rare\.webp"/);
  assert.doesNotMatch(html, /sodex\.com|sosovalue/);
});
