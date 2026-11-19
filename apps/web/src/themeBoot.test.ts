/**
 * public/theme-boot.js, run before the first paint: on iPhone and iPad only, the viewport gets maximum-scale=1, which
 * stops Safari zooming into a focused field under 16px (it ignores the value for the visitor's own pinch since iOS
 * 10). Android keeps the page's viewport, so its pinch zoom is untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const BOOT = readFileSync(join(import.meta.dirname, '..', 'public', 'theme-boot.js'), 'utf8');
const PAGE = 'width=device-width, initial-scale=1, viewport-fit=cover';

function boot(navigator: Record<string, unknown>, theme: string | null = null) {
  const viewport = { content: PAGE, setAttribute(_k: string, v: string) { this.content = v; } };
  const attrs: Record<string, string> = {};
  const document = {
    documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; }, style: {} as Record<string, string> },
    querySelector: (sel: string) => (sel.includes('viewport') ? viewport : null),
  };
  runInNewContext(BOOT, { navigator, document, localStorage: { getItem: () => theme } });
  return { viewport: viewport.content, attrs };
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

test('an iPhone, iPod or iPad (iPadOS desktop mode included) gets maximum-scale=1', () => {
  assert.equal(boot({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 }).viewport, 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
  assert.match(boot({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 }).viewport, /maximum-scale=1/, "iPadOS's desktop user agent, with a touch screen");
});

test('Android, a Mac and a desktop keep the viewport as it is, pinch zoom included', () => {
  assert.equal(boot({ userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5 }).viewport, PAGE);
  assert.equal(boot({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 }).viewport, PAGE);
});

test('the theme still applies before the first paint, iPhone or not', () => {
  assert.equal(boot({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 }, 'light').attrs['data-theme'], 'light');
  assert.equal(boot({ userAgent: ANDROID, platform: 'Linux', maxTouchPoints: 5 }, null).attrs['data-theme'], undefined);
});
