/**
 * The Fed live transcript's marked words (keywords.ts).
 *   npx tsx --test src/components/fedlive/keywords.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { markTerms, termsIn, type Span } from './keywords';

const marked = (spans: Span[]) => spans.filter((s) => s.tone).map((s) => `${s.tone}:${s.text}`);

test('the decision as the statement words it is one span, ahead of its parts', () => {
  assert.deepEqual(marked(markTerms('The Committee decided to lower the target range by 25 basis points.')), ['dove:lower the target range', 'neutral:basis points']);
  assert.deepEqual(marked(markTerms('It decided to raise the target range.')), ['hawk:raise the target range']);
  assert.deepEqual(marked(markTerms('The Committee decided to maintain the target range.')), ['neutral:maintain the target range']);
  assert.deepEqual(marked(markTerms('We left the target range unchanged; the target range is 3.75 to 4.')), ['neutral:left the target range', 'neutral:target range']);
});

test('dovish and hawkish words, case-insensitive and on word boundaries only', () => {
  assert.deepEqual(marked(markTerms('Rate cuts and easing; labor market cooling.')), ['dove:Rate cuts', 'dove:easing', 'neutral:labor market', 'dove:cooling']);
  assert.deepEqual(marked(markTerms('Inflation remains elevated, with upside risks and more restrictive policy.')), ['hawk:Inflation remains elevated', 'hawk:upside risks', 'hawk:more restrictive']);
  assert.deepEqual(marked(markTerms('Precooling the unhiked pauses.')), [], 'no match inside another word');
  assert.deepEqual(marked(markTerms('We are data-dependent, meeting by meeting.')), ['neutral:data-dependent', 'neutral:meeting by meeting']);
});

test('"quantitative tightening" is the balance sheet, not a hawkish "tightening"', () => {
  // Failing before the fix: "quantitative " plain, then "tightening" marked hawkish.
  assert.deepEqual(marked(markTerms('We will slow quantitative tightening.')), ['neutral:quantitative tightening']);
  assert.deepEqual(marked(markTerms('Further policy tightening may be needed.')), ['hawk:tightening']);
  assert.deepEqual(marked(markTerms('QT continues; the balance sheet shrinks.')), ['neutral:QT', 'neutral:balance sheet']);
});

test('the spans put back together are the line, in order, none overlapping', () => {
  const line = 'Chair: we cut rates, held rates steady before; inflation is sticky and tariffs weigh on unemployment. Two dissents.';
  const spans = markTerms(line);
  assert.equal(spans.map((s) => s.text).join(''), line);
  for (let i = 1; i < spans.length; i++) assert.ok(!(spans[i - 1]!.tone === null && spans[i]!.tone === null), 'plain text is one span between marks');
  assert.deepEqual(marked(spans), ['dove:cut rates', 'hawk:inflation is sticky', 'neutral:tariffs', 'neutral:unemployment', 'neutral:dissents']);
});

test('plain text is one span; empty text is none; marking twice gives the same answer (no regex state left over)', () => {
  assert.deepEqual(markTerms('Good afternoon.'), [{ text: 'Good afternoon.', tone: null }]);
  assert.deepEqual(markTerms(''), []);
  const t = 'A pause, then a rate hike, then a pause.';
  assert.deepEqual(markTerms(t), markTerms(t));
  assert.deepEqual(marked(markTerms(t)), ['neutral:pause', 'hawk:rate hike', 'neutral:pause']);
});

test('termsIn: the marked words of a line, lower-cased, for the tally', () => {
  assert.deepEqual(termsIn('Rate Cuts are not the base case; Inflation Remains Elevated.'), [
    { term: 'rate cuts', tone: 'dove' },
    { term: 'inflation remains elevated', tone: 'hawk' },
  ]);
  assert.deepEqual(termsIn('Thank you.'), []);
});
