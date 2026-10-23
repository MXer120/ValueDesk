import assert from 'node:assert/strict';
import test from 'node:test';
import { YT, fitVideo, playerBand, readYtMessage, ytCommand } from './ytPlayer';

test('the player’s reports: state and mute from infoDelivery, ready, state changes', () => {
  assert.deepEqual(readYtMessage(JSON.stringify({ event: 'infoDelivery', info: { playerState: 2, muted: true, currentTime: 12 } })), { state: YT.paused, muted: true });
  assert.deepEqual(readYtMessage(JSON.stringify({ event: 'onStateChange', info: 1 })), { state: YT.playing });
  assert.deepEqual(readYtMessage(JSON.stringify({ event: 'onReady', info: null })), { ready: true });
  assert.deepEqual(readYtMessage({ event: 'initialDelivery', info: { playerState: -1 } }), { ready: true, state: YT.unstarted });
});

test('anything else is no report', () => {
  assert.equal(readYtMessage('not json'), null);
  assert.equal(readYtMessage(JSON.stringify({ event: 'infoDelivery', info: { currentTime: 3 } })), null, 'nothing the widget reads');
  assert.equal(readYtMessage(JSON.stringify({ event: 'onStateChange', info: 'x' })), null);
  assert.equal(readYtMessage({ type: 'webpackOk' }), null);
  assert.equal(readYtMessage(null), null);
});

test('a command is the widget protocol’s JSON', () => {
  assert.deepEqual(JSON.parse(ytCommand('unloadModule', ['captions'])), { event: 'command', func: 'unloadModule', args: ['captions'], id: 1, channel: 'widget' });
});

test('a 16:9 picture fits its box, centred, and the band reaches past it', () => {
  assert.deepEqual(fitVideo(1600, 900), { x: 0, y: 0, w: 1600, h: 900 });
  assert.deepEqual(fitVideo(1000, 900), { x: 0, y: 169, w: 1000, h: 563 }, 'a tall box: bars above and below');
  assert.deepEqual(fitVideo(2000, 900), { x: 200, y: 0, w: 1600, h: 900 }, 'a wide box: bars at the sides');
  assert.deepEqual(fitVideo(0, 400), { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(playerBand(200), 64, 'never less than YouTube’s title bar');
  assert.equal(playerBand(900), 180);
});
