/**
 * LOCALHOST ONLY: the SoPoints page's versions and their switch (owner 2026-11-26). Since 2026-11-27 Stage is the page
 * ("make stage version the new original"): it leads the switch as "SoPoints", the page before it is "Previous", and
 * Season and Planner stay until the owner says otherwise. SoPointsPage.tsx loads this file only when
 * `import.meta.env.DEV`, so a build has Stage alone.
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

type Version = 'stage' | 'previous' | 'season' | 'planner';
const VERSIONS: ReadonlyArray<readonly [Version, string]> = [['stage', 'SoPoints'], ['previous', 'Previous'], ['season', 'Season'], ['planner', 'Planner']];
const PAGES: Record<Exclude<Version, 'previous'>, typeof Stage> = { stage: Stage, season: Season, planner: Planner };

interface Props { address: string | null; provider: Eip1193Provider | null }

export default function PointsVersions({ address, provider, Previous }: Props & { Previous: ComponentType<Props> }) {
  // A new key: an earlier pick of "original" does not hold the promoted page back.
  const [v, setV] = useDevChoice<Version>('vs.dev.sopoints.page', VERSIONS.map((x) => x[0]), 'stage');
  const [smp, setSmp] = useDevChoice<'off' | 'on'>('vs.dev.sopoints.sample', ['off', 'on'], 'off');
  const Page = v === 'previous' ? null : PAGES[v];
  return (
    <>
      {Page ? <Page address={address} provider={provider} sample={smp === 'on'} /> : <><Previous address={address} provider={provider} /><div className="sx-switch-room" aria-hidden="true" /></>}
      <DevSwitch label="SoPoints page version" versions={VERSIONS} value={v} onChange={setV} sample={{ on: smp === 'on', set: (on) => setSmp(on ? 'on' : 'off'), disabled: v === 'previous' }} />
    </>
  );
}
