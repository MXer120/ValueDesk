/**
 * LOCALHOST ONLY (the switch's "Sample"): a made-up wallet's boxes, to judge the filled "Your boxes" parts without a
 * wallet that holds any. Never in a build (only BoxVersions.tsx imports it, behind import.meta.env.DEV). The ids are
 * invented; the page says "Sample" wherever they show.
 */
import type { WalletBoxes } from '../../../../blindBox';
import type { DrawRead, RecordRow } from '../../../../boxVault';
import type { VaultDemo } from '../../vault/Vault';
import { DEMO_NFT_OWNER } from '../../../portfolio/devDemo';

const ids = (from: number, n: number, step: number): string[] => Array.from({ length: n }, (_, i) => String(from + i * step));

export const SAMPLE_ADDRESS = '0x5a1e…90c2';

export const sampleBoxes = (): WalletBoxes => ({
  count: 37,
  exact: true,
  byLevel: { Common: ids(180_412, 23, 137), Uncommon: ids(181_006, 11, 211), Rare: ids(188_431, 3, 503), SuperRare: [] },
});

const H = 3_600_000;
const row = (kind: RecordRow['kind'], hoursAgo: number, o: Partial<RecordRow> = {}): RecordRow => ({
  kind, at: Date.now() - hoursAgo * H, level: 'Common', tokenIds: [], usd: null, reward: null, pfpTokenId: null, count: null, other: null, direction: null, ...o,
});

/** The vault, history and hero filled for the Sample: made-up, never a real wallet's (the Cybereators are a real holder's, read-only). */
export const sampleVault = (): VaultDemo => ({
  boxes: { ...sampleBoxes(), count: 38, byLevel: { ...sampleBoxes().byLevel, SuperRare: ['196204'] } },
  cybrOwner: DEMO_NFT_OWNER,
  progress: { effectiveU: 121_671, toNextBoxU: 8_328, boxesEarned: 12, at: Date.now() - 3 * 60_000 },
  treasures: 3,
  records: [
    row('open', 0.4, { tokenIds: ['180412'], usd: 1, reward: { asset: { symbol: 'vsoUSDC' }, amount: '1.0' } }),
    row('open', 0.4, { tokenIds: ['180549'], usd: 1.66, reward: { asset: { symbol: 'vANT' }, amount: '0.0201' }, pfpTokenId: '3121' }),
    row('merge', 2, { level: 'Uncommon', tokenIds: ['181006'], count: 10 }),
    row('claim', 5, { count: 4 }),
    row('referral', 20, { level: 'Uncommon', count: 1, other: '0x8a21c0de5f00000000000000000000000000b7e4' }),
    row('open', 26, { level: 'Uncommon', tokenIds: ['181217'], usd: 10.41, reward: { asset: { symbol: 'vsoUSDC' }, amount: '10.41' } }),
    row('transfer', 40, { tokenIds: ['180686'], direction: 'out', other: '0x31f9a0c2d4000000000000000000000000004e2a' }),
    row('open', 52, { level: 'Rare', tokenIds: ['188431'], usd: 109.11, reward: { asset: { symbol: 'vANT' }, amount: '1.318' } }),
    row('transfer', 70, { level: 'Rare', tokenIds: ['188934'], direction: 'in', other: '0x77c0aa19be00000000000000000000000000c1d5' }),
    row('claim', 96, { count: 9 }),
    row('referral', 130, { count: 1, other: '0x02bf6e8c1a00000000000000000000000000a90f' }),
    row('open', 160, { tokenIds: ['180960'], usd: 1, reward: { asset: { symbol: 'vsoUSDC' }, amount: '1.0' } }),
  ],
});

/** The weekly draw for the Sample: 38 tickets, one won (made-up). */
export const sampleDraw = (): DrawRead => ({
  round: '7', status: 'open', deadlineMs: null, tickets: 38, wins: 1,
  entries: [
    { tokenId: '180412', level: 'Common', won: false, prizeLevel: null },
    { tokenId: '181006', level: 'Uncommon', won: true, prizeLevel: 'Rare' },
    { tokenId: '180549', level: 'Common', won: false, prizeLevel: null },
    { tokenId: '188431', level: 'Rare', won: false, prizeLevel: null },
  ],
});
