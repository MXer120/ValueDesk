/**
 * A market from the list SoDEX trades, picked from a dropdown with a search
 * and each coin's logo (the app's FxSelect), for a conditional's conditions
 * and a basket's legs. A value not in the list (typed in an older draft) stays
 * selectable, so it is never silently replaced.
 */
import { useMemo } from 'react';
import { useSymbols } from '../../hooks';
import { FxSelect, type FxOption } from '../funds/ui';

const coinOf = (name: string) => name.replace(/-USD$/i, '');

export function MarketSelect({ value, onChange, label = 'Market', compact = false }: { value: string; onChange: (v: string) => void; label?: string; compact?: boolean }) {
  const { symbols } = useSymbols('perps');
  const options: FxOption[] = useMemo(() => {
    const list = symbols.map((s) => ({ value: s.name, label: s.name, icon: coinOf(s.name) }));
    if (value && !list.some((o) => o.value === value)) list.unshift({ value, label: value, icon: coinOf(value) });
    return list;
  }, [symbols, value]);
  return (
    <FxSelect
      value={value}
      options={options}
      onChange={onChange}
      label={label}
      searchable
      searchPlaceholder="Search markets"
      loading={!symbols.length && !value}
      triggerClassName={`algo-msel${compact ? ' is-compact' : ''}`}
      listMinWidth={220}
    />
  );
}

/** A short choice as a dropdown in the same style (a condition's type, its comparison). */
export function MiniSelect<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <FxSelect
      value={value}
      options={options.map(([v, l]) => ({ value: v, label: l }))}
      onChange={(v) => onChange(v as T)}
      label={label}
      searchable={false}
      triggerClassName="algo-msel is-mini"
      listMinWidth={170}
    />
  );
}
