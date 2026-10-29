/**
 * The line of the trader's markets a copy cannot follow on SoDEX (notCopyable.ts), for the
 * copy setup and the trader page: SoDEX's market list (the shared poll every page reads) and,
 * for a Hyperliquid trader, SoDEX's marks read once with the trader's positions - the two
 * prices the same-asset check compares. One line; the list opens under it.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useSymbolList } from '../../hooks';
import { notCopyable, type NotCopyable, type NotCopyableInput } from './notCopyable';

export function useNotCopyable(o: Omit<NotCopyableInput, 'markets' | 'marks'> & { enabled: boolean }): NotCopyable {
  const list = useSymbolList('perps', o.enabled);
  const [marks, setMarks] = useState<NotCopyableInput['marks']>(null);
  // A Hyperliquid trader's positions are compared with SoDEX's marks of the same moment: read once per read of theirs.
  const marksKey = o.enabled && o.venue === 'hyperliquid' && o.positions?.length ? String(o.positionsAt ?? '') : null;
  useEffect(() => {
    setMarks(null);
    if (marksKey === null) return;
    let dead = false;
    api.markPrices().then(
      (r) => { if (!dead) setMarks({ at: Date.now(), rows: Array.isArray(r?.markPrices) ? r.markPrices : [] }); },
      () => {},
    );
    return () => { dead = true; };
  }, [marksKey]);
  const markets = list.data?.engine === 'perps' ? (list.data.symbols as unknown as unknown[]) : null;
  return useMemo(
    () => (o.enabled ? notCopyable({ venue: o.venue, positions: o.positions, positionsAt: o.positionsAt, fills: o.fills, markets, marks }) : { line: null, items: [] }),
    [o.enabled, o.venue, o.positions, o.positionsAt, o.fills, markets, marks],
  );
}

/** The line, and the list it stands for when opened. Nothing when every market can be copied. */
export function NotCopyableNote({ n, className }: { n: NotCopyable; className?: string }) {
  if (!n.line) return null;
  return (
    <details className={`cpy-nocopy${className ? ` ${className}` : ''}`}>
      <summary title={n.items.map((x) => `${x.symbol}: ${x.why}`).join('\n')}>{n.line}</summary>
      <ul>
        {n.items.map((x) => (
          <li key={`${x.held ? 'p' : 'f'}:${x.symbol}`}>
            <b>{x.symbol}</b> {x.held ? 'open position' : 'traded lately'} · {x.why}
          </li>
        ))}
      </ul>
    </details>
  );
}
