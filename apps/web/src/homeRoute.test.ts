import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { showsHome } from './homeRoute';

const at = (pathname: string, search = '') => ({ pathname, search });
const none = () => [];

test('the home page: /home always, / on a first visit only', () => {
  assert.equal(showsHome(at('/home'), none, false), true);
  assert.equal(showsHome(at('/home/bots'), () => ['vd.site.terms.v1'], false), true);
  assert.equal(showsHome(at('/'), none, false), true);
  for (const k of ['vd.site.terms.v1', 'vd.site.terms.look', 'vd.site.terms:0xabc']) assert.equal(showsHome(at('/'), () => ['x', k], false), false, k);
  assert.equal(showsHome(at('/', '?ref=ABCDEFGH'), none, false), false, 'an invite opens the app, which keeps it');
  assert.equal(showsHome(at('/'), none, true), false, 'never on beta');
  assert.equal(showsHome(at('/trade'), none, false), false);
});

test('theme-boot decides the same before the first paint', () => {
  const src = readFileSync(new URL('../public/theme-boot.js', import.meta.url), 'utf8');
  assert.match(src, /vd\.site\.terms/);
  assert.match(src, /location\.search/);
});
