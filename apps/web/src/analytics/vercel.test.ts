/** Vercel Web Analytics / Speed Insights (vercel.ts): production hosts only, consent first, no wallet in a URL. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_HOSTS, SPEED_SAMPLE_RATE, cleanUrl, startVercelInsights } from './vercel';

test('a URL Vercel may see: no wallet address, no query, no hash; nothing without consent', () => {
  const w = '0x04Fb8f9d0d8cd5495aa47e81ca9804cdf32a277d';
  assert.equal(cleanUrl(`https://www.valuedesk.so/trader/${w}?tab=fills#x`, true), 'https://www.valuedesk.so/trader/[wallet]');
  assert.equal(cleanUrl('https://www.valuedesk.so/copy', true), 'https://www.valuedesk.so/copy');
  assert.equal(cleanUrl('https://www.valuedesk.so/copy', false), null);
  assert.equal(cleanUrl('not a url', true), null);
});

test('only the production site, and a sample rate that keeps Speed Insights inside its free tier', () => {
  assert.deepEqual([...PRODUCTION_HOSTS].sort(), ['valuedesk.so', 'www.valuedesk.so']);
  assert.ok(SPEED_SAMPLE_RATE > 0 && SPEED_SAMPLE_RATE <= 0.25);
  // Elsewhere it does nothing at all (no document here: it would throw if it tried to load a script).
  for (const host of ['dev.valuedesk.so', 'beta.valuedesk.so', 'localhost', 'valuescan-git-main.vercel.app']) startVercelInsights(host);
});
