import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalInput, integerInput, tickInput, trimZeros } from './numberInput';

test('a comma typed as the decimal point is a decimal point (de-DE keyboards)', () => {
  assert.equal(decimalInput('0,5'), '0.5');
  assert.equal(decimalInput('83900,5'), '83900.5');
  assert.equal(decimalInput('0,'), '0.', 'mid-typing keeps the point so the next digit can follow');
  assert.equal(decimalInput(',5'), '.5');
});

test('pasted thousands separators are dropped, the value is kept', () => {
  assert.equal(decimalInput('83,941.5'), '83941.5');
  assert.equal(decimalInput('1,234,567'), '1234567');
  assert.equal(decimalInput(' 84 000 '), '84000');
  assert.equal(decimalInput('$1,224.52'), '1224.52');
});

test('typing a second separator never moves the decimal point', () => {
  assert.equal(decimalInput('1.5,'), '1.5', 'a comma after a point is dropped, not read as de thousands (15)');
  assert.equal(decimalInput('1.5.'), '1.5');
  assert.equal(decimalInput('1..5'), '1.5');
});

test('only digits survive; a minus only where a signed amount is allowed', () => {
  assert.equal(decimalInput('abc12x.3'), '12.3');
  assert.equal(decimalInput('-5'), '5');
  assert.equal(decimalInput('-5', { signed: true }), '-5');
  assert.equal(decimalInput('-', { signed: true }), '-');
  assert.equal(decimalInput(''), '');
});

test('percent and multiplier boxes take whole numbers only', () => {
  assert.equal(integerInput('25'), '25');
  assert.equal(integerInput('2.5'), '25');
  assert.equal(integerInput('1000'), '100');
  assert.equal(integerInput('x'), '');
});

test('a price cannot sit off the tick', () => {
  assert.equal(tickInput('83900.4', '1'), '83900');
  assert.equal(tickInput('83900.5', '1'), '83901');
  assert.equal(tickInput('83900.', '1'), '83900', 'a decimal point is not a tick of 1');
  assert.equal(tickInput('1.', '0.5'), '1.', 'the point stays so the next digit can be typed');
  assert.equal(tickInput('1.2', '0.25'), '1.2', '1.2 can still become 1.25');
  assert.equal(tickInput('1.25', '0.25'), '1.25');
  assert.equal(tickInput('1.3', '0.25'), '1.25');
  assert.equal(tickInput('1.23', '0.1'), '1.2');
  assert.equal(tickInput('', '1'), '');
  assert.equal(tickInput('12.5', undefined), '12.5');
});

test('converted sizes lose the padding toFixed adds, never significant digits', () => {
  assert.equal(trimZeros('0.01000'), '0.01');
  assert.equal(trimZeros('5.000'), '5');
  assert.equal(trimZeros('120'), '120');
  assert.equal(trimZeros('0.00000'), '0');
  assert.equal(trimZeros('10.50'), '10.5');
});
