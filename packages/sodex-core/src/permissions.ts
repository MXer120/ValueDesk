/**
 * SoDEX API-key permission mask - the CORRECTED model.
 *
 * `permissions` is a DISABLE mask. A SET BIT DISABLES THE PERMISSION. That is
 * SoDEX's wire semantics, stated in three independent places: the Go SDK enum
 * ("A set bit disables the corresponding permission." -
 * common/enums/api_key_permission.go), the Python SDK enum ("Disabled-permission
 * bits") and the REST schema (APIKeyPermissionEnum: "A bit value of 1 means the
 * permission is disabled. If permissions is omitted, all permissions are
 * enabled."). So an ORDINARY key - one registered with no `permissions` field -
 * is mask 0 and can do everything, including withdraw.
 *
 *   bit  value  name      what it covers (schema text, 2026-09)
 *   0    1      TRADE     place, replace, modify and cancel orders; schedule cancels;
 *                         update perps leverage, margin and collateral
 *   1    2      CANCEL    cancel orders and schedule cancels
 *   2    4      WITHDRAW  withdraw from spot or perps to EVM or the other engine
 *   3    8      TRANSFER  sub-account and internal transfers within spot or perps
 *
 * Two documented constraints on REGISTRATION (public API page + schema):
 *   1. A permissioned key MUST disable TRADE, CANCEL or both - "enabling both
 *      TRADE and CANCEL is not supported". So a "trade + cancel, cannot
 *      withdraw" key CANNOT be created today.
 *   2. `builder` and `permissions` are mutually exclusive in one request.
 *
 * Opentrade's first version read these bits as GRANTS and minted mask 3 as a
 * "trade-only session key". Per the docs, mask 3 is the opposite: TRADE and
 * CANCEL disabled, WITHDRAW and TRANSFER enabled. Nothing here ports that.
 *
 * Consequence for Valuescan: the browser trading key is an ORDINARY key (no
 * `permissions`, optionally registered with a builder). Per SoDEX docs -
 * unverified by us - such a key can trade AND move funds between the owner's
 * own spot engine, perps engine and the owner's own EVM wallet. See
 * `ORDINARY_KEY_SCOPE` for the wording the UI must show.
 *
 * Nothing about this has been observed end to end by this codebase: no key
 * minted here has been refused a withdrawal. The semantics are DOCUMENTED, not
 * VERIFIED - Opentrade/docs/PERMISSION-MASK.md has the testnet plan.
 */

export const APIKeyPermission = { TRADE: 1, CANCEL: 2, WITHDRAW: 4, TRANSFER: 8 } as const;
export type APIKeyPermissionName = keyof typeof APIKeyPermission;

export const ALL_PERMISSION_BITS =
  APIKeyPermission.TRADE | APIKeyPermission.CANCEL | APIKeyPermission.WITHDRAW | APIKeyPermission.TRANSFER;

/** The wire mask of an ordinary key: nothing disabled. Also what an absent `permissions` means. */
export const ORDINARY_KEY_MASK = 0;

export class PermissionMaskError extends Error {
  override name = 'PermissionMaskError';
}

/** The wire mask for a key that may do exactly `enabled` and nothing else. */
export const disableAllBut = (enabled: number): number => ALL_PERMISSION_BITS & ~enabled;

/**
 * Normalise a mask read from the gateway. Absent (`undefined`/`null`) means an
 * ordinary key - every permission ENABLED - not "no permissions".
 */
export const effectiveMask = (mask: number | null | undefined): number =>
  mask === undefined || mask === null ? ORDINARY_KEY_MASK : mask;

/** Whether a key with wire mask `mask` has permission `bit`. Absent mask = 0 = everything. */
export const permits = (mask: number | null | undefined, bit: number): boolean =>
  (effectiveMask(mask) & bit) === 0;

/** Whether a key with wire mask `mask` can move funds by any route SoDEX documents. */
export const canMoveFunds = (mask: number | null | undefined): boolean =>
  permits(mask, APIKeyPermission.WITHDRAW) || permits(mask, APIKeyPermission.TRANSFER);

/** Upper-case names of the permissions a wire mask leaves ENABLED. */
export const enabledPermissions = (mask: number | null | undefined): APIKeyPermissionName[] =>
  (Object.keys(APIKeyPermission) as APIKeyPermissionName[]).filter((n) => permits(mask, APIKeyPermission[n]));

