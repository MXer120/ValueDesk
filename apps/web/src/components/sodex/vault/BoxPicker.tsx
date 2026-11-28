/**
 * Open, merge or gift boxes, as a popup (owner 2026-11-28). The box in the middle; a small amount field with Max inside
 * and a slider beside it (merge: two fields, boxes in and boxes out, "merge x to y"); one selected to start; each box
 * pickable by its number; at most MAX_BOXES at once; above 10 a note. Gift adds the recipient and sends each box picked,
 * one transfer each.
 */
import { useMemo, useState } from 'react';
import { LEVEL_LABEL, nextLevel, type Level } from '../../../blindBox';
import { isAddress } from '../../../boxVault';
import { fmt } from '../../../format';
import { Button, Icon, Slider, TextInput } from '../../bots/kit/kit';
import { BoxArt } from '../BoxArt';
import { Popup } from './Vault';

const n0 = (n: number) => fmt(n, 0);
/** At most this many boxes in one go (owner 2026-11-28: "Limit to 100 boxes at once"). */
export const MAX_BOXES = 100;
const digits = (v: string) => Number(v.replace(/[^0-9]/g, '')) || 0;

/** A small number field with Max inside it. */
function Amount({ id, value, max, onChange, label }: { id: string; value: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="bv-amt">
      <TextInput id={id} inputMode="numeric" aria-label={label} value={String(value)} onChange={(e) => onChange(digits(e.target.value))} />
      <button type="button" className="bv-amt__max" onClick={() => onChange(max)}>Max</button>
    </span>
  );
}

