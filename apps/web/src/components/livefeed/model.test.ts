import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANNELS, embedUrl, parseStream, readChoice, streamOf } from './model';

test('the server looks up exactly these channels (apps/server/src/valuescan/youtube/live.ts LIVE_CHANNELS)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../server/src/valuescan/youtube/live.ts'), 'utf8');
  const list = /export const LIVE_CHANNELS[^=]*= new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
  const server = [...list.matchAll(/'(UC[A-Za-z0-9_-]{22})'/g)].map((m) => m[1]).sort();
  assert.deepEqual(server, CHANNELS.map((c) => c.youtube).sort());
});

const at = { muted: true, host: 'valuedeskapp.vercel.app' };

test('the owner’s five channels lead the list, each a YouTube channel id', () => {
  assert.deepEqual(CHANNELS.slice(0, 5).map((c) => c.name), ['Bloomberg TV', 'CNBC Television', 'CBS News', 'Yahoo Finance', 'The White House']);
  assert.ok(CHANNELS.every((c) => /^UC[A-Za-z0-9_-]{22}$/.test(c.youtube)));
  assert.equal(new Set(CHANNELS.map((c) => c.id)).size, CHANNELS.length);
});

test('YouTube links: watch, short, live, embed and channel', () => {
  assert.deepEqual(parseStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { kind: 'youtube', video: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseStream('youtu.be/dQw4w9WgXcQ'), { kind: 'youtube', video: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseStream('https://youtube.com/live/dQw4w9WgXcQ?feature=share'), { kind: 'youtube', video: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseStream('https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg'), { kind: 'youtube-live', channel: 'UCIALMKvObZNtJ6AmdCLP7Lg' });
  assert.match((parseStream('https://www.youtube.com/@Bloomberg') as { error: string }).error, /channel ID/);
});

test('Twitch, Kick and Vimeo links; anything else is refused with a reason', () => {
  assert.deepEqual(parseStream('https://www.twitch.tv/Shroud'), { kind: 'twitch', channel: 'shroud' });
  assert.deepEqual(parseStream('twitch.tv/videos/123456'), { kind: 'twitch-video', video: '123456' });
  assert.deepEqual(parseStream('https://kick.com/xQc'), { kind: 'kick', channel: 'xqc' });
  assert.deepEqual(parseStream('https://vimeo.com/76979871'), { kind: 'vimeo', video: '76979871' });
  assert.ok('error' in parseStream('https://example.com/video'));
  assert.ok('error' in parseStream(''));
});

test('embeds start muted; Twitch names this page as its parent; YouTube keeps its own controls and takes no commands', () => {
  const yt = new URL(embedUrl({ kind: 'youtube-live', channel: 'UCIALMKvObZNtJ6AmdCLP7Lg' }, at));
  assert.equal(yt.pathname, '/embed/live_stream');
  assert.equal(yt.searchParams.get('channel'), 'UCIALMKvObZNtJ6AmdCLP7Lg');
  assert.equal(yt.searchParams.get('mute'), '1');
  for (const p of ['enablejsapi', 'origin', 'controls', 'modestbranding', 'iv_load_policy', 'cc_load_policy']) assert.equal(yt.searchParams.get(p), null, p);
  const tw = new URL(embedUrl({ kind: 'twitch', channel: 'shroud' }, { ...at, muted: false }));
  assert.equal(tw.searchParams.get('parent'), 'valuedeskapp.vercel.app');
  assert.equal(tw.searchParams.get('muted'), 'false');
  assert.equal(embedUrl({ kind: 'kick', channel: 'xqc' }, at), 'https://player.kick.com/xqc?autoplay=true&muted=true');
});

test('a stored choice: a known channel, a pasted link, cleared, or the default', () => {
  assert.deepEqual(readChoice({ channel: 'cbs' }), { channel: 'cbs' });
  assert.deepEqual(readChoice({ custom: ' https://kick.com/xqc ' }), { custom: 'https://kick.com/xqc' });
  assert.equal(readChoice(null), null);
  assert.deepEqual(readChoice({ channel: 'nope' }), { channel: 'bloomberg' });
  assert.deepEqual(streamOf({ channel: 'yahoo' }), { kind: 'youtube-live', channel: 'UCEAZeUIeJs0IjQiqTCdVSIg' });
  assert.equal(streamOf({ custom: 'https://example.com' }), null);
});