/** Upper-case names of the permissions a wire mask DISABLES. */
export const disabledPermissions = (mask: number | null | undefined): APIKeyPermissionName[] =>
  (Object.keys(APIKeyPermission) as APIKeyPermissionName[]).filter((n) => !permits(mask, APIKeyPermission[n]));

/** Why `mask` is not an acceptable `permissions` value for AddPermissionedAPIKey, or null. */
export function permissionedMaskProblem(mask: unknown): string | null {
  if (typeof mask !== 'number' || !Number.isInteger(mask)) return 'permissions must be an integer bit mask';
  if (mask < 0 || (mask & ~ALL_PERMISSION_BITS) !== 0) {
    return `permissions may only use bits TRADE(1) | CANCEL(2) | WITHDRAW(4) | TRANSFER(8); got ${mask}`;
  }
  if ((mask & (APIKeyPermission.TRADE | APIKeyPermission.CANCEL)) === 0) {
    return (
      'a permissioned key must DISABLE TRADE, CANCEL or both (a set bit disables); ' +
      `mask ${mask} enables both, which SoDEX does not support. ` +
      'For a key that can trade, register an ordinary key (omit permissions).'
    );
  }
  return null;
}

/** AddPermissionedAPIKey accepts only masks that disable TRADE, CANCEL or both. */
export const isPermissionedKeyMask = (mask: unknown): mask is number => permissionedMaskProblem(mask) === null;

/** Throws PermissionMaskError unless `mask` is a documented-valid permissioned mask. */
export function assertPermissionedMask(mask: unknown): number {
  const problem = permissionedMaskProblem(mask);
  if (problem) throw new PermissionMaskError(problem);
  return mask as number;
}

/**
 * Enforce the registration-scope rules before anything is signed:
 * `builder` XOR `permissions` (or neither), and a valid mask when present.
 */
export function assertRegistrationScope(opts: { builder?: unknown; permissions?: unknown }): void {
  const hasBuilder = opts.builder !== undefined && opts.builder !== null;
  const hasPermissions = opts.permissions !== undefined && opts.permissions !== null;
  if (hasBuilder && hasPermissions) {
    throw new PermissionMaskError('`builder` and `permissions` are mutually exclusive in one API-key registration');
  }
  if (hasPermissions) assertPermissionedMask(opts.permissions);
}

export interface KeyScope {
  mask: number;
  ordinary: boolean;
  canTrade: boolean;
  canCancel: boolean;
  canWithdraw: boolean;
  canTransfer: boolean;
  canMoveFunds: boolean;
  /** Always false: these are documented semantics, not observed ones. */
  verified: false;
  /** One honest sentence for the UI. */
  summary: string;
}

/**
 * The wording the UI must show for an ORDINARY key (the Valuescan browser key).
 * Keep "per SoDEX docs, unverified" - it is both.
 */
export const ORDINARY_KEY_SCOPE =
  'Can place and cancel orders and change leverage and margin. Per SoDEX docs (unverified) it can also move ' +
  'funds between your own SoDEX spot and perps accounts and your own EVM wallet; SoDEX documents no way for ' +
  'it to send funds to anyone else. Whoever holds it could still trade your balance badly. It is kept in this ' +
  "tab's memory only and expires automatically.";

/** Describe a wire mask honestly. `undefined` = an ordinary key. */
export function describeKeyScope(mask: number | null | undefined): KeyScope {
  const m = effectiveMask(mask);
  const canTrade = permits(m, APIKeyPermission.TRADE);
  const canCancel = permits(m, APIKeyPermission.CANCEL);
  const canWithdraw = permits(m, APIKeyPermission.WITHDRAW);
  const canTransfer = permits(m, APIKeyPermission.TRANSFER);
  const ordinary = m === ORDINARY_KEY_MASK;
  let summary: string;
  if (ordinary) {
    summary = ORDINARY_KEY_SCOPE;
  } else {
    const on = enabledPermissions(m).map((n) => n.toLowerCase());
    summary =
      (on.length ? `Enabled per SoDEX docs (unverified): ${on.join(', ')}.` : 'Every permission disabled.') +
      (canMoveFunds(m) ? ' This key can move funds.' : ' Per SoDEX docs it cannot move funds.');
  }
  return {
    mask: m,
    ordinary,
    canTrade,
    canCancel,
    canWithdraw,
    canTransfer,
    canMoveFunds: canWithdraw || canTransfer,
    verified: false,
    summary,
  };
}
