/**
 * Whether SoDEX has Wealth in maintenance.
 *
 * NOT ON THE GATEWAY: `mainnet-gw.../wealth/maintenance` is a 404. SoDEX's own page reads this one path
 * from `wealth.sodex.dev`, which sends no CORS headers to other sites, so it comes through our server
 * (routes/sodexLottery.ts), as `{status:'NORMAL'|'MAINTENANCE', message, updatedAt}`. Only an answer that
 * says MAINTENANCE shows anything; a read that failed is `unknown`, never maintenance (the same evidence
 * rule as maintenanceVerdict.ts).
 */
import { serverGetJson } from '../../serverFetch';

export const WEALTH_MAINTENANCE_PATH = '/api/vs/sodex/wealth/maintenance';

export interface WealthMaintenance { state: 'normal' | 'maintenance' | 'unknown'; message: string | null }

type MaintenanceGet = (path: string, signal?: AbortSignal) => Promise<{ ok: boolean; body: { status?: unknown; message?: unknown } | null }>;

export async function fetchMaintenance(signal?: AbortSignal, get: MaintenanceGet = serverGetJson): Promise<WealthMaintenance> {
  try {
    const r = await get(WEALTH_MAINTENANCE_PATH, signal);
    if (!r.ok || !r.body) return { state: 'unknown', message: null };
    const message = typeof r.body.message === 'string' && r.body.message ? r.body.message : null;
    if (r.body.status === 'MAINTENANCE') return { state: 'maintenance', message };
    if (r.body.status === 'NORMAL') return { state: 'normal', message: null };
    return { state: 'unknown', message: null };
  } catch {
    return { state: 'unknown', message: null };
  }
}
