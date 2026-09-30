/**
 * Protocol constants of ValuescanCopyTrading v1 (implementation `1.0.0`, UUPS behind an ERC-1967 proxy).
 *
 * Every on-chain value below mirrors `CopyTradingConstants` in contracts/src/interfaces/IValuescanCopyTrading.sol (the
 * normative source); test/constants.test.ts parses that Solidity file and fails if anything here drifts from it. The
 * off-chain parameters at the end are normative in docs/contracts/COPY-TRADING.md and are not enforced by the contract.
 */
import type { Address, Hex } from './bytes.ts';

// ---------------------------------------------------------------------------
// Chain (ValueChain, where SoDEX settles)
// ---------------------------------------------------------------------------

/** ValueChain mainnet chain id (0x45f9f). The EIP-712 domain uses it, so wallets must be on this chain to sign. */
export const VALUECHAIN_CHAIN_ID = 286_623;
export const VALUECHAIN_RPC_URL = 'https://rpc.valuechain.xyz';
export const VALUECHAIN_EXPLORER_URL = 'https://main-scan.valuechain.xyz';
/** Native gas token of ValueChain (18 decimals). Only the relayer, or a follower calling directly, needs it. */
export const VALUECHAIN_NATIVE_SYMBOL = 'SOSO';
/** Approximate block time. The contract is not in the per-trade hot path (a copy takes ~0.1 s). */
export const VALUECHAIN_BLOCK_TIME_SECONDS = 2;

// ---------------------------------------------------------------------------
// SoDEX ClobGateway (read-only preflight, and the follower's on-chain key path)
// ---------------------------------------------------------------------------

/**
 * SoDEX ClobGateway on ValueChain. This package never calls it: it builds calldata for the executor's read-only
 * `eth_call` preflight (`getAccountsByAddress`) and for followers who add or revoke keys on-chain themselves.
 */
export const SODEX_CLOB_GATEWAY: Address = '0x0101010101010101010101010101010101010101';
/** ClobGateway selectors (research report 07, G1; named in verified SoSoValue sources). */
export const SODEX_GATEWAY_SELECTORS = {
  /** `getAccountsByAddress(address) returns (uint256[])`, read-only. */
  getAccountsByAddress: '0x380e78af',
  /** `addAPIKey(uint256 destination, string name, bytes pubkey)`; 0 = spot, 1 = perps; msg.sender = account owner. */
  addAPIKey: '0x8b53c6b9',
  /** `revokeAPIKey(uint256 destination, string name)`; msg.sender = account owner. */
  revokeAPIKey: '0x54ed5933',
} as const satisfies Record<string, Hex>;
/** ClobGateway engine ids (`destination`): 0 = spot, 1 = perps. */
export const SODEX_GATEWAY_ENGINE = { spot: 0, perps: 1 } as const;

// ---------------------------------------------------------------------------
// Contract identity
// ---------------------------------------------------------------------------

/** `VERSION()` of the implementation this package targets. Every upgrade changes it. */
export const CONTRACT_VERSION = '1.0.0';
/** `UPGRADE_INTERFACE_VERSION()` of OpenZeppelin's UUPSUpgradeable 5.x. */
export const UPGRADE_INTERFACE_VERSION = '5.0.0';

/** A deployment. Callers pass `proxy` everywhere: it is the contract address and the EIP-712 verifyingContract. */
export interface Deployment {
  chainId: number;
  /** The ERC-1967 proxy: the address everyone uses. Never changes across upgrades. */
  proxy: Address;
  /** The current implementation (informational; read the ERC-1967 slot or follow `Upgraded`). */
  implementation: Address;
  /** The TimelockController that owns the proxy. */
  timelock: Address;
  /** Block of the proxy's deployment: indexers start their log scan here. */
  deployBlock: bigint;
}

/**
 * Known deployments by chain id. EMPTY ON PURPOSE: nothing is deployed. Every function in this package takes the proxy
 * address explicitly; once the owner deploys (after an audit and an explicit go) the deployment is added here.
 */
export const DEPLOYMENTS: Readonly<Record<number, Deployment>> = Object.freeze({});

