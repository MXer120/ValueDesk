/**
 * Open or merge, as a popup (owner 2026-11-28: "Open boxes & merge make it a pop up ... amount can be selected, ENSURE
 * that >10 works but have like an info warning if >10 is selected. Needs a slider & it should be possible to select which
 * boxes exactly to open and merge"). The amount (field and slider) picks the lowest ids; each box can then be picked by
 * hand. Any amount works: it is cut into requests of SoDEX's size, each one signature.
 */
import { useMemo, useState } from 'react';
import { LEVEL_LABEL, nextLevel, type Level } from '../../../blindBox';
import { fmt } from '../../../format';
import { Button, Icon, TextInput } from '../../bots/kit/kit';
import { BoxArt } from '../BoxArt';
import { Popup } from './Vault';

const n0 = (n: number) => fmt(n, 0);

export function BoxPicker({ kind, level, ids, mergeSize, perOpen, onGo, onClose }: {
  kind: 'open' | 'merge'; level: Level; ids: string[]; mergeSize: number; perOpen: number; onGo: (ids: string[]) => void; onClose: () => void;
}) {
  const size = kind === 'open' ? 1 : mergeSize;
  const maxUnits = Math.floor(ids.length / Math.max(1, size));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(ids.slice(0, maxUnits * size)));
  const units = Math.floor(picked.size / Math.max(1, size));
  const extra = picked.size - units * size;
  const setUnits = (u: number) => setPicked(new Set(ids.slice(0, Math.max(0, Math.min(maxUnits, u)) * size)));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = useMemo(() => ids.filter((id) => picked.has(id)).slice(0, units * size), [ids, picked, units, size]);
  const requests = kind === 'open' ? Math.ceil(units / perOpen) : units;
  const to = nextLevel(level);
  const name = LEVEL_LABEL[level];
  return (
    <Popup label={kind === 'open' ? `Open ${name} boxes` : `Merge ${name} boxes`} size="small" onClose={onClose} head={<b>{kind === 'open' ? 'Open boxes' : 'Merge boxes'}</b>}>
      <form className="bv-pick" onSubmit={(e) => { e.preventDefault(); if (units > 0) onGo(chosen); }}>
        <div className={`bv-gift__item is-${level}`}>
          <BoxArt level={level} size={52} />
          {kind === 'merge' && to && <><i className="bv-pick__arrow" aria-hidden="true">→</i><BoxArt level={to} size={52} /></>}
          <span>
            <b><i className="bv-dot" aria-hidden="true" />{kind === 'open' ? name : `${mergeSize} ${name} → 1 ${to ? LEVEL_LABEL[to] : ''}`}</b>
            <small>{`${n0(ids.length)} in this wallet`}</small>
          </span>
        </div>

        <label className="bv-gift__l" htmlFor="bv-pick-n">{kind === 'open' ? 'Boxes to open' : 'Merges'}</label>
        <div className="bv-form__row">
          <TextInput id="bv-pick-n" inputMode="numeric" value={String(units)} onChange={(e) => setUnits(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)} />
          <Button variant="quiet" onClick={() => setUnits(maxUnits)}>{`All ${n0(maxUnits)}`}</Button>
        </div>
        <input className="bv-pick__slider" type="range" min={maxUnits > 0 ? 1 : 0} max={maxUnits} step={1} value={units} aria-label="Amount" onChange={(e) => setUnits(Number(e.target.value))} style={{ '--p': `${maxUnits ? (units / maxUnits) * 100 : 0}%` } as React.CSSProperties} />

        {units > 10 && (
          <div className="bv-pick__warn" role="note">
            <Icon name="info" size={15} />
            <span>{kind === 'open'
              ? (requests === 1 ? `More than 10 boxes at once: one request, one signature. Revealing them can take up to a few minutes; keep this page open until it is done.` : `More than 10 boxes: they open in ${n0(requests)} requests of up to ${n0(perOpen)}, one after another, each one signature in your wallet. Keep this page open until the last one is done.`)
              : `More than 10 merges: ${n0(units)} requests, one after another, each one signature in your wallet. Keep this page open until the last one is done.`}</span>
          </div>
        )}

        <div className="bv-pick__head">
          <span className="bv-gift__l">Which boxes</span>
          <small>{kind === 'merge' && extra > 0 ? `${n0(picked.size)} picked: ${n0(extra)} beyond whole merges stay` : `${n0(picked.size)} picked`}</small>
        </div>
        <ul className="bv-pick__ids">
          {ids.map((id) => (
            <li key={id}>
              <button type="button" className={`bv-chip${picked.has(id) ? ' is-on' : ''}`} aria-pressed={picked.has(id)} onClick={() => toggle(id)}>{`#${id}`}</button>
            </li>
          ))}
        </ul>

        <small className="bv-gift__hint">{kind === 'open'
          ? `${n0(requests)} signature${requests === 1 ? '' : 's'}, no gas. What each box held shows as it opens.`
          : `${n0(requests)} signature${requests === 1 ? '' : 's'}, no gas. The ${n0(units * mergeSize)} boxes used are burned.`}</small>
        <Button variant="primary" size="md" type="submit" disabled={units === 0} className="bv-gift__go">
          {kind === 'open' ? `Open ${n0(units)} ${units === 1 ? 'box' : 'boxes'}` : `Merge into ${n0(units)} ${to ? LEVEL_LABEL[to] : ''}`}
        </Button>
      </form>
    </Popup>
  );
}
