/** What the phone's trade carousel remembers (carouselMemory.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HINT_KEY, PAGE_KEY, carouselEnv, carouselStore } from './carouselMemory';

const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const KEYS = ['chart', 'book', 'exec'];

function fresh() {
  mem.clear();
  carouselStore.resetForTest();
  carouselEnv.storage = () => store;
}

test('the page last used opens again; the chart when none is kept or it is gone', () => {
  fresh();
  assert.equal(carouselStore.startIndex(KEYS), 0);
  carouselStore.remember('exec');
  assert.equal(mem.get(PAGE_KEY), 'exec');
  assert.equal(carouselStore.startIndex(KEYS), 2);
  mem.set(PAGE_KEY, 'depth');
  assert.equal(carouselStore.startIndex(KEYS), 0, 'a page this carousel no longer has');
  carouselStore.remember(undefined);
  assert.equal(mem.get(PAGE_KEY), 'depth', 'nothing to remember');
});

test('the swipe hint plays once per browser', () => {
  fresh();
  assert.equal(carouselStore.hintDue(), true);
  carouselStore.hinted();
  assert.equal(mem.get(HINT_KEY), '1');
  carouselStore.resetForTest();
  assert.equal(carouselStore.hintDue(), false, 'a later visit (a new page load) does not replay it');
});

test('storage that throws: the defaults, and the hint still only once in this page load', () => {
  fresh();
  carouselEnv.storage = () => { throw new Error('denied'); };
  assert.equal(carouselStore.startIndex(KEYS), 0);
  carouselStore.remember('book');
  assert.equal(carouselStore.hintDue(), true);
  carouselStore.hinted();
  assert.equal(carouselStore.hintDue(), false);
});
