/**
 * A CPU profile of the running indexer, on demand, without a restart:
 *
 *   sudo systemctl kill -s SIGUSR2 valuescan-indexer
 *
 * profiles its main thread for PROFILE_MS and writes `<index dir>/profiles/indexer-<time>.cpuprofile`
 * (Chrome DevTools / speedscope read it; deploy/server/bin/profile-top.mjs sums it per function on
 * the box). Added 2026-10-31: board builds went from under a minute to 8-27 min at a UTC day change
 * with the machine idle and the indexer's one thread at 84%, and no timing said which work held it.
 * One at a time; the profiler costs a few percent while it runs and nothing otherwise.
 */
import { Session } from 'node:inspector/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PROFILE_MS = 60_000;

let running = false;

export async function cpuProfile(indexPath: string, ms = PROFILE_MS): Promise<string | null> {
  if (running) return null;
  running = true;
  const session = new Session();
  try {
    session.connect();
    await session.post('Profiler.enable');
    // 1 ms sampling: fine enough to name a slice of a 30-150 ms pass.
    await session.post('Profiler.setSamplingInterval', { interval: 1_000 });
    await session.post('Profiler.start');
    await new Promise((r) => setTimeout(r, ms));
    const { profile } = await session.post('Profiler.stop');
    const dir = join(dirname(indexPath), 'profiles');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `indexer-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
    writeFileSync(file, JSON.stringify(profile));
    return file;
  } finally {
    session.disconnect();
    running = false;
  }
}

/** SIGUSR2: one profile of PROFILE_MS, its file logged. */
export function profileOnSignal(indexPath: string): void {
  process.on('SIGUSR2', () => {
    console.log(`[indexer] SIGUSR2: profiling the main thread for ${PROFILE_MS / 1000} s`);
    cpuProfile(indexPath).then(
      (f) => console.log(f ? `[indexer] profile written: ${f}` : '[indexer] a profile is already running'),
      (e) => console.log(`[indexer] profile failed: ${String(e)}`),
    );
  });
}
