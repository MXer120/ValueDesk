/**
 * One colour per cohort, for charts that draw several at once. The PnL
 * cohorts run the app's own green to its own red (--pos / --neg, fading toward
 * the text colour in the middle) so "profit" is the same green as everywhere
 * else; the size cohorts take a separate cool-to-warm run so the two groups
 * never read as one scale. CSS values: used in style props only.
 */
import type { CohortId } from '@sign/valuedesk/cohorts/model.js';

export const COHORT_COLOR: Record<CohortId, string> = {
  'extremely-profitable': 'var(--pos)',
  'very-profitable': 'color-mix(in srgb, var(--pos) 62%, var(--text))',
  profitable: 'color-mix(in srgb, var(--pos) 32%, var(--text))',
  unprofitable: 'color-mix(in srgb, var(--neg) 34%, var(--text))',
  'very-unprofitable': 'color-mix(in srgb, var(--neg) 66%, var(--text))',
  rekt: 'var(--neg)',
  apex: '#b39bff',
  whale: '#6aa8ff',
  large: '#43c7e8',
  medium: '#f2c14e',
  small: '#f28cc4',
};
