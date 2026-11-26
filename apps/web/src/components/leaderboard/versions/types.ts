import type { Venue } from '../../../vsApi';

/** What every leaderboard version gets: the page's own props (LeaderboardPageProps), Copy with its direction. */
export interface VersionProps {
  address: string | null;
  onScan: (address: string, venue?: Venue) => void;
  onCopy: (address: string, venue: Venue, direction: 'copy' | 'counter') => void;
  embedded: boolean;
}
