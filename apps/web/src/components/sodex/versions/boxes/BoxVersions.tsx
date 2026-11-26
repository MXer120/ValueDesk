/**
 * LOCALHOST ONLY (owner 2026-11-26: "Upgrade SoPoints & blind Boxes ... multiple versions and the switch ... Do not delete
 * the original keep it in the switch"). The Blind Box page's versions behind the switch: Original (today's page, as it
 * is), Stage, Path and Floor. BlindBoxPage.tsx loads this file only behind `import.meta.env.DEV`; a build shows Original.
 */
import type { ComponentType } from 'react';
import type { Eip1193Provider } from '../../../../wallet';
import { DevSwitch, useDevChoice } from '../DevSwitch';
import { BoxStage } from './Stage';
import { BoxPath } from './Path';
import { BoxFloor } from './Floor';
import '../../../bots/kit/kit.css';
import '../../../bots/botsPages.css';
import '../../../referrals/referrals.css';
import '../versions.css';
import './boxes.css';

type Version = 'original' | 'stage' | 'path' | 'floor';
const VERSIONS: ReadonlyArray<readonly [Version, string]> = [['original', 'Original'], ['stage', 'Stage'], ['path', 'Path'], ['floor', 'Floor']];
const KEYS = VERSIONS.map(([k]) => k);

interface Props { address: string | null; provider: Eip1193Provider | null }

export default function BoxVersions({ address, provider, Original }: Props & { Original: ComponentType<Props> }) {
  const [v, setV] = useDevChoice<Version>('vs.dev.blindbox.version', KEYS, 'original');
  const [s, setS] = useDevChoice<'off' | 'on'>('vs.dev.blindbox.sample', ['off', 'on'], 'off');
  const sample = s === 'on' && v !== 'original';
  const page = v === 'stage' ? <BoxStage address={address} sample={sample} />
    : v === 'path' ? <BoxPath address={address} sample={sample} />
    : v === 'floor' ? <BoxFloor address={address} sample={sample} />
    : <><Original address={address} provider={provider} /><div className="sx-switch-room" aria-hidden="true" /></>;
  return (
    <>
      {page}
      <DevSwitch label="Blind Box page version" versions={VERSIONS} value={v} onChange={setV} sample={{ on: s === 'on', set: (on) => setS(on ? 'on' : 'off'), disabled: v === 'original' }} />
    </>
  );
}
