# Valuescan copy trading contract (Foundry)

The on-chain copy trading record for Valuescan. It records:

- who copies which leader address, and under which rules;
- through which delegated SoDEX API key;
- at which maximum builder fee;
- the execution commitments of Valuescan's executors.

**It never holds or moves funds.** SoDEX handles all funds, margin and settlement.

The contract is upgradeable: UUPS behind an ERC1967Proxy, with ERC-7201 storage. The recommended owner is a
TimelockController (48 h) in front of a multisig.

- Spec: [`../docs/contracts/COPY-TRADING.md`](../docs/contracts/COPY-TRADING.md)
- Interface: [`src/interfaces/IValuescanCopyTrading.sol`](src/interfaces/IValuescanCopyTrading.sol)
- Implementation: [`src/ValuescanCopyTrading.sol`](src/ValuescanCopyTrading.sol)
- Storage-layout snapshot: [`storage-layout/ValuescanCopyTrading.json`](storage-layout/ValuescanCopyTrading.json)
  (guard: [`tools/storage-layout.mjs`](tools/storage-layout.mjs))

> **Hard rule.** Nothing in this directory is deployed or broadcast, on mainnet or testnet, without the owner's
> explicit go.
>
> - Never run `forge script ... --broadcast`, `forge create` or `cast send`.
> - `script/DeployValuescanCopyTrading.s.sol` is marked DO NOT RUN: its `run()` always reverts, and it holds no key.
> - Tests use only Foundry-generated keys (`vm.addr`, `makeAddr`).
> - Read-only `cast call` / `eth_call` against ValueChain is fine.

## Commands

Run from this directory. On Windows, use git-bash, or prefix each command with the full path to `forge.exe`.

```bash
export PATH="$USERPROFILE/.foundry/bin:$PATH"   # git-bash; PowerShell: $env:Path = "$env:USERPROFILE\.foundry\bin;$env:Path"

forge --version                 # forge 1.8.3 (cae51ad, 2026-09-15)
forge build                     # compile (solc 0.8.36, via-IR, evm prague)
forge build --sizes             # contract sizes (EIP-170: 24,576 bytes runtime; the implementation is 22,531)
forge test                      # everything (the invariant campaign takes about 5 minutes)
forge test --no-match-path "test/invariant/*"            # everything except the invariant campaign (seconds)
forge test -vv --match-path test/spec/EIP712Spec.t.sol   # EIP-712 vectors, printed
forge test --match-path test/gas/Gas.t.sol               # gas per action -> snapshots/ValuescanCopyTrading.json
forge snapshot                  # write .gas-snapshot
forge coverage --ir-minimum --report summary --no-match-path "test/invariant/*"
                                # coverage (via-IR is required: the plain unoptimised build is "stack too deep")
node tools/storage-layout.mjs check      # storage-layout guard (after forge build); also: update, selftest
FOUNDRY_PROFILE=ci forge test   # 10k fuzz runs, 1000 x 200 invariant runs (long)
forge fmt                       # format; `forge fmt --check` in CI
forge lint                      # lints src/ (reviewed exclusions in foundry.toml)
```

Results on 2026-09-25:

- `forge test`: 235 tests pass, 0 fail, 0 skipped (23 suites, including the audit regression tests under
  `test/audit/` and the SDK cross-check). The invariants ran 256 runs × depth 100 = 25,600 calls, with
  `fail_on_revert = true`.
- Coverage of `src/ValuescanCopyTrading.sol`: 98.4 % lines, 98.5 % statements, 100 % branches, 100 % functions.
- The spec's Audit log lists every audit finding and its resolution.
- The spec §14 has the details.

## Toolchain (pinned)