/** ERC-1967 implementation slot: `eth_getStorageAt(proxy, slot)` returns the implementation address (low 20 bytes). */
export const ERC1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** ERC-7201 root of the contract's own state (`valuescan.storage.CopyTrading`), spec §4.3. */
export const COPY_TRADING_STORAGE_LOCATION: Hex = '0xc3b2bc2cf6fc6db46d2b311dd8531e2120cf7207f8eeaaf9015bcf1d32c6bf00';

// ---------------------------------------------------------------------------
// Venues (owner-managed registry; more ids can be enabled without an upgrade)
// ---------------------------------------------------------------------------

/** Venue ids enabled by `initialize`. The leader trades there; copies are always placed on SoDEX. */
export const Venue = { SODEX: 1, HYPERLIQUID: 2 } as const;
export type VenueId = number;

// ---------------------------------------------------------------------------
// Bounds (CopyTradingConstants). These are the ONLY bounds: SoDEX's rules and plain validity. No product limits.
// ---------------------------------------------------------------------------

/** SoDEX hard cap on the per-order builder fee for perps, tenths of a bp (200 = 0.2 %). */
export const PERPS_BUILDER_FEE_CAP = 200;
/** SoDEX hard cap on the per-order builder fee for spot, tenths of a bp (2000 = 2 %). */
export const SPOT_BUILDER_FEE_CAP = 2000;
/** 100 % in bps: the validity bound of slippage, per-trade stop loss and drawdown. Take profit has no bound. */
export const MAX_BPS = 10_000;
/** SoDEX's API-key name rule `^[0-9a-zA-Z_-]{1,36}$`: maximum length. */
export const MAX_KEY_NAME_LENGTH = 36;
/** SoDEX's reserved name of the master key; never a delegated key's name. */
export const RESERVED_KEY_NAME = 'default';

/** Unit helpers. */
export const PPM = 1_000_000n;
export const USD_DECIMALS = 6;
export const BPS = 10_000;

/** `expiry` value meaning "never expires". */
export const NEVER_EXPIRES = 0;

// ---------------------------------------------------------------------------
// EIP-712 (spec §6). The name and version are pinned in the implementation's code and stable across upgrades.
// ---------------------------------------------------------------------------

export const EIP712_NAME = 'ValuescanCopyTrading';
export const EIP712_VERSION = '1';

export const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

export const TERMS_TYPE =
  'Terms(address delegatedKey,string keyName,uint8 marketScope,uint8 sizingMode,uint64 sizingValue,uint64 allocationCap,uint64 maxPositionNotional,uint8 maxLeverage,uint16 tradeStopLossBps,uint16 maxDrawdownBps,uint32 takeProfitBps,uint16 slippageBps,uint8 symbolMode,string[] symbols,bool copyExisting,uint16 maxBuilderFeePerps,uint16 maxBuilderFeeSpot,uint40 expiry)';
export const SUBSCRIBE_TYPE =
  'Subscribe(address follower,uint8 venue,address leader,uint64 sodexAccountId,Terms terms,uint64 stopEpoch,uint256 expectedLastId,uint256 nonce,uint256 deadline)' +
  TERMS_TYPE;
export const UPDATE_TYPE =
  'UpdateSubscription(address follower,uint256 subscriptionId,uint32 expectedVersion,Terms terms,uint256 nonce,uint256 deadline)' +
  TERMS_TYPE;
export const PAUSE_TYPE = 'PauseSubscription(address follower,uint256 subscriptionId,uint256 nonce,uint256 deadline)';
export const RESUME_TYPE =
  'ResumeSubscription(address follower,uint256 subscriptionId,uint32 expectedVersion,uint256 nonce,uint256 deadline)';
export const UNSUBSCRIBE_TYPE =
  'Unsubscribe(address follower,uint256 subscriptionId,bool closePositions,uint256 nonce,uint256 deadline)';
export const UNSUBSCRIBE_ALL_TYPE = 'UnsubscribeAll(address follower,bool closePositions,uint256 nonce,uint256 deadline)';
export const INVALIDATE_NONCES_TYPE =
  'InvalidateNonces(address follower,uint256 word,uint256 mask,uint256 nonce,uint256 deadline)';

/**
 * Type hashes as published in COPY-TRADING.md §6.2. test/constants.test.ts recomputes each one from the type strings
 * above and from the typed-data field lists in eip712.ts; the Foundry cross-check compares them with the contract's.
 */
