import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faqIndex, faqSearch, nearWord } from './faqSearch.ts';

const ix = faqIndex([
  { id: 'cost', q: 'What do bots cost?', a: '0.2 bp of each order.', k: 'price fee' },
  { id: 'deposit', q: 'Do I deposit money with ValueDesk?', a: 'No. Your funds stay in your own SoDEX account.', k: 'custody safe' },
  { id: 'loss', q: 'How does the loss limit work?', a: 'The bot stops a little before your limit.', k: 'stop loss' },
  { id: 'tab', q: 'Do they keep running when I close the tab?', a: 'Yes, around the clock.', k: 'laptop offline' },
  { id: 'map', q: 'What is the liquidation map?', a: 'Where open positions would be liquidated.', k: 'heatmap' },
]);
const first = (q: string) => faqSearch(ix, q)[0];

test('finds by meaning, stem, beginning and typo; every word counts; nothing for nonsense', () => {
  assert.equal(first('fees'), 'cost');
  assert.equal(first('how expensive are the bots'), 'cost');
  assert.equal(first('is my money safe'), 'deposit');
  assert.equal(first('liqidation'), 'map');
  assert.equal(first('heatm'), 'map');
  assert.equal(first('loss limt'), 'loss');
  assert.equal(first('laptop closed'), 'tab');
  assert.equal(first('comission'), 'cost');
  assert.deepEqual(faqSearch(ix, 'zzzqqq'), []);
  assert.equal(faqSearch(ix, ' ').length, 5);
  assert.ok(nearWord('gird', 'grid') && nearWord('limt', 'limit') && !nearWord('bot', 'tab'));
});
