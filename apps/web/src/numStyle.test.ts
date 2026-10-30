/**
 * The number format (numStyle.ts): the separators every display formatter
 * uses, in each setting, and the input rule that never guesses.
 *   npx tsx --test src/numStyle.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NUM_STYLE_DEFAULT, fmtDecimalString, fmtFixed, fmtNum, fmtPlain, getNumStyle, localize, parseNumInput,
  setNumStyle, subscribeNumStyle, toInputText, type NumStyle,
} from './numStyle';
import { fmt, fmtBalance, fmtExactQuote, fmtPct, fmtPrice, fmtQuote, fmtUsd } from './format';

const NBSP = ' ';

test('the default is 1.234,56 ("." groups, "," decimals) with nothing stored', () => {
  assert.equal(NUM_STYLE_DEFAULT, 'dot-comma');
  assert.equal(getNumStyle(), 'dot-comma');
  assert.equal(fmtNum(1234567.891, { maximumFractionDigits: 2 }), '1.234.567,89');
});

test('every setting writes the same figure with its own marks', () => {
  const want: Record<NumStyle, string> = {
    'dot-comma': '1.234.567,89',
    'comma-dot': '1,234,567.89',
    'space-comma': `1${NBSP}234${NBSP}567,89`,
    'apos-dot': '1’234’567.89',
  };
  for (const [style, text] of Object.entries(want) as Array<[NumStyle, string]>) {
    setNumStyle(style);
    assert.equal(fmtNum(1234567.891, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), text, style);
  }
  setNumStyle('dot-comma');
});

test('localize swaps only the two marks: signs, units and compact suffixes stay', () => {
  setNumStyle('dot-comma');
  assert.equal(localize('$1,234.5K'), '$1.234,5K');
  assert.equal(localize('+0.25%'), '+0,25%');
  assert.equal(fmtNum(1_250_000, { notation: 'compact', maximumFractionDigits: 2 }), '1,25M', 'en compact suffix, not "Mio."');
  assert.equal(fmtFixed(0.125, 2), '0,13');
  assert.equal(fmtPlain(0.5), '0,5');
  setNumStyle('comma-dot');
  assert.equal(localize('$1,234.5K'), '$1,234.5K');
  assert.equal(fmtFixed(0.125, 2), '0.13');
  setNumStyle('dot-comma');
});

test('format.ts formatters follow the setting, rounding untouched', () => {
  setNumStyle('dot-comma');
  assert.equal(fmt(79290.5, 1), '79.290,5');
  assert.equal(fmtPrice('84824.25', '0.01'), '84.824,25');
  assert.equal(fmtUsd(1234.5), '$1.234,50');
  assert.equal(fmtUsd(84824.4), '$84.824');
  assert.equal(fmtUsd(-12.3), '−$12,30');
  assert.equal(fmtQuote(1500, 'BTC'), '1.500,00 BTC');
  assert.equal(fmtPct(1.234), '+1,23%');
  assert.equal(fmtBalance('0.012500', 'BTC'), '0,0125');
  assert.equal(fmtBalance('12500', 'USDC'), '12.500');
  setNumStyle('comma-dot');
  assert.equal(fmt(79290.5, 1), '79,290.5');
  assert.equal(fmtUsd(1234.5), '$1,234.50');
  assert.equal(fmtBalance('0.012500', 'BTC'), '0.0125');
  setNumStyle('dot-comma');
});

test('an exact decimal string is grouped digit for digit, no float', () => {
  setNumStyle('dot-comma');
  assert.equal(fmtDecimalString('12345678901234567.123456789'), '12.345.678.901.234.567,123456789');
  assert.equal(fmtDecimalString('-1000'), '-1.000');
  assert.equal(fmtDecimalString('999'), '999');
  assert.equal(fmtDecimalString('n/a'), 'n/a');
  setNumStyle('comma-dot');
  assert.equal(fmtDecimalString('1234.5'), '1,234.5');
  setNumStyle('dot-comma');
});

test('a change reaches subscribers; an unknown style is ignored', () => {
  let calls = 0;
  const off = subscribeNumStyle(() => { calls += 1; });
  setNumStyle('comma-dot');
  setNumStyle('nope' as NumStyle);
  assert.equal(getNumStyle(), 'comma-dot');
  off();
  setNumStyle('dot-comma');
  assert.equal(calls, 1);
});

test('inputs show the chosen decimal mark and never grouping', () => {
  setNumStyle('dot-comma');
  assert.equal(toInputText('1234.5'), '1234,5');
  assert.equal(toInputText(''), '');
  setNumStyle('comma-dot');
  assert.equal(toInputText('1234.5'), '1234.5');
  setNumStyle('dot-comma');
});

const ok = (text: string, style: NumStyle, allowNegative = false) => {
  const r = parseNumInput(text, { style, allowNegative });
  assert.ok(r.ok, `${text} (${style}) should parse: ${r.ok ? '' : r.error}`);
  return r.value;
};
const refused = (text: string, style: NumStyle) => {
  const r = parseNumInput(text, { style });
  assert.equal(r.ok, false, `${text} (${style}) must be refused, got ${r.ok ? r.value : ''}`);
  return r.ok ? '' : r.error;
};

test('parser, 1.234,56 format: the comma is the decimal mark', () => {
  assert.equal(ok('1,5', 'dot-comma'), '1.5');
  assert.equal(ok('1.234,5', 'dot-comma'), '1234.5');
  assert.equal(ok('1.234.567', 'dot-comma'), '1234567');
  assert.equal(ok('1 234 567,89', 'dot-comma'), '1234567.89');
  assert.equal(ok('0,001', 'dot-comma'), '0.001');
});

test('parser, 1.234,56 format: a plain dot decimal is read where it cannot be grouping', () => {
  assert.equal(ok('1.5', 'dot-comma'), '1.5');
  assert.equal(ok('0.001', 'dot-comma'), '0.001', 'a 0 before the dot is never a thousands group');
  assert.equal(ok('1234.567', 'dot-comma'), '1234.567', 'four digits before it: not a group');
  assert.equal(ok('.5', 'dot-comma'), '0.5');
  assert.equal(ok('1.2345', 'dot-comma'), '1.2345');
  assert.equal(ok('1,234.5', 'dot-comma'), '1234.5', 'a full en-US figure (both marks) is unambiguous');
});

test('parser: an ambiguous figure is refused with a hint, never guessed', () => {
  assert.match(refused('1.000', 'dot-comma'), /Ambiguous/);
  assert.match(refused('12.345', 'dot-comma'), /1234|12345/);
  assert.match(refused('1,000', 'comma-dot'), /Ambiguous/);
  assert.match(refused('999,999', 'apos-dot'), /Ambiguous/);
});

test('parser, 1,234.56 format: the mirror image', () => {
  assert.equal(ok('1.5', 'comma-dot'), '1.5');
  assert.equal(ok('1,234.5', 'comma-dot'), '1234.5');
  assert.equal(ok('1,234,567', 'comma-dot'), '1234567');
  assert.equal(ok('1,5', 'comma-dot'), '1.5', 'a comma that cannot be a group is a decimal mark');
  assert.equal(ok('1’234’567.8', 'apos-dot'), '1234567.8');
});

test('parser: malformed text, signs and empty', () => {
  refused('1.2.3', 'dot-comma');
  refused('1,2,3', 'dot-comma');
  refused('1.234,5,6', 'dot-comma');
  refused('1,23.4', 'dot-comma');
  refused('abc', 'dot-comma');
  refused('-5', 'dot-comma');
  assert.equal(ok('-5,5', 'dot-comma', true), '-5.5');
  assert.equal(ok('', 'dot-comma'), '');
  assert.equal(ok('007', 'dot-comma'), '7');
});

test('every parsed value is machine format: "." decimal, no grouping', () => {
  for (const style of ['dot-comma', 'comma-dot', 'space-comma', 'apos-dot'] as NumStyle[]) {
    for (const t of ['1,5', '1.5', '1.234,5', '1,234.5', '0,001', '0.001', '123456,789']) {
      const r = parseNumInput(t, { style });
      if (r.ok) assert.match(r.value, /^-?\d+(\.\d+)?$/, `${t} in ${style} -> ${r.value}`);
    }
  }
});

test('the order value (fmtExactQuote) follows the setting: not "$0,00" in the default format', () => {
  // The order ticket's Order value: price x size as an exact decimal string. It patched the "0.00"
  // of fmtQuote(0), which the default format writes "0,00": every order under $10,000 read "$0,00".
  setNumStyle('dot-comma');
  assert.equal(fmtExactQuote('46.238', 'vUSDC'), '$46,238');
  assert.equal(fmtExactQuote('1052.6375', 'USDC'), '$1.052,6375');
  assert.equal(fmtExactQuote('8.5', 'USDC'), '$8,50');
  assert.equal(fmtExactQuote('-12.3', 'USDC'), '−$12,30');
  assert.equal(fmtExactQuote('125000.75', 'USDC'), '$125.001', 'five figures and up: no cents');
  assert.equal(fmtExactQuote('2.5', 'BTC'), '2,50 BTC');
  setNumStyle('comma-dot');
  assert.equal(fmtExactQuote('1052.6375', 'USDC'), '$1,052.6375');
  setNumStyle('space-comma');
  assert.equal(fmtExactQuote('1052.6375', 'USDC'), `$1${NBSP}052,6375`);
  setNumStyle('dot-comma');
});
