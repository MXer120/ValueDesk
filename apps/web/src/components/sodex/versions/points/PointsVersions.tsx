/**
 * LOCALHOST ONLY: the SoPoints page's versions and their switch (owner 2026-11-26). Original is today's page, rendered
 * as it is; the others are whole pages on the Referrals page's ground. SoPointsPage.tsx loads this file only when
 * `import.meta.env.DEV`, so a build has Original alone.
 */
import type { ComponentType } from 'react';
import type { Eip1193Provider } from '../../../../wallet';
import { DevSwitch, useDevChoice } from '../DevSwitch';
import { Planner } from './Planner';
import { Season } from './Season';
import { Stage } from './Stage';
import '../../../bots/kit/kit.css';
import '../../../bots/botsPages.css';
import '../../../referrals/referrals.css';
import '../versions.css';
import './points.css';

type Version = 'original' | 'stage' | 'season' | 'planner';
const VERSIONS: ReadonlyArray<readonly [Version, string]> = [['original', 'Original'], ['stage', 'Stage'], ['season', 'Season'], ['planner', 'Planner']];
const PAGES: Record<Exclude<Version, 'original'>, typeof Stage> = { stage: Stage, season: Season, planner: Planner };

interface Props { address: string | null; provider: Eip1193Provider | null }

export default function PointsVersions({ address, provider, Original }: Props & { Original: ComponentType<Props> }) {
  const [v, setV] = useDevChoice<Version>('vs.dev.sopoints.version', VERSIONS.map((x) => x[0]), 'original');
  const [smp, setSmp] = useDevChoice<'off' | 'on'>('vs.dev.sopoints.sample', ['off', 'on'], 'off');
  const Page = v === 'original' ? null : PAGES[v];
  return (
    <>
      {Page ? <Page address={address} provider={provider} sample={smp === 'on'} /> : <><Original address={address} provider={provider} /><div className="sx-switch-room" aria-hidden="true" /></>}
      <DevSwitch label="SoPoints page version" versions={VERSIONS} value={v} onChange={setV} sample={{ on: smp === 'on', set: (on) => setSmp(on ? 'on' : 'off'), disabled: v === 'original' }} />
    </>
  );
}
