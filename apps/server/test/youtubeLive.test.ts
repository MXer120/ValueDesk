/**
 * The Live Feed's stream lookup through the YouTube Data API. Nothing here calls
 * the network: a fake fetch answers like the API and counts the quota.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIVE_CHANNELS, liveVideo, resetLiveCache } from '../src/valuescan/youtube/live.js';

const BLOOMBERG = 'UCIALMKvObZNtJ6AmdCLP7Lg';
const KEY = 'test-key';

/** A fake Data API: `live` is the set of video ids on air, `uploads` the channel's newest, `search` what search.list finds. */
function fakeApi(o: { live: Set<string>; uploads: string[]; search: string[] }) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.googleapis.com', 'only the Data API, never youtube.com pages');
    assert.equal(url.searchParams.get('key'), KEY);
    const what = url.pathname.split('/').pop()!;
    calls.push(what);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (what === 'videos') {
      const ids = (url.searchParams.get('id') ?? '').split(',');
      return json({ items: ids.map((id) => ({ id, snippet: { liveBroadcastContent: o.live.has(id) ? 'live' : 'none' } })) });
    }
    if (what === 'playlistItems') {
      assert.equal(url.searchParams.get('playlistId'), `UU${BLOOMBERG.slice(2)}`);
      return json({ items: o.uploads.map((videoId) => ({ contentDetails: { videoId } })) });
    }
    if (what === 'search') {
      assert.equal(url.searchParams.get('eventType'), 'live');
      return json({ items: o.search.map((videoId) => ({ id: { videoId } })) });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchImpl };
}

test('a stream among the newest uploads: two cheap calls, then cached', async () => {
  resetLiveCache();
  const api = fakeApi({ live: new Set(['QB5BNdBFujE']), uploads: ['aaaaaaaaaaa', 'QB5BNdBFujE'], search: [] });
  try {
    assert.equal(await liveVideo(BLOOMBERG, KEY, api.fetchImpl), 'QB5BNdBFujE');
    assert.equal(await liveVideo(BLOOMBERG, KEY, api.fetchImpl), 'QB5BNdBFujE');
    assert.deepEqual(api.calls, ['playlistItems', 'videos'], 'one answer per five minutes, no search');
  } finally {
    resetLiveCache();
  }
});

test('a long-running stream older than the uploads: found by search, at most once an hour', async () => {
  resetLiveCache();
  const api = fakeApi({ live: new Set(['LongRun1234']), uploads: ['aaaaaaaaaaa'], search: ['LongRun1234'] });
  try {
    assert.equal(await liveVideo(BLOOMBERG, KEY, api.fetchImpl), 'LongRun1234');
    assert.deepEqual(api.calls, ['playlistItems', 'videos', 'search']);
  } finally {
    resetLiveCache();
  }
});

test('only the Live Feed\'s channels, only with a key; YouTube\'s pages are never asked', async () => {
  resetLiveCache();
  const api = fakeApi({ live: new Set(), uploads: [], search: [] });
  assert.equal(LIVE_CHANNELS.size, 13);
  await assert.rejects(liveVideo('UC0000000000000000000000', KEY, api.fetchImpl), /Live Feed's channels/);
  await assert.rejects(liveVideo('https://evil.example/x', KEY, api.fetchImpl), /Live Feed's channels/);
  await assert.rejects(liveVideo(BLOOMBERG, '', api.fetchImpl), /YOUTUBE_API_KEY/);
  assert.deepEqual(api.calls, []);
  assert.equal(await liveVideo(BLOOMBERG, KEY, api.fetchImpl), null, 'nothing on air');
  resetLiveCache();
});