| Tool | Version | Source | Verification |
|---|---|---|---|
| Foundry (forge, cast, anvil, chisel) | **v1.8.3** stable, commit `cae51ad` | `https://github.com/foundry-rs/foundry/releases/download/v1.8.3/foundry_v1.8.3_win32_amd64.zip`, unzipped into `%USERPROFILE%\.foundry\bin` | SHA-256 `e4d7302fa708423c8799f5a229dfecef311cfd68b046ce782788096318946304`, equal to the release's `.sha256` file |
| solc | **0.8.36** (2026-07-09) | downloaded by forge from `binaries.soliditylang.org` | pinned in `foundry.toml` (`auto_detect_solc = false`) |
| OpenZeppelin Contracts | **v5.7.0** (2026-07-29) | `https://codeload.github.com/OpenZeppelin/openzeppelin-contracts/tar.gz/refs/tags/v5.7.0` | tarball SHA-256 `b22c8372c556d64b4f7d614e06e555e181fda90b23f7389ab9e807a5cf59d942` |
| OpenZeppelin Contracts Upgradeable | **v5.7.0** (same release as above) | `https://codeload.github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/tar.gz/refs/tags/v5.7.0` | tarball SHA-256 `be15847806bbb2b1120f84d48acda2f6b8105f8c4684f12d9284cd80c0aa59f9` (downloaded twice on 2026-09-25, identical). `lib/openzeppelin-contracts-upgradeable/contracts` is byte-identical to the tarball's `contracts/` (`diff -r`), and so are `LICENSE`, `README.md` and `package.json` (version 5.7.0) |
| forge-std | **v1.16.2** (2026-06-30) | `https://codeload.github.com/foundry-rs/forge-std/tar.gz/refs/tags/v1.16.2` | tarball SHA-256 `35dbdf9c98db566f150a70b723f11d831feebb01ce615245a4fcaa4652fd4275` |

The libraries are **vendored** under `lib/` (not git submodules), trimmed to `contracts/` or `src/` plus the licence,
README and `package.json`. Nothing is fetched at build time, and no git operation is needed. The upgradeable package
imports `@openzeppelin/contracts/` at the same version, through the remapping in `foundry.toml`. To upgrade a library:

1. download the new tag tarball from the official repository;
2. check its hash;
3. replace the folder;
4. update this table.

How Foundry was installed (2026-09-25): `foundryup` was not used. The official Windows zip above was downloaded with
`curl`, its SHA-256 was checked against the release's checksum file, and it was unzipped into
`%USERPROFILE%\.foundry\bin`. That directory is **not** on the system `PATH`; add it per shell as shown above.

### Why solc 0.8.36, and via-IR

solc 0.8.36 is the newest release that has been in the field for more than two months (0.8.37 is from 2026-09-10).
Its known bugs, per `bugs_by_version.json`, and how the code avoids them:

| Known bug | Rule |
|---|---|
| `MisorderedNamedParametersInRequireWithCustomErrors` | Never use named arguments inside `require(cond, CustomError({...}))`. The contract uses `if (!cond) revert CustomError(...)` only |
| `MemoryByteArrayElementDeleteClearsWholeWord` | Never `delete b[i]` on a `bytes memory` |
| `SpillSlotCollisionAcrossMutualRecursion` | via-IR only, and it needs mutual recursion. The contract has no recursion of any kind |

**via-IR is on** because of EIP-170. The UUPS implementation is 22,531 bytes with via-IR and about 28 KB without it
(limit 24,576). The test suite asserts at least 1.5 KB of headroom, so that future upgrades have room.

Two consequences:

- `forge coverage` needs `--ir-minimum`.
- In tests, never re-read `block.timestamp` after `vm.warp`, because the optimiser may reuse the old value. Use
  constants, or `vm.getBlockTimestamp()`.

Move to 0.8.37 once it has aged, after re-running the full suite.

## EVM version: `prague`

ValueChain (chain id 286623, `web3_clientVersion` = `Geth/vvalue-geth/1.1.1-stable-f3f4a0ac/linux-amd64/go1.24.0`)
was probed on 2026-09-25 with **read-only** `eth_call`s against `https://rpc.valuechain.xyz`, block tag `latest`.
The calls have no `to`, so the data runs as init code and is never deployed.

