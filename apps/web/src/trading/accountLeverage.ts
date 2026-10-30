/**
 * The leverage and margin mode SoDEX holds for one market of the account, from its perps
 * account state (GET /perps/accounts/{addr}/state, or the accountState push): the open
 * position's own (`P[].l`, `P[].m`) first, else the market's setting (`S[].l`, `S[].m`).
 * null when SoDEX names none (the market was never set): the ticket then keeps its own.
 *
 * The order ticket starts its leverage here, so it shows - and computes margin and
 * liquidation with - what SoDEX will use, not the market's initial leverage.
 */
export interface HeldLeverage {
  leverage: number;
  marginMode: 'cross' | 'isolated';
}

type Row = Record<string, unknown>;

const modeOf = (m: unknown): 'cross' | 'isolated' | null => {
  const s = String(m ?? '').toUpperCase();
  if (s === 'ISOLATED' || s === '1') return 'isolated';
  if (s === 'CROSS' || s === '2') return 'cross';
  return null;
};

function fromRow(r: Row | undefined): HeldLeverage | null {
  if (!r) return null;
  const l = Number(r.l ?? r.leverage);
  if (!Number.isFinite(l) || l < 1) return null;
  return { leverage: Math.floor(l), marginMode: modeOf(r.m ?? r.marginMode) ?? 'cross' };
}

export function accountLeverage(state: unknown, symbol: string): HeldLeverage | null {
  if (!state || typeof state !== 'object' || !symbol) return null;
  const st = state as { P?: unknown; S?: unknown };
  const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : []);
  const pos = rows(st.P).find((p) => String(p.s ?? p.symbol ?? '') === symbol && Number(p.sz ?? p.size ?? 0) !== 0);
  return fromRow(pos) ?? fromRow(rows(st.S).find((x) => String(x.s ?? x.symbol ?? '') === symbol));
}
