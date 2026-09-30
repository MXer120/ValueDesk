# @valuescan/copy-contract

TypeScript bindings for `ValuescanCopyTrading`, the on-chain record of copy trading on SoDEX. The contract lives on
ValueChain (chain 286623) as a UUPS proxy owned by a 48 h TimelockController. It never holds or moves funds.

- The integration guide, with exact end-to-end sequences: [`docs/contracts/INTEGRATION.md`](../../docs/contracts/INTEGRATION.md)
- The spec (normative for behaviour): [`docs/contracts/COPY-TRADING.md`](../../docs/contracts/COPY-TRADING.md)

Three rules shape this package:

- **Isomorphic.** Pure TypeScript plus `@noble/*`. `src/` compiles with no Node or DOM typings, and a test scans it
  for `Buffer`, `process`, `fetch` and similar. The web app, the relayer, the executor and the indexer share the same
  bytes.
- **It never sends anything.** It builds typed data, calldata, log filters and proposals, and decodes what you
  fetched.
- **Pinned by the contract itself.** `tools/gen-vectors.ts` writes `test/vectors.json` and
  `contracts/test/CrossCheckVectors.t.sol` from one scenario, and Foundry replays it against the real contract
  behind an ERC1967Proxy.

**Nothing is deployed.** `DEPLOYMENTS` is empty, and every function takes the proxy address explicitly.

## Modules

| Module | What it gives you |
|---|---|
| `abi.ts`, `abi/*.abi.json` | The implementation's ABI (what the proxy exposes) and the TimelockController's, extracted from `contracts/out` |
| `constants.ts`, `types.ts` | `CopyTradingConstants` mirrored (SoDEX fee caps, key-name rule, type strings and hashes), enums, structs, off-chain protocol parameters |
| `calldata.ts` | `calls.*` for every function and `results.*` for every view; `decodeCall`, `decodeRevert` |
| `eip712.ts` | Typed data, digests and signers for every `...WithSig` action: `prepareSubscribe` (with `stopEpoch` and `expectedLastId`, the key's `lastSubscriptionFor`; audit SEC-04), `prepareUpdateSubscription`, `preparePauseSubscription`, `prepareResumeSubscription`, `prepareUnsubscribe`, `prepareUnsubscribeAll`, `prepareInvalidateNonces`; `symbolsHash`; `domainFromEip712Domain` |
| `validate.ts` | `subscriptionProblems` / `termsProblems` in the contract's check order (the first problem is the contract's revert); `storedSubscription`; onboarding helpers |
| `events.ts` | Typed decoding of every event, log filters, block timestamps, receipts |
| `state.ts` | `CopyTradingIndex`: rebuilds the state from the events and answers every view as the contract does, including the stop-epoch rule (a kill switch is one event) and the live set's swap-and-pop order. `ChainView`: stops at the tip, activations once confirmed, reorgs |
| `executor.ts` | `copyMode`, `gateSignal` (scope, symbols, cycle protection, staleness), `builderForOrder`, `evaluatePreflight`, `isServiceable`, ClobGateway calldata |
| `merkle.ts` | Execution-commitment leaf format v1, an OpenZeppelin-compatible tree, the published document, `verifyExecution` |
| `relay.ts` | The relayer's wire format, `buildRelayTransaction` (policy, ECDSA normalisation, the key-issuance filter), `classifyRevert`, digest-based idempotency (`isSameSignedAction`), nonce choice, rate limiting |
| `timelock.ts` | Proposals (`upgradeProposal`, `ownerCallProposal`, `timelockCalls`) and the announcement monitor (`decodeTimelockLog`, `describeScheduledCall`, `announcementSeverity`, `delayIsSafe`) |
| `signature.ts`, `abiCodec.ts`, `bytes.ts` | ECDSA exactly as OpenZeppelin accepts it; a strict ABI codec; hex, address and integer helpers |

## Develop

```bash
npx tsx --test test/*.test.ts   # 95 tests (viem is the independent reference; no network)
npm run typecheck               # src/ without Node or DOM typings; tests and tools with Node typings
npm run abi                     # after `forge build` in contracts/: rewrite abi/*.json and src/abi.ts (abi:check to verify)
npm run vectors                 # rewrite test/vectors.json and contracts/test/CrossCheckVectors.t.sol (vectors:check to verify)
```

Then prove the vectors against the contract, from `contracts/`:
`forge test --match-path test/CrossCheckVectors.t.sol`.

`npm run vectors` runs `forge fmt` on the Solidity file when Foundry is found (`%USERPROFILE%/.foundry/bin` or
`PATH`). `vectors:check` compares that file whitespace-insensitively, so a formatter change never makes the vectors
stale.

**TEST-ONLY keys.** The vectors are signed with two private keys, each the keccak256 of a public label in
`tools/gen-vectors.ts`. They are published in this repository, so anyone can sign with them: never fund them, and
never use them on any chain.
