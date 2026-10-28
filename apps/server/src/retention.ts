/**
 * Nothing is deleted for being old unless the owner said so (2026-10-28: "ensure we never lose
 * data unless I confirm we should delete it - this is everything"). Every age-based prune of
 * history - the index's raw fills, activity, cohort series, the heatmap's snapshots and level
 * log, the status page's record, the builder ledger, client error alerts - asks mayPrune()
 * first, and without the owner's word does nothing.
 *
 * The word is VALUESCAN_PRUNE in the server's env: a comma list of PRUNE_KINDS, or `all`.
 * Unset (the default) keeps everything. The disk is the limit then: the health check warns at
 * HEALTH_DISK_PCT (80%) long before it fills, and the owner decides what may go.
 *
 * Not history, and still cleared as it always was: work queues, caches, one-time sign-in
 * nonces, a current state whose changes are kept elsewhere (liq_cur: liq_log keeps them), and
 * what someone asked to delete (a folder, a notice, an error report, a wallet dropped).
 */
export const PRUNE_KINDS = [
  'fills', 'activity', 'trader-stats', 'cohort-history', 'liq-history', 'liq-log', 'status', 'builder', 'client-errors',
] as const;
export type PruneKind = (typeof PRUNE_KINDS)[number];

/** Whether the owner allowed `kind` to be pruned (VALUESCAN_PRUNE). */
export function mayPrune(kind: PruneKind, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const said = (env.VALUESCAN_PRUNE ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return said.includes('all') || said.includes(kind);
}
