/**
 * The FAQ's search, in the page (no request): every word of the question must be found - as itself, its stem, the start
 * of a word, a word that means the same here, or one typo away - and the best answers come first: in the question more
 * than in the answer, a whole word more than a part, a rare word more than one in every answer.
 */
export interface FaqDoc { id: string; q: string; a: string; k?: string }

const STOP = new Set('a an the is are do does did can could will would i my me you your it its of to in on for with and or be this that how what which when where who why there any if from at by as get have has'.split(' '));

/** Words that mean the same here. Each group's words find each other. */
const SAME: string[][] = [
  ['fee', 'cost', 'price', 'pricing', 'charge', 'pay', 'expensive', 'cheap', 'commission', 'gebühr', 'kosten'],
  ['deposit', 'custody', 'fund', 'money', 'safe', 'secure', 'security', 'steal', 'hack', 'withdraw', 'einzahlen', 'sicher'],
  ['minimum', 'min', 'least', 'small', 'start', 'amount', 'capital', 'balance'],
  ['stop', 'cancel', 'end', 'quit', 'close', 'pause', 'off', 'revoke', 'remove', 'stoppen'],
  ['key', 'permission', 'api', 'approve', 'access', 'signature', 'sign', 'wallet'],
  ['bot', 'market', 'maker', 'grid', 'hedge', 'algo', 'automated'],
  ['copy', 'follow', 'mirror', 'trader', 'leader', 'counter', 'kopieren'],
  ['country', 'region', 'available', 'usa', 'us', 'america', 'uk', 'canada', 'allowed', 'land'],
  ['liquidation', 'liq', 'liquidated', 'heatmap', 'map'],
  ['point', 'sopoints', 'airdrop', 'reward'],
  ['loss', 'lose', 'risk', 'limit', 'verlust'],
  ['spot', 'coin', 'perp', 'future', 'futures', 'leverage', 'margin'],
  ['free', 'gratis', 'kostenlos'],
  ['vip', 'lowest', 'discount', 'cheaper'],
  ['news', 'cpi', 'fed', 'fomc', 'volatility', 'gate', 'hours'],
  ['laptop', 'tab', 'browser', 'offline', 'sleep', 'night', 'running', 'hosted'],
  ['venue', 'exchange', 'hyperliquid', 'lighter', 'arcus', 'sodex'],
];

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9$%. ]+/g, ' ');
export const stem = (w: string): string => {
  let x = w.replace(/[.]+$/, '');
  if (x.length > 4) x = x.replace(/(ies)$/, 'y').replace(/(sses|shes|ches)$/, (m) => m.slice(0, -2));
  if (x.length > 5) x = x.replace(/(ing|ed)$/, '');
  if (x.length > 3) x = x.replace(/s$/, '').replace(/e$/, '');
  return x;
};
const words = (s: string): string[] => norm(s).split(/\s+/).filter(Boolean).map(stem).filter(Boolean);

const SYN = new Map<string, Set<string>>();
for (const g of SAME) {
  const st = g.map((w) => stem(norm(w).trim()));
  for (const w of st) { const x = SYN.get(w) ?? new Set<string>(); st.forEach((y) => y !== w && x.add(y)); SYN.set(w, x); }
}

/** One edit apart (a letter missing, added, changed or two swapped). */
export function nearWord(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ra = a.slice(i), rb = b.slice(i);
  return ra.slice(1) === rb || ra === rb.slice(1) || ra.slice(1) === rb.slice(1) || (ra[0] === rb[1] && ra[1] === rb[0] && ra.slice(2) === rb.slice(2));
}

export interface FaqIndex { docs: Array<{ id: string; q: Set<string>; a: Set<string> }>; df: Map<string, number>; all: string[] }

export function faqIndex(docs: readonly FaqDoc[]): FaqIndex {
  const df = new Map<string, number>();
  const out = docs.map((d) => {
    const q = new Set(words(`${d.q} ${d.k ?? ''}`)), a = new Set(words(d.a));
    for (const w of new Set([...q, ...a])) df.set(w, (df.get(w) ?? 0) + 1);
    return { id: d.id, q, a };
  });
  return { docs: out, df, all: [...df.keys()] };
}

/** The ids that answer `query`, best first; every one for an empty query. */
export function faqSearch(ix: FaqIndex, query: string): string[] {
  const raw = words(query);
  if (!raw.length) return ix.docs.map((d) => d.id);
  const kept = norm(query).split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem);
  const terms = kept.length ? kept : raw;
  const want = terms.map((t, i) => {
    const m = new Map<string, number>();
    const put = (w: string, v: number) => { if ((m.get(w) ?? 0) < v) m.set(w, v); };
    const last = i === terms.length - 1;
    for (const w of ix.all) {
      if (w === t) put(w, 1);
      else if (t.length >= 2 && w.startsWith(t)) put(w, last ? 0.8 : 0.6);
      else if (t.length >= 4 && nearWord(w, t)) put(w, 0.55);
    }
    for (const s of SYN.get(t) ?? []) put(s, 0.45);
    // A typo in a word that only a synonym holds ("comission").
    if (!m.size && t.length >= 4) for (const [w, ss] of SYN) if (nearWord(w, t)) for (const s of ss) put(s, 0.35);
    return m;
  });
  const n = ix.docs.length;
  const scored: Array<{ id: string; s: number; hit: number }> = [];
  for (const d of ix.docs) {
    let s = 0, hit = 0;
    for (const m of want) {
      let best = 0;
      for (const [w, v] of m) {
        const in_ = d.q.has(w) ? 3 : d.a.has(w) ? 1 : 0;
        if (in_) best = Math.max(best, v * in_ * Math.log(1 + n / (ix.df.get(w) ?? 1)));
      }
      if (best > 0) hit++;
      s += best;
    }
    if (hit) scored.push({ id: d.id, s, hit });
  }
  // All words found first; with none such, those that hold the most of them.
  const most = Math.max(0, ...scored.map((x) => x.hit));
  const full = scored.filter((x) => x.hit === most).sort((x, y) => y.s - x.s);
  const cut = (full[0]?.s ?? 0) * 0.4;
  return full.filter((x) => x.s >= cut).map((x) => x.id);
}