export const TYPEHASH = {
  Terms: '0x4836445cef1a48d6c13fd7b25c5a0c1aea5b79c376ba7bf3e291aa826c4bda13',
  Subscribe: '0x9f83367e0514f6df54c98de57d31d3931ff835719531b30ebe06c8ba66ab81e1',
  UpdateSubscription: '0x9edc7b1f1dce4c621fab4163454b540147d0bb06f50e068005bd38343256611e',
  PauseSubscription: '0xada566bbbc82b7e983663be2501f0a3b282f5c89abb16a5a2756f15a256e1e35',
  ResumeSubscription: '0x742f800a62127bcff440e887780727786fa1d07c42cf824a2317a7262deb1000',
  Unsubscribe: '0x0393009ed3c7c395080d3cd2b68b698f33344f2df3d47bcea22bc4be00538440',
  UnsubscribeAll: '0x6f5c9aba97af2ddc806df4faff312b4feb13afbfab1ae4a60ba7dce22e958177',
  InvalidateNonces: '0x2666c3d4e309127c5355dfdd7da6cc09b9323956e84c17da20538a388b80fd03',
} as const satisfies Record<string, Hex>;

/** ERC-1271 `isValidSignature` magic value. */
export const ERC1271_MAGIC_VALUE: Hex = '0x1626ba7e';

// ---------------------------------------------------------------------------
// Off-chain protocol parameters (normative in COPY-TRADING.md, not enforced by the contract)
// ---------------------------------------------------------------------------

/**
 * Executor stop SLA (§8.3): no opening or increasing order later than this after the timestamp of the block containing
 * SubscriptionStopped, SubscriptionPaused, KillSwitchTriggered, or a key-changing or tightening SubscriptionUpdated.
 */
export const STOP_SLA_SECONDS = 10;
/** Confirmations an executor SHOULD wait before acting on an activation (subscribe, resume, loosening update). */
export const ACTIVATION_CONFIRMATIONS = 2;
/** Flatten window after a stop with `closePositions` (§8.3), best effort. */
export const CLOSE_POSITIONS_WINDOW_SECONDS = 60;
/** Widest limit for flattening retries: 3 x slippageBps (§8.3). */
export const CLOSE_POSITIONS_MAX_SLIPPAGE_MULTIPLIER = 3;
/** Re-check a failed preflight at most this often (§8.3). */
export const PREFLIGHT_RECHECK_SECONDS = 60;
/** Reconcile the event-sourced model with the views this often (§8.3). */
export const RECONCILE_INTERVAL_SECONDS = 3_600;
/** Skip leader signals older than this (§8.3: "for example 2 s"; the published staleness limit). */
export const SIGNAL_STALENESS_MS = 2_000;
/** How long an executor may cache a leader's equity for PROPORTIONAL sizing (§4.5). */
export const LEADER_EQUITY_CACHE_SECONDS = 60;
/** Commitment epoch length: the unix hour (§7.2). */
export const COMMITMENT_EPOCH_SECONDS = 3_600;
/** Recommended gas cap per relayed transaction (§6.7), which bounds ERC-1271 gas griefing. */
export const RELAYER_GAS_CAP = 2_000_000n;
/**
 * Recommended deadline of signed actions that start or raise risk (Subscribe, UpdateSubscription, ResumeSubscription).
 * Short on purpose: a withheld signature stays valid until its deadline, and an `unsubscribe` does not void a pending
 * Subscribe for the same leader (audit SEC-04; only the kill switch does, through the stop epoch).
 */
export const RISK_ACTION_DEADLINE_SECONDS = 900;
/** Recommended deadline of a pre-signed emergency UnsubscribeAll that the follower or a watchdog keeps (§6.6). */
export const EMERGENCY_STOP_DEADLINE_SECONDS = 365 * 86_400;
/** Recommended TimelockController delay (§10.2): followers see a scheduled upgrade 48 h before it can run. */
export const TIMELOCK_MIN_DELAY_SECONDS = 172_800;
/** Domain tag of execution-commitment leaves (§7.2): keccak256("ValuescanExecution.v1"). */
export const EXECUTION_LEAF_TAG_STRING = 'ValuescanExecution.v1';
