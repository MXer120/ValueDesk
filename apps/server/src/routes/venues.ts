/**
 * Multi-venue public market data.
 *
 * One URL shape over every supported venue, so the browser does not need to know
 * whether it is talking to SoDEX or Katana:
 *
 *   GET /api/venues
 *   GET /api/venues/:venue/symbols
 *   GET /api/venues/:venue/tickers
 *   GET /api/venues/:venue/orderbook?symbol=&depth=
 *   GET /api/venues/:venue/trades?symbol=&limit=
 *   GET /api/venues/:venue/candles?symbol=&interval=&limit=
 *
 * READ-ONLY BY CONSTRUCTION. Every route here is a GET and the Venue interface
 * has no write method, so there is no order path to reach through this plugin -
 * on either venue.
 *
 * Proxied rather than called from the browser for two independent reasons, either
 * of which alone would be enough: Katana's REST responses carry no
 * `access-control-allow-origin` at all, and both venues rate-limit per IP, so the
 * budget can only be enforced once for all tabs if it is enforced here.
 */
import type { FastifyInstance } from 'fastify';
import { VenueRequestError, UnsupportedIntervalError, type Venue } from '../venues/types.js';
import { katanaVenue } from '../venues/katana/index.js';
import { sodexPerpsVenue, sodexSpotVenue } from '../venues/sodex.js';

/** Registration order is display order. */
export const VENUES: readonly Venue[] = [sodexPerpsVenue, sodexSpotVenue, katanaVenue];

const BY_ID = new Map(VENUES.map((v) => [v.info.id, v]));

/**
 * An unknown venue is a 404 with the valid ids attached.
 *
 * Listing the alternatives matters more than usual here: the venue id is the one
 * part of these URLs a caller cannot discover from the resource itself, so a bare
 * "not found" leaves it with nothing to try.
 */
function lookup(id: unknown): Venue {
  const v = BY_ID.get(String(id));
  if (!v) {
    throw new VenueRequestError(
      `unknown venue "${String(id)}" (known: ${[...BY_ID.keys()].join(', ')})`,
      404,
      String(id),
    );
  }
  return v;
}

/** `symbol` is the one parameter with no sane default - absence is a 400. */
function requireSymbol(q: { symbol?: string }): string {
  const s = q.symbol?.trim();
  if (!s) throw new VenueRequestError('symbol is required', 400, 'request');
  return s;
}

export async function venueRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The capability manifest. `intervals` and the maxima are served rather than
   * hardcoded in the client because the two venues genuinely disagree about both,
   * and a client that guessed would build an interval picker whose buttons 400.
   */
  app.get('/api/venues', async () => ({
    venues: VENUES.map((v) => v.info),
  }));

  app.get('/api/venues/:venue/symbols', async (req) => {
    const venue = lookup((req.params as { venue?: string }).venue);
    return { venue: venue.info.id, symbols: await venue.symbols() };
  });

  app.get('/api/venues/:venue/tickers', async (req) => {
    const venue = lookup((req.params as { venue?: string }).venue);
    return { venue: venue.info.id, tickers: await venue.tickers() };
  });

  app.get('/api/venues/:venue/orderbook', async (req) => {
    const venue = lookup((req.params as { venue?: string }).venue);
    const q = req.query as { symbol?: string; depth?: string };
    // `depth` is levels PER SIDE at this layer. Each adapter converts to whatever
    // its venue's `limit` actually counts - the two do not agree.
    const depth = Number.parseInt(q.depth ?? '', 10);
    const book = await venue.orderbook(requireSymbol(q), Number.isFinite(depth) ? depth : 20);
    return { venue: venue.info.id, book };
  });

  app.get('/api/venues/:venue/trades', async (req) => {
    const venue = lookup((req.params as { venue?: string }).venue);
    const q = req.query as { symbol?: string; limit?: string };
    const limit = Number.parseInt(q.limit ?? '', 10);
    const trades = await venue.trades(requireSymbol(q), Number.isFinite(limit) ? limit : 50);
    return { venue: venue.info.id, trades };
  });

  app.get('/api/venues/:venue/candles', async (req) => {
    const venue = lookup((req.params as { venue?: string }).venue);
    const q = req.query as { symbol?: string; interval?: string; limit?: string };
    const limit = Number.parseInt(q.limit ?? '', 10);
    const interval = q.interval?.trim() || venue.info.intervals[0]!;
    const candles = await venue.candles(
      requireSymbol(q),
      interval,
      Number.isFinite(limit) ? limit : 300,
    );
    return { venue: venue.info.id, interval, candles };
  });

  /**
   * Venue errors are shaped here rather than left to the app-wide handler.
   *
   * VenueRequestError already carries `statusCode`, so the global handler would
   * return the right status - but it would drop `supported`, and for an interval
   * rejection that list is the entire remedy. This hook is plugin-scoped, so it
   * changes nothing for any other route.
   *
   * Anything else is RETHROWN, not re-shaped. A SoDEX-backed venue can still
   * raise SodexApiError or SymbolNotFoundError, and the application handler turns
   * those into responses carrying an actionable `hint` and the right `source`.
   * Reimplementing that fallback here would quietly downgrade a SodexApiError -
   * which has no `statusCode` property - into a generic 500 and throw the hint
   * away. Verified against Fastify 5: an error thrown from a plugin-scoped
   * handler is passed to the parent handler.
   */
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof UnsupportedIntervalError) {
      return reply.code(400).send({
        error: err.message,
        source: 'venue',
        venue: err.venue,
        supported: err.supported,
      });
    }
    if (err instanceof VenueRequestError) {
      return reply
        .code(err.statusCode)
        .send({ error: err.message, source: 'venue', venue: err.venue });
    }
    throw err;
  });
}
