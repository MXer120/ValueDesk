/**
 * The Live Feed's stream lookup: a channel's /live page read for the video on
 * air. Nothing here calls the network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { liveVideo, liveVideoIn, resetLiveCache } from '../src/valuescan/youtube/live.js';

const page = (id: string, live: boolean) =>
  `<html><link rel="canonical" href="https://www.youtube.com/watch?v=${id}">${live ? '{"isLive":true}' : '{"isUpcoming":true}'}</html>`;

test('liveVideoIn: the canonical video while it is on air, nothing otherwise', () => {
  assert.equal(liveVideoIn(page('QB5BNdBFujE', true)), 'QB5BNdBFujE');
  assert.equal(liveVideoIn(page('QB5BNdBFujE', false)), null, 'scheduled, not live');
  assert.equal(liveVideoIn('<link rel="canonical" href="https://www.youtube.com/channel/UCYxRlFDqcWM4y7FfpiAN3KQ">'), null);
});

test('liveVideo: one fetch per channel, cached; a bad id never leaves the process', async () => {
  resetLiveCache();
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url));
    return new Response(page('QB5BNdBFujE', true), { status: 200 });
  };
  try {
    assert.equal(await liveVideo('UCIALMKvObZNtJ6AmdCLP7Lg', fetchImpl), 'QB5BNdBFujE');
    assert.equal(await liveVideo('UCIALMKvObZNtJ6AmdCLP7Lg', fetchImpl), 'QB5BNdBFujE');
    assert.deepEqual(urls, ['https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg/live']);
    await assert.rejects(liveVideo('https://evil.example/x', fetchImpl), /channel id/);
    assert.equal(urls.length, 1);
  } finally {
    resetLiveCache();
  }
});