| Probe | Init code | Result | Means |
|---|---|---|---|
| control | `0x602a60005260206000f3` | returns 42 | the method works |
| PUSH0 (Shanghai) | `0x602a5f5260205ff3` | returns 42 | Shanghai |
| TSTORE/TLOAD (Cancun) | `0x602a60015d60015c60005260206000f3` | returns 42 | Cancun |
| MCOPY (Cancun) | `0x602a6000526020600060205e60206020f3` | returns 42 | Cancun |
| BLOBBASEFEE (Cancun) | `0x4a60005260206000f3` | returns 1 | Cancun |
| STATICCALL to `0x0a` (KZG), empty input | `0x6000600060006000600a5afa60005260206000f3` | returns 0 (call failed) | precompile present: Cancun |
| STATICCALL to `0x0b` (BLS12-381 G1ADD), empty input | `0x6000600060006000600b5afa60005260206000f3` | returns 0 (call failed) | precompile present: **Prague** |
| STATICCALL to `0xff` (empty account), control | `0x60006000600060006100ff5afa60005260206000f3` | returns 1 | an absent precompile would succeed |
| CLZ `0x1e` (Osaka) | `0x60011e60005260206000f3` | error `invalid opcode: opcode 0x1e not defined` | **not** Osaka |

`eth_getBlockByNumber("latest")` also carries `requestsHash` (EIP-7685, Prague), `parentBeaconBlockRoot`,
`blobGasUsed`/`excessBlobGas` (Cancun) and `withdrawalsRoot` (Shanghai). Block gas limit 30,000,000; base fee
1,000,000 wei (0.001 gwei); `eth_gasPrice` 2,000,000 wei.

Re-run a probe:

```bash
curl -s -H 'Content-Type: application/json' https://rpc.valuechain.xyz \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"data":"0x60011e60005260206000f3","gas":"0x1000000"},"latest"]}'
```

If ValueChain later adopts Osaka, `prague` bytecode still runs. Only move `evm_version` up after a new probe.

## Storage-layout guard

All state lives in the ERC-7201 namespace `valuescan.storage.CopyTrading`. Upgrades may only **append** (spec §10.3).
Two checks enforce this:

- `node tools/storage-layout.mjs check` compares the compiler's layout of the namespace with the committed snapshot
  `storage-layout/ValuescanCopyTrading.json`. It reads the layout through the harness
  `test/upgrade/StorageLayoutHarness.sol`. Run it after `forge build`. It exits 1 on any reorder, retype, rename,
  removal, insertion, offset change, moved location, or growth of an inline struct that is not the last member, and
  on any change to a stored enum's members except an append (audit SEC-01; the members are read from `src/`).
  - `update` records an append, and refuses anything else.
  - `selftest` proves the rules on 19 synthetic cases, plus a check of the enum parser.
- `test/upgrade/StorageLayout.t.sol` (part of `forge test`) pins the ERC-7201 root and the raw slot and packing of
  every member with `vm.load`, and the ordinal of every enum member.

## Layout

```
contracts/
  foundry.toml, remappings.txt
  src/interfaces/IValuescanCopyTrading.sol   interface + CopyTradingConstants (bounds, EIP-712 type strings, hashes)
  src/ValuescanCopyTrading.sol               UUPS implementation (ERC-7201 storage, locked constructor)
  script/DeployValuescanCopyTrading.s.sol    DO NOT RUN: documents the timelock + proxy wiring; run() reverts
  storage-layout/ValuescanCopyTrading.json   committed storage-layout snapshot
  tools/storage-layout.mjs                   storage-layout guard (check | update | selftest)
  snapshots/ValuescanCopyTrading.json        gas per action (written by test/gas/Gas.t.sol)
  .gas-snapshot                              forge snapshot
  test/utils/     CopyTradingBase (fixture, signing helpers), CopyTradingEIP712 (independent reference encoder)
  test/mocks/     ERC-1271 wallets, V2 upgrade mock, domain-bump mock, non-UUPS target, force sender
  test/unit/      deployment, subscribe, lifecycle, kill switch, governance, nonces and funds
  test/signatures/  every ...WithSig path (EOA, ERC-1271, EIP-7702; replay, expiry, chain, contract, version)
  test/fuzz/      every bound
  test/invariant/ handlers, event indexer, invariants I1-I6
  test/upgrade/   UUPS upgrade, timelock flow, storage layout (+ harness)
  test/spec/      EIP-712 vectors against Foundry's encoder
  test/gas/       gas per action with regression bounds
  test/script/    deploy wiring in a local EVM (and run() reverts)
  lib/openzeppelin-contracts, lib/openzeppelin-contracts-upgradeable, lib/forge-std   vendored, pinned
```
