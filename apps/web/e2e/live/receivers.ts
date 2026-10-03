/**
 * Receivers for the app's own address check: one published, well-formed address
 * per format, and what must be refused for each (empty, cut short, mistyped,
 * another format's, the zero address). Pure - the refusals step and the route
 * checks both use it.
 */
import type { AddressKind } from '../../src/trading/addresses';
import { receiverProblem, type ChainRoute } from '../../src/trading/funds';

/** Published, well-formed addresses per format (BIPs, genesis accounts, well-known contracts) - never a destination of this run. */
export const SAMPLE_ADDRESS: Record<AddressKind, string> = {
  evm: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  bitcoin: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  litecoin: 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
  dogecoin: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L',
  tron: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  xrp: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  stellar: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
  ton: 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N',
  sui: '0x0000000000000000000000000000000000000000000000000000000000000002',
  cardano: 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
};

/** One character of `a` swapped for another of its own alphabet: the typo a checksum must catch. */
function typo(a: string): string {
  const at = Math.floor(a.length / 2);
  const c = a[at]!;
  const swap = /[0-9]/.test(c) ? (c === '7' ? '8' : '7') : c === c.toLowerCase() ? (c === 'q' ? 'p' : 'q') : c === 'Q' ? 'P' : 'Q';
  return a.slice(0, at) + swap + a.slice(at + 1);
}

/**
 * Formats with no checksum: a Solana address is any 32 bytes in base58, a Sui
 * address any 64 hex characters - a mistyped character there is still an address,
 * and no program can tell. (Said in the check's detail; not a failure of the app.)
 */
export const NO_CHECKSUM: ReadonlySet<AddressKind> = new Set<AddressKind>(['solana', 'sui']);

/** Receivers that must be refused for an address format: empty, cut short, a typo, another format's address, and (EVM) the zero address. */
export function malformedReceivers(kind: AddressKind): Array<{ what: string; address: string }> {
  const good = SAMPLE_ADDRESS[kind];
  const other = kind === 'evm' ? SAMPLE_ADDRESS.solana : SAMPLE_ADDRESS.evm;
  return [
    { what: 'empty', address: '' },
    { what: 'cut short', address: good.slice(0, Math.max(4, good.length - 6)) },
    ...(NO_CHECKSUM.has(kind) ? [] : [{ what: 'one character mistyped', address: typo(good) }]),
    { what: `a ${kind === 'evm' ? 'Solana' : 'EVM'} address`, address: other },
    ...(kind === 'evm' ? [{ what: 'the zero address', address: '0x0000000000000000000000000000000000000000' }] : []),
  ];
}

/** The app's own receiver check over one address format: the sample passes, every malformed one is refused. */
export function receiverFormatProblems(route: ChainRoute): string[] {
  if (route.addressKind === 'other') return [];
  const out: string[] = [];
  const good = receiverProblem(route, SAMPLE_ADDRESS[route.addressKind]);
  if (good !== null) out.push(`a well-formed ${route.addressKind} address is refused: ${good}`);
  for (const bad of malformedReceivers(route.addressKind)) {
    if (receiverProblem(route, bad.address) === null) out.push(`${bad.what} ("${bad.address}") is ACCEPTED as a ${route.label} receiver`);
  }
  return out;
}
