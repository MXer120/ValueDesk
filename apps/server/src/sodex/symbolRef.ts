/**
 * Find a market in a symbols list by internal name, display name, or numeric
 * id - case-insensitively. Pure: the server's resolver (symbols.ts) and the
 * browser's market-data client both answer "which market is BTC-USD?" with it.
 */
export interface SymbolRefShape {
  id: number;
  name: string;
  displayName: string;
}

export function findSymbol<S extends SymbolRefShape>(list: readonly S[], ref: string | number): S | undefined {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const id = Number(ref);
    return list.find((s) => s.id === id);
  }
  const want = String(ref).toUpperCase();
  return list.find((s) => s.name.toUpperCase() === want || s.displayName.toUpperCase() === want);
}

/** Whether a reference is a numeric id (the error wording differs). */
export const isSymbolId = (ref: string | number): boolean => typeof ref === 'number' || /^\d+$/.test(String(ref));
