/**
 * Click a column head to sort. The first click uses the natural direction
 * (A–Z for words, largest first for numbers); the next click flips it.
 */
import { useState, type ReactNode } from 'react';

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }

export function useTableSort(initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const toggle = (key: string, numeric = false) => setSort((s) => {
    if (!s || s.key !== key) return { key, dir: numeric ? 'desc' : 'asc' };
    return { key, dir: s.dir === 'asc' ? 'desc' : 'asc' };
  });
  return { sort, toggle };
}

export function sortRows<T>(
  rows: readonly T[],
  sort: SortState | null,
  value: (row: T, key: string) => string | number | null,
): T[] {
  if (!sort) return rows as T[];
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = value(a, sort.key);
    const bv = value(b, sort.key);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const c = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return c * dir;
  });
}

export function SortTh({
  k, label, sort, onSort, numeric = false, className, title,
}: {
  k: string;
  label: ReactNode;
  sort: SortState | null;
  onSort: (key: string, numeric?: boolean) => void;
  numeric?: boolean;
  className?: string;
  title?: string;
}) {
  const on = sort?.key === k;
  return (
    <th className={className} aria-sort={on ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`acct-sort${on ? ` is-${sort!.dir}` : ''}`}
        title={title}
        onClick={() => onSort(k, numeric)}
      >
        {label}
        {on && <span className="acct-sort__m" aria-hidden="true">{sort!.dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  );
}