export function BoxPicker({ kind, level, ids, mergeSize, perOpen, onGo, onClose }: {
  kind: 'open' | 'merge' | 'gift'; level: Level; ids: string[]; mergeSize: number; perOpen: number;
  onGo: (ids: string[], to: string) => void; onClose: () => void;
}) {
  const size = kind === 'merge' ? Math.max(1, mergeSize) : 1;
  const maxUnits = Math.floor(Math.min(ids.length, MAX_BOXES) / size);
  const [picked, setPicked] = useState<string[]>(() => ids.slice(0, Math.min(1, maxUnits) * size));
  const [to, setTo] = useState('');
  const units = Math.floor(picked.length / size);
  const setUnits = (u: number) => {
    const n = Math.max(0, Math.min(maxUnits, u)) * size;
    /* Keep the boxes picked by hand first, then the lowest numbers. */
    const keep = picked.slice(0, n);
    const rest = ids.filter((id) => !keep.includes(id)).slice(0, n - keep.length);
    setPicked([...keep, ...rest]);
  };
  const toggle = (id: string) => setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < maxUnits * size ? [...s, id] : s));
  const chosen = useMemo(() => picked.slice(0, units * size), [picked, units, size]);
  const requests = kind === 'open' ? Math.ceil(units / perOpen) : units;
  const next = nextLevel(level);
  const name = LEVEL_LABEL[level];
  const ok = units > 0 && (kind !== 'gift' || isAddress(to));
  const title = kind === 'open' ? 'Open boxes' : kind === 'merge' ? 'Merge boxes' : 'Gift boxes';
  return (
    <Popup label={`${title}: ${name}`} size="small" onClose={onClose} head={<b>{title}</b>}>
      <form className="bv-pick" onSubmit={(e) => { e.preventDefault(); if (ok) onGo(chosen, to.trim()); }}>
        <div className={`bv-pick__hero is-${level}`}>
          <span className="bv-pick__arts">
            <span className={`bv-pick__box is-${level}`}><BoxArt level={level} size={84} /></span>
            {kind === 'merge' && next && <><i aria-hidden="true">→</i><span className={`bv-pick__box is-${next}`}><BoxArt level={next} size={84} /></span></>}
          </span>
          <b><i className="bv-dot" aria-hidden="true" />{kind === 'merge' && next ? `${name} → ${LEVEL_LABEL[next]}` : name}</b>
          <small>{ids.length > MAX_BOXES ? `${n0(ids.length)} in this wallet, up to ${n0(MAX_BOXES)} at once` : `${n0(ids.length)} in this wallet`}</small>
        </div>

        {kind === 'gift' && (
          <>
            <label className="bv-gift__l" htmlFor="bv-pick-to">Recipient address</label>
            <TextInput id="bv-pick-to" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} autoComplete="off" />
            <small className={to && !isAddress(to) ? 'bv-err' : 'bv-gift__hint'}>{to && !isAddress(to) ? 'That is not an EVM address.' : "Enter the recipient's EVM address on ValueChain."}</small>
          </>
        )}

        <label className="bv-gift__l" htmlFor="bv-pick-n">{kind === 'open' ? 'Boxes to open' : kind === 'merge' ? 'Merge' : 'Boxes to gift'}</label>
        <div className="bv-pick__amount">
          {kind === 'merge' ? (
            <span className="bv-pick__merge">
              <Amount id="bv-pick-n" label={`${name} boxes in`} value={units * size} max={maxUnits * size} onChange={(n) => setUnits(Math.floor(n / size))} />
              <i aria-hidden="true">→</i>
              <Amount id="bv-pick-out" label={`${next ? LEVEL_LABEL[next] : ''} boxes out`} value={units} max={maxUnits} onChange={setUnits} />
            </span>
          ) : (
            <Amount id="bv-pick-n" label="How many" value={units} max={maxUnits} onChange={setUnits} />
          )}
          <Slider className="bv-pick__slider" label="How many" value={units} min={maxUnits > 0 ? 1 : 0} max={Math.max(1, maxUnits)} onChange={setUnits} />
        </div>

        {units > 10 && (
          <div className="bv-pick__warn" role="note">
            <Icon name="info" size={15} />
            <span>{kind === 'open'
              ? (requests === 1 ? 'More than 10 boxes at once: one request, one signature. Revealing them can take up to a few minutes; keep this page open until it is done.' : `More than 10 boxes: ${n0(requests)} requests of up to ${n0(perOpen)}, one after another, each one signature. Keep this page open until the last one is done.`)
              : kind === 'merge' ? `More than 10 merges: ${n0(units)} requests, one after another, each one signature. Keep this page open until the last one is done.`
              : `More than 10 gifts: ${n0(units)} transfers, one after another, each confirmed in your wallet with its gas.`}</span>
          </div>
        )}

        <div className="bv-pick__head">
          <span className="bv-gift__l">Which boxes</span>
          <small>{`${n0(picked.length)} picked`}</small>
        </div>
        <ul className="bv-pick__ids">
          {ids.map((id) => (
            <li key={id}>
              <button type="button" className={`bv-chip${picked.includes(id) ? ' is-on' : ''}`} aria-pressed={picked.includes(id)} onClick={() => toggle(id)}>{`#${id}`}</button>
            </li>
          ))}
        </ul>

        <small className="bv-gift__hint">{kind === 'open'
          ? `${n0(requests)} signature${requests === 1 ? '' : 's'}, no gas. What each box held shows as it opens.`
          : kind === 'merge' ? `${n0(requests)} signature${requests === 1 ? '' : 's'}, no gas. The ${n0(units * size)} boxes used are burned.`
          : `${n0(units)} transfer${units === 1 ? '' : 's'} on ValueChain, each shown in your wallet with its gas. It cannot be undone.`}</small>
        <Button variant="primary" size="md" type="submit" disabled={!ok} className="bv-gift__go">
          {kind === 'open' ? `Open ${n0(units)} ${units === 1 ? 'box' : 'boxes'}` : kind === 'merge' ? `Merge ${n0(units * size)} into ${n0(units)}` : `Gift ${n0(units)} ${units === 1 ? 'box' : 'boxes'}`}
        </Button>
      </form>
    </Popup>
  );
}
