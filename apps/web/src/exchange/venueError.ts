/** A venue failure, as the server's `{ok:false, code, error}` answered it (venues.ts throws it, vsApi.ts maps it). */
export class VenueError extends Error {
  constructor(
    message: string,
    readonly code: 'not_available' | 'upstream' | 'bad_request',
  ) {
    super(message);
    this.name = 'VenueError';
  }
}
