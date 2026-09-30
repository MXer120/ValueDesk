import type { Venue } from '../vsApi';

/**
 * Each venue's own colour, for its chip when selected. The app's accent is
 * monotone; venue chips are the one place a brand hue is shown, because the
 * colour IS the venue's identity at a glance.
 */
export const VENUE_BRAND: Record<Venue, string> = {
  sodex: '#FF4F20',
  hyperliquid: '#97FCE4',
  tradexyz: '#7C5CFF',
  lighter: '#E8E8E8',
  arcus: '#3D7BFF',
};
