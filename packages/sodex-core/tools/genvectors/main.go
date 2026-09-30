// Command genvectors emits reference signing vectors produced by the OFFICIAL
// SoDEX Go SDK (github.com/sodex-tech/sodex-go-sdk-public). The TypeScript
// signer in packages/sodex-core/src is asserted against this output by
// test/vectors.test.ts and test/vectors-sdk.test.ts.
//
// Ported from Opentrade/server/tools/genvectors.go and EXTENDED for Valuescan:
// the first 19 vectors are generated exactly as Opentrade generated them (so the
// test suite can prove today's SDK still reproduces Opentrade's pinned bytes);
// everything after the "Valuescan additions" marker is new.
//
// This is the whole correctness argument for the signer: rather than trusting a
// hand-port of the EIP-712 + Go-JSON rules, we make the reference implementation
// produce the bytes and require an exact match.
//
// Usage: from packages/sodex-core, run `bash tools/genvectors.sh` (it clones the
// SDK into tools/.cache, copies this file in and runs it), or by hand:
//
//	cp tools/genvectors/main.go tools/.cache/sodex-go-sdk-public/tools/genvectors/main.go
//	(cd tools/.cache/sodex-go-sdk-public && go run ./tools/genvectors) > test/vectors-sdk.json
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/shopspring/decimal"

	"github.com/sodex-tech/sodex-go-sdk-public/common/enums"
	csigner "github.com/sodex-tech/sodex-go-sdk-public/common/signer"
	ctypes "github.com/sodex-tech/sodex-go-sdk-public/common/types"
	ptypes "github.com/sodex-tech/sodex-go-sdk-public/perps/types"
	stypes "github.com/sodex-tech/sodex-go-sdk-public/spot/types"

	perpssgn "github.com/sodex-tech/sodex-go-sdk-public/perps/signer"
	spotsgn "github.com/sodex-tech/sodex-go-sdk-public/spot/signer"
)

// A fixed, well-known throwaway test key. NEVER used for anything real.
const testKeyHex = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"

const testChainID = uint64(138565) // testnet

type vector struct {
	Name        string          `json:"name"`
	Engine      string          `json:"engine"`
	ActionType  string          `json:"actionType"`
	Nonce       uint64          `json:"nonce"`
	PayloadJSON string          `json:"payloadJSON"` // exact bytes hashed
	PayloadHash string          `json:"payloadHash"`
	BodyJSON    string          `json:"bodyJSON"` // what goes on the wire
	Signature   string          `json:"signature"`
	Params      json.RawMessage `json:"params"`
}

// userVector is a master-wallet ("universal" domain, 0x02) action. These are
// EIP-712 typed data over flat structs, so there is no payload JSON: the
// vector pins the full digest the wallet signs and the 66-byte wire signature.
type userVector struct {
	Name string `json:"name"`
	// The EIP-712 primary type the wallet is asked to sign.
	PrimaryType string `json:"primaryType"`
	// Domain chainId (== the X-API-Chain header).
	DomainChainID uint64 `json:"domainChainID"`
	// Message-level chainID (SoDEX network id); 0 when the type has none.
	MessageChainID uint64          `json:"messageChainID"`
	Nonce          uint64          `json:"nonce"`
	Message        json.RawMessage `json:"message"`
	StructHash     string          `json:"structHash"`
	Digest         string          `json:"digest"`
	Signature      string          `json:"signature"`
	Source         string          `json:"source"`
}

func d(s string) *decimal.Decimal { v := decimal.RequireFromString(s); return &v }
func u64(v uint64) *uint64        { return &v }
func str(s string) *string        { return &s }
func boolp(b bool) *bool          { return &b }

// sep returns a domain separator. DomainSeparator has a POINTER receiver in the
// current SDK (it caches), so it cannot be called on the NewEIP712Domain
// return value directly the way Opentrade's copy of this file did.
func sep(name string, chainID uint64) string {
	dm := ctypes.NewEIP712Domain(name, chainID)
	return dm.DomainSeparator().Hex()
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Per-order builder override (perps).
//
// The Go SDK (commit of 2026-07-21) only has the BATCH-level builder on
// perps.NewOrderRequest. The builder-codes doc says "Perps supports a batch
// default and per-order overrides", and the Python SDK (2026-09-08) appends
// `builder` as the LAST key of each RawOrder, after positionSide. These local
// structs mirror that layout so Go's encoding/json (the serialiser the gateway
// re-marshals with) produces the bytes, and the SDK's generic EVMSigner signs
// them. The STRUCT LAYOUT is therefore sourced from the Python SDK + docs, not
// from a Go struct: the vector is labelled accordingly.
// ---------------------------------------------------------------------------

type rawOrderWithBuilder struct {
	ClOrdID      string                `json:"clOrdID"`
	Modifier     enums.OrderModifier   `json:"modifier"`
	Side         enums.OrderSide       `json:"side"`
	Type         enums.OrderType       `json:"type"`
	TimeInForce  enums.TimeInForce     `json:"timeInForce"`
	Price        *decimal.Decimal      `json:"price,omitempty"`
	Quantity     *decimal.Decimal      `json:"quantity,omitempty"`
	Funds        *decimal.Decimal      `json:"funds,omitempty"`
	StopPrice    *decimal.Decimal      `json:"stopPrice,omitempty"`
	StopType     *enums.StopType       `json:"stopType,omitempty"`
	TriggerType  *enums.TriggerType    `json:"triggerType,omitempty"`
	ReduceOnly   bool                  `json:"reduceOnly"`
	PositionSide enums.PositionSide    `json:"positionSide"`
	Builder      *ctypes.BuilderParams `json:"builder,omitempty"`
}

type newOrderPerOrderBuilder struct {
	AccountID uint64                 `json:"accountID"`
	SymbolID  uint64                 `json:"symbolID"`
	Orders    []*rawOrderWithBuilder `json:"orders"`
	Builder   *ctypes.BuilderParams  `json:"builder,omitempty"`
}

func (r *newOrderPerOrderBuilder) ActionName() string { return ptypes.NewOrderRequestTypeName }

func main() {
	pk, err := crypto.HexToECDSA(testKeyHex)
	if err != nil {
		panic(err)
	}
	perps := perpssgn.NewSigner(testChainID, pk)
	spot := spotsgn.NewSigner(testChainID, pk)

	var out []vector

	add := func(name, engine, actionType string, nonce uint64, params ctypes.ActionPayloadParams, sig []byte, err error) {
		if err != nil {
			panic(fmt.Sprintf("%s: %v", name, err))
		}
		payload := &ctypes.ActionPayload{Type: actionType, Params: params}
		h, err := payload.Hash()
		if err != nil {
			panic(err)
		}
		out = append(out, vector{
			Name:        name,
			Engine:      engine,
			ActionType:  actionType,
			Nonce:       nonce,
			PayloadJSON: mustJSON(payload),
			PayloadHash: h.Hex(),
			BodyJSON:    mustJSON(params),
			Signature:   "0x" + hex.EncodeToString(sig),
			Params:      json.RawMessage(mustJSON(params)),
		})
	}

	// =======================================================================
	// Opentrade's original 19 vectors, generated exactly as Opentrade did.
	// =======================================================================

	// --- perps: limit order -------------------------------------------------
	n := uint64(1730000000000)
	limitReq := &ptypes.NewOrderRequest{
		AccountID: 43933, SymbolID: 1,
		Orders: []*ptypes.RawOrder{{
			ClOrdID: "opentrade-limit-1", Modifier: enums.OrderModifierNormal,
			Side: enums.OrderSideBuy, Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTC,
			Price: d("70000.5"), Quantity: d("0.01"),
			ReduceOnly: false, PositionSide: enums.PositionSideBoth,
		}},
	}
	sig, err := perps.SignNewOrderRequest(limitReq, n)
	add("perps_limit_order", "perps", ptypes.NewOrderRequestTypeName, n, limitReq, sig, err)

	// --- perps: market order, reduce-only -----------------------------------
	n++
	mktReq := &ptypes.NewOrderRequest{
		AccountID: 43933, SymbolID: 1,
		Orders: []*ptypes.RawOrder{{
			ClOrdID: "opentrade-mkt-1", Modifier: enums.OrderModifierNormal,
			Side: enums.OrderSideSell, Type: enums.OrderTypeMarket, TimeInForce: enums.TimeInForceIOC,
			Quantity: d("0.001"), ReduceOnly: true, PositionSide: enums.PositionSideBoth,
		}},
	}
	sig, err = perps.SignNewOrderRequest(mktReq, n)
	add("perps_market_reduce_only", "perps", ptypes.NewOrderRequestTypeName, n, mktReq, sig, err)

	// --- perps: stop-loss (exercises stopPrice/stopType/triggerType) --------
	n++
	stopType := enums.StopTypeStopLoss
	trigType := enums.TriggerTypeMarkPrice
	stopReq := &ptypes.NewOrderRequest{
		AccountID: 43933, SymbolID: 1,
		Orders: []*ptypes.RawOrder{{
			ClOrdID: "opentrade-sl-1", Modifier: enums.OrderModifierNormal,
			Side: enums.OrderSideSell, Type: enums.OrderTypeMarket, TimeInForce: enums.TimeInForceIOC,
			Quantity: d("0.5"), StopPrice: d("64000"), StopType: &stopType, TriggerType: &trigType,
			ReduceOnly: true, PositionSide: enums.PositionSideBoth,
		}},
	}
	sig, err = perps.SignNewOrderRequest(stopReq, n)
	add("perps_stop_loss", "perps", ptypes.NewOrderRequestTypeName, n, stopReq, sig, err)

	// --- perps: tiny price, exercises the exponent-notation trap ------------
	n++
	tinyReq := &ptypes.NewOrderRequest{
		AccountID: 43933, SymbolID: 7,
		Orders: []*ptypes.RawOrder{{
			ClOrdID: "opentrade-tiny-1", Modifier: enums.OrderModifierNormal,
			Side: enums.OrderSideBuy, Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTX,
			Price: d("0.0000001"), Quantity: d("1000000"),
			ReduceOnly: false, PositionSide: enums.PositionSideBoth,
		}},
	}
	sig, err = perps.SignNewOrderRequest(tinyReq, n)
	add("perps_tiny_price", "perps", ptypes.NewOrderRequestTypeName, n, tinyReq, sig, err)

	// --- perps: multi-order batch -------------------------------------------
	n++
	multiReq := &ptypes.NewOrderRequest{
		AccountID: 43933, SymbolID: 2,
		Orders: []*ptypes.RawOrder{
			{ClOrdID: "ot-a", Modifier: enums.OrderModifierNormal, Side: enums.OrderSideBuy,
				Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTC,
				Price: d("2500.25"), Quantity: d("1.5"), ReduceOnly: false, PositionSide: enums.PositionSideBoth},
			{ClOrdID: "ot-b", Modifier: enums.OrderModifierNormal, Side: enums.OrderSideSell,
				Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTX,
				Price: d("2600"), Quantity: d("0.75"), ReduceOnly: false, PositionSide: enums.PositionSideBoth},
		},
	}
	sig, err = perps.SignNewOrderRequest(multiReq, n)
	add("perps_multi_order", "perps", ptypes.NewOrderRequestTypeName, n, multiReq, sig, err)

	// --- perps: cancel ------------------------------------------------------
	n++
	cancelReq := &ptypes.CancelOrderRequest{
		AccountID: 43933,
		Cancels: []*ptypes.CancelOrder{
			{SymbolID: 1, OrderID: u64(987654321)},
			{SymbolID: 2, ClOrdID: str("opentrade-limit-1")},
		},
	}
	sig, err = perps.SignCancelOrderRequest(cancelReq, n)
	add("perps_cancel", "perps", ptypes.CancelOrderRequestTypeName, n, cancelReq, sig, err)

	// --- perps: modify ------------------------------------------------------
	n++
	modReq := &ptypes.ModifyOrderRequest{
		AccountID: 43933, SymbolID: 1, OrderID: u64(987654321),
		Price: d("71000"), Quantity: d("0.02"),
	}
	sig, err = perps.SignModifyOrderRequest(modReq, n)
	add("perps_modify", "perps", ptypes.ModifyOrderRequestTypeName, n, modReq, sig, err)

	// --- perps: leverage ----------------------------------------------------
	n++
	levReq := &ptypes.UpdateLeverageRequest{AccountID: 43933, SymbolID: 1, Leverage: 10, MarginMode: enums.MarginModeCross}
	sig, err = perps.SignUpdateLeverageRequest(levReq, n)
	add("perps_leverage", "perps", ptypes.UpdateLeverageRequestTypeName, n, levReq, sig, err)

	// --- perps: margin ------------------------------------------------------
	n++
	marReq := &ptypes.UpdateMarginRequest{AccountID: 43933, SymbolID: 1, Amount: decimal.RequireFromString("250.5")}
	sig, err = perps.SignUpdateMarginRequest(marReq, n)
	add("perps_margin", "perps", ptypes.UpdateMarginRequestTypeName, n, marReq, sig, err)

	// --- perps -> spot transfer (magic account 999) -------------------------
	n++
	trReq := &ctypes.TransferAssetRequest{
		ID: 1, FromAccountID: 43933, ToAccountID: 999, CoinID: 0,
		Amount: decimal.RequireFromString("100"), Type: enums.TransferAssetTypeSpotWithdraw,
	}
	sig, err = perps.SignTransferAssetRequest(trReq, n)
	add("perps_transfer_to_spot", "perps", ctypes.TransferAssetRequestTypeName, n, trReq, sig, err)

	// --- schedule cancel (dead-man's switch) --------------------------------
	n++
	scReq := &ctypes.ScheduleCancelRequest{AccountID: 43933, ScheduledTimestamp: u64(1776000060000)}
	sig, err = perps.SignScheduleCancelRequest(scReq, n)
	add("perps_schedule_cancel", "perps", ctypes.ScheduleCancelRequestTypeName, n, scReq, sig, err)

	// --- schedule cancel, cleared (omitempty nil pointer) -------------------
	n++
	scClear := &ctypes.ScheduleCancelRequest{AccountID: 43933}
	sig, err = perps.SignScheduleCancelRequest(scClear, n)
	add("perps_schedule_cancel_clear", "perps", ctypes.ScheduleCancelRequestTypeName, n, scClear, sig, err)

	// --- spot: batch new order ----------------------------------------------
	n++
	spotNew := &stypes.BatchNewOrderRequest{
		AccountID: 43933,
		Orders: []*stypes.BatchNewOrderItem{{
			SymbolID: 1, ClOrdID: "opentrade-spot-1", Side: enums.OrderSideBuy,
			Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTC,
			Price: d("95000"), Quantity: d("0.406"),
		}},
	}
	sig, err = spot.SignBatchNewOrderRequest(spotNew, n)
	add("spot_batch_new_order", "spot", stypes.BatchNewOrderRequestTypeName, n, spotNew, sig, err)

	// --- spot: market buy by funds (exercises `funds`) ----------------------
	n++
	spotFunds := &stypes.BatchNewOrderRequest{
		AccountID: 43933,
		Orders: []*stypes.BatchNewOrderItem{{
			SymbolID: 1, ClOrdID: "opentrade-spot-funds", Side: enums.OrderSideBuy,
			Type: enums.OrderTypeMarket, TimeInForce: enums.TimeInForceIOC, Funds: d("500"),
		}},
	}
	sig, err = spot.SignBatchNewOrderRequest(spotFunds, n)
	add("spot_market_by_funds", "spot", stypes.BatchNewOrderRequestTypeName, n, spotFunds, sig, err)

	// --- spot: batch cancel --------------------------------------------------
	n++
	spotCancel := &stypes.BatchCancelOrderRequest{
		AccountID: 43933,
		Cancels: []*stypes.BatchCancelOrderItem{
			{SymbolID: 1, ClOrdID: "ot-cancel-1", OrderID: u64(555)},
			{SymbolID: 2, ClOrdID: "ot-cancel-2", OrigClOrdID: str("opentrade-spot-1")},
		},
	}
	sig, err = spot.SignBatchCancelOrderRequest(spotCancel, n)
	add("spot_batch_cancel", "spot", stypes.BatchCancelOrderRequestTypeName, n, spotCancel, sig, err)

	// --- spot -> perps transfer ---------------------------------------------
	n++
	spotTr := &ctypes.TransferAssetRequest{
		ID: 2, FromAccountID: 43933, ToAccountID: 999, CoinID: 0,
		Amount: decimal.RequireFromString("42.75"), Type: enums.TransferAssetTypePerpsWithdraw,
	}
	sig, err = spot.SignTransferAssetRequest(spotTr, n)
	add("spot_transfer_to_perps", "spot", ctypes.TransferAssetRequestTypeName, n, spotTr, sig, err)

	// --- replace order -------------------------------------------------------
	n++
	repReq := &ctypes.ReplaceOrderRequest{
		AccountID: 43933,
		Orders: []*ctypes.ReplaceParams{{
			SymbolID: 1, ClOrdID: "ot-replace-1", OrigOrderID: u64(987654321), Price: d("69500"),
		}},
	}
	sig, err = perps.SignReplaceOrderRequest(repReq, n)
	add("perps_replace", "perps", ctypes.ReplaceOrderRequestTypeName, n, repReq, sig, err)

	// --- revoke API key ------------------------------------------------------
	n++
	revReq := &ctypes.RevokeAPIKeyRequest{AccountID: 43933, Name: "opentrade-key"}
	sig, err = perps.SignRevokeAPIKeyRequest(revReq, n)
	add("perps_revoke_api_key", "perps", ctypes.RevokeAPIKeyRequestTypeName, n, revReq, sig, err)

	// --- user-signed permissioned API key (the MetaMask flow) ---------------
	// Signed under the "universal" domain with the WALLET's chain id, while the
	// inner chainID field carries the SoDEX chain id.
	n++
	sigChain := uint64(1)
	permReq := &ctypes.AddPermissionedAPIKeyRequest{
		AccountID: 43933, Name: "opentrade-trading", Type: enums.APIKeyTypeEVM,
		PublicKey: "0x1234567890abcdef1234567890abcdef12345678",
		ExpiresAt: 1800000000, Permissions: 3, // TRADE and CANCEL *disabled*: a set bit disables (enums/api_key_permission.go)
	}
	permSig, err := perps.SignAddPermissionedAPIKeyRequest(permReq, n, &sigChain)
	if err != nil {
		panic(err)
	}
	action := &ctypes.UserSignedAddPermissionedAPIKeyAction{
		UserSignedAction:             ctypes.UserSignedAction{ChainID: testChainID, Nonce: n},
		AddPermissionedAPIKeyRequest: *permReq,
	}
	universal := ctypes.NewEIP712Domain(ctypes.UniversalDomainName, sigChain)
	out = append(out, vector{
		Name: "user_signed_add_permissioned_api_key", Engine: "universal",
		ActionType: ctypes.AddPermissionedAPIKeyRequestTypeName, Nonce: n,
		PayloadJSON: mustJSON(permReq),
		PayloadHash: action.Hash(&universal).Hex(), // full EIP-712 digest, not a payload hash
		BodyJSON:    mustJSON(permReq),
		Signature:   "0x" + hex.EncodeToString(permSig),
		Params:      json.RawMessage(mustJSON(permReq)),
	})

	// =======================================================================
	// Valuescan additions (not in Opentrade).
	// =======================================================================

	builder := &ctypes.BuilderParams{BuilderID: 456, FeeRate: 50}

	// --- perps: batch-level builder (official Go struct) ---------------------
	n = 1760000000000
	pb := &ptypes.NewOrderRequest{
		AccountID: 43933, SymbolID: 1,
		Orders: []*ptypes.RawOrder{{
			ClOrdID: "vs-builder-1", Modifier: enums.OrderModifierNormal,
			Side: enums.OrderSideBuy, Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTC,
			Price: d("70000.5"), Quantity: d("0.01"),
			ReduceOnly: false, PositionSide: enums.PositionSideBoth,
		}},
		Builder: builder,
	}
	sig, err = perps.SignNewOrderRequest(pb, n)
	add("perps_new_order_builder_batch", "perps", ptypes.NewOrderRequestTypeName, n, pb, sig, err)

	// --- perps: market IOC with a price cap + builder (copy-trade shape) ----
	n++
	pc := &ptypes.NewOrderRequest{
		AccountID: 43933, SymbolID: 2,
		Orders: []*ptypes.RawOrder{{
			ClOrdID: "vs-copy-1", Modifier: enums.OrderModifierNormal,
			Side: enums.OrderSideSell, Type: enums.OrderTypeMarket, TimeInForce: enums.TimeInForceIOC,
			Price: d("2450.1"), Quantity: d("0.25"),
			ReduceOnly: false, PositionSide: enums.PositionSideBoth,
		}},
		Builder: &ctypes.BuilderParams{BuilderID: 456, FeeRate: 200},
	}
	sig, err = perps.SignNewOrderRequest(pc, n)
	add("perps_market_ioc_builder_cap", "perps", ptypes.NewOrderRequestTypeName, n, pc, sig, err)

	// --- perps: per-order override + batch default (Python SDK layout) ------
	n++
	evmPerps := csigner.NewEVMSigner(func() *ctypes.EIP712Domain {
		dm := ctypes.NewEIP712Domain(ctypes.PerpsDomainName, testChainID)
		return &dm
	}())
	po := &newOrderPerOrderBuilder{
		AccountID: 43933, SymbolID: 1,
		Orders: []*rawOrderWithBuilder{
			{ClOrdID: "vs-po-a", Modifier: enums.OrderModifierNormal, Side: enums.OrderSideBuy,
				Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTC,
				Price: d("69000"), Quantity: d("0.02"), ReduceOnly: false, PositionSide: enums.PositionSideBoth,
				Builder: &ctypes.BuilderParams{BuilderID: 789, FeeRate: 20}},
			{ClOrdID: "vs-po-b", Modifier: enums.OrderModifierNormal, Side: enums.OrderSideBuy,
				Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTC,
				Price: d("68000"), Quantity: d("0.02"), ReduceOnly: false, PositionSide: enums.PositionSideBoth},
		},
		Builder: builder,
	}
	sig, err = evmPerps.SignAction(po, n, pk)
	add("perps_new_order_builder_per_order", "perps", ptypes.NewOrderRequestTypeName, n, po, sig, err)

	// --- spot: batch-level builder, after `orders` (official Go struct) -----
	n++
	sb := &stypes.BatchNewOrderRequest{
		AccountID: 43933,
		Orders: []*stypes.BatchNewOrderItem{{
			SymbolID: 1, ClOrdID: "vs-spot-builder", Side: enums.OrderSideSell,
			Type: enums.OrderTypeLimit, TimeInForce: enums.TimeInForceGTC,
			Price: d("95000"), Quantity: d("0.406"),
		}},
		Builder: &ctypes.BuilderParams{BuilderID: 456, FeeRate: 1000},
	}
	sig, err = spot.SignBatchNewOrderRequest(sb, n)
	add("spot_batch_new_order_builder", "spot", stypes.BatchNewOrderRequestTypeName, n, sb, sig, err)

	// --- TWAP (official Go structs) -----------------------------------------
	n++
	twap := &ctypes.NewTwapOrderRequest{
		AccountID: 43933, SymbolID: 1, Side: enums.OrderSideBuy,
		Quantity: decimal.RequireFromString("1.5"), Minutes: 30, Randomize: true, ReduceOnly: boolp(false),
	}
	sig, err = perps.SignNewTwapOrderRequest(twap, n)
	add("perps_new_twap_order", "perps", ctypes.NewTwapOrderRequestTypeName, n, twap, sig, err)

	n++
	twapCancel := &ctypes.CancelTwapOrderRequest{AccountID: 43933, SymbolID: 1, OrderID: 424242}
	sig, err = perps.SignCancelTwapOrderRequest(twapCancel, n)
	add("perps_cancel_twap_order", "perps", ctypes.CancelTwapOrderRequestTypeName, n, twapCancel, sig, err)

	// --- spot revoke (engine-domain, documented DELETE route) ---------------
	n++
	spotRev := &ctypes.RevokeAPIKeyRequest{AccountID: 43933, Name: "vs-key-1"}
	sig, err = spot.SignRevokeAPIKeyRequest(spotRev, n)
	add("spot_revoke_api_key", "spot", ctypes.RevokeAPIKeyRequestTypeName, n, spotRev, sig, err)

	// --- spot -> own ValueChain wallet (the official SDK's transfer_spot_to_evm:
	// spot engine, EVM_WITHDRAW, toAccountID 999) --------------------------------
	wn := uint64(1760300000000) // own nonce range: the vectors after keep theirs
	evmWd := &ctypes.TransferAssetRequest{
		ID: 1760300000123, FromAccountID: 43933, ToAccountID: 999, CoinID: 0,
		Amount: decimal.RequireFromString("12.5"), Type: enums.TransferAssetTypeEVMWithdraw,
	}
	sig, err = spot.SignTransferAssetRequest(evmWd, wn)
	add("spot_evm_withdraw", "spot", ctypes.TransferAssetRequestTypeName, wn, evmWd, sig, err)

	// -----------------------------------------------------------------------
	// Master-wallet (universal-domain) actions.
	// -----------------------------------------------------------------------
	var users []userVector
	keyAddr := common.HexToAddress("0x3d4595c8742d0a58173a9963c05755b59a8f8256")

	// AddAPIKey - the documented ORDINARY registration. No message chainID; the
	// domain chainId is the network id (SignAddAPIKeyRequest with a nil
	// signatureChainID uses the universal domain on the signer's chain).
	n = 1760100000000
	addReq := &ctypes.AddAPIKeyRequest{
		AccountID: 43933, Name: "vs-trading-1", Type: enums.APIKeyTypeEVM,
		PublicKey: keyAddr.Bytes(), ExpiresAt: 1760186400000,
	}
	addSig, err := perps.SignAddAPIKeyRequest(addReq, n, nil)
	if err != nil {
		panic(err)
	}
	addAction := &ctypes.AddAPIKey{AddAPIKeyRequest: *addReq, Nonce: n}
	uDomNet := ctypes.NewEIP712Domain(ctypes.UniversalDomainName, testChainID)
	users = append(users, userVector{
		Name: "user_add_api_key", PrimaryType: "AddAPIKey", DomainChainID: testChainID, Nonce: n,
		Message: json.RawMessage(mustJSON(map[string]any{
			"accountID": addReq.AccountID, "name": addReq.Name, "keyType": int(addReq.Type),
			"publicKey": strings.ToLower(keyAddr.Hex()), "expiresAt": addReq.ExpiresAt, "nonce": n,
		})),
		StructHash: addAction.StructHash().Hex(), Digest: addAction.Hash(&uDomNet).Hex(),
		Signature: "0x" + hex.EncodeToString(addSig), Source: "go-sdk:SignAddAPIKeyRequest(nil)",
	})

	// UserSignedAddAPIKeyAction - the ordinary registration sodex.com's web app
	// signs (and what the engines verify for a 0x02 signature): domain chainId =
	// the WALLET's chain, message chainID = SoDEX network id, nonce second.
	// SignAddAPIKeyRequest with a non-nil signatureChainID produces exactly this.
	for i, sc := range []uint64{1, 42161, testChainID} {
		un := uint64(1760200000000) + uint64(i) // own range: the vectors below keep their nonces
		scCopy := sc
		usSig, err := perps.SignAddAPIKeyRequest(addReq, un, &scCopy)
		if err != nil {
			panic(err)
		}
		usAction := &ctypes.UserSignedAddAPIKeyAction{
			UserSignedAction: ctypes.UserSignedAction{ChainID: testChainID, Nonce: un},
			AddAPIKeyRequest: *addReq,
		}
		dom := ctypes.NewEIP712Domain(ctypes.UniversalDomainName, sc)
		users = append(users, userVector{
			Name: fmt.Sprintf("user_signed_add_api_key_wallet_chain_%d", sc), PrimaryType: "UserSignedAddAPIKeyAction",
			DomainChainID: sc, MessageChainID: testChainID, Nonce: un,
			Message: json.RawMessage(mustJSON(map[string]any{
				"chainID": testChainID, "nonce": un, "accountID": addReq.AccountID, "name": addReq.Name,
				"keyType": int(addReq.Type), "publicKey": strings.ToLower(keyAddr.Hex()), "expiresAt": addReq.ExpiresAt,
			})),
			StructHash: usAction.StructHash().Hex(), Digest: usAction.Hash(&dom).Hex(),
			Signature: "0x" + hex.EncodeToString(usSig), Source: "go-sdk:SignAddAPIKeyRequest(&walletChain)",
		})
	}

	// AddAPIKeyWithBuilder - one wallet signature registers the key AND approves
	// the builder fee. Domain chainId = the wallet's chain (1 here), message
	// chainID = SoDEX network id.
	n++
	wb := &ctypes.AddAPIKeyWithBuilderRequest{
		AccountID: 43933, Name: "vs-trading-2", Type: enums.APIKeyTypeEVM,
		PublicKey: strings.ToLower(keyAddr.Hex()), ExpiresAt: 1760186400000,
		Builder: ctypes.BuilderParams{BuilderID: 456, FeeRate: 50},
	}
	for _, sc := range []uint64{1, testChainID} {
		scCopy := sc
		wbSig, err := perps.SignAddAPIKeyWithBuilderRequest(wb, n, &scCopy)
		if err != nil {
			panic(err)
		}
		wbAction := &ctypes.AddAPIKeyWithBuilderAction{ChainID: testChainID, Nonce: n, AddAPIKeyWithBuilderRequest: *wb}
		dom := ctypes.NewEIP712Domain(ctypes.UniversalDomainName, sc)
		name := "user_add_api_key_with_builder_wallet_chain_1"
		if sc == testChainID {
			name = "user_add_api_key_with_builder_network_chain"
		}
		users = append(users, userVector{
			Name: name, PrimaryType: "AddAPIKeyWithBuilder", DomainChainID: sc, MessageChainID: testChainID, Nonce: n,
			Message: json.RawMessage(mustJSON(map[string]any{
				"chainID": testChainID, "nonce": n, "accountID": wb.AccountID, "name": wb.Name,
				"keyType": int(wb.Type), "publicKey": wb.PublicKey, "expiresAt": wb.ExpiresAt,
				"builderID": wb.Builder.BuilderID, "maxFeeRate": wb.Builder.FeeRate,
			})),
			StructHash: wbAction.StructHash().Hex(), Digest: wbAction.Hash(&dom).Hex(),
			Signature: "0x" + hex.EncodeToString(wbSig), Source: "go-sdk:SignAddAPIKeyWithBuilderRequest",
		})
	}

	// ApproveBuilderFeeAction - standalone approval (and maxFeeRate 0 = clear).
	for i, fee := range []uint64{50, 0} {
		n++
		ab := &ctypes.ApproveBuilderFeeRequest{AccountID: 43933, BuilderID: 456, MaxFeeRate: fee}
		wc := uint64(1)
		abSig, err := perps.SignApproveBuilderFeeRequest(ab, n, &wc)
		if err != nil {
			panic(err)
		}
		abAction := &ctypes.ApproveBuilderFeeAction{ChainID: testChainID, Nonce: n, AccountID: ab.AccountID, BuilderID: ab.BuilderID, MaxFeeRate: ab.MaxFeeRate}
		dom := ctypes.NewEIP712Domain(ctypes.UniversalDomainName, wc)
		name := "user_approve_builder_fee"
		if i == 1 {
			name = "user_approve_builder_fee_clear"
		}
		users = append(users, userVector{
			Name: name, PrimaryType: "ApproveBuilderFeeAction", DomainChainID: wc, MessageChainID: testChainID, Nonce: n,
			Message: json.RawMessage(mustJSON(map[string]any{
				"chainID": testChainID, "nonce": n, "accountID": ab.AccountID, "builderID": ab.BuilderID, "maxFeeRate": ab.MaxFeeRate,
			})),
			StructHash: abAction.StructHash().Hex(), Digest: abAction.Hash(&dom).Hex(),
			Signature: "0x" + hex.EncodeToString(abSig), Source: "go-sdk:SignApproveBuilderFeeRequest",
		})
	}

	// Revoke via the Python SDK route: an ExchangeAction under the UNIVERSAL
	// domain (0x02). The public API page says this is NOT accepted for
	// revocation; the Python SDK (2026-09-08) sends it anyway. Composed here
	// from SDK primitives (ActionPayload.Hash + ExchangeAction.Hash), so the
	// bytes are Go's even though no SDK method produces this exact action.
	n++
	uRev := &ctypes.RevokeAPIKeyRequest{AccountID: 43933, Name: "vs-key-1"}
	uRevPayload := &ctypes.ActionPayload{Type: uRev.ActionName(), Params: uRev}
	uRevHash, err := uRevPayload.Hash()
	if err != nil {
		panic(err)
	}
	uRevEA := &ctypes.ExchangeAction{PayloadHash: uRevHash, Nonce: n}
	uRevDigest := uRevEA.Hash(&uDomNet)
	uRevRaw, err := crypto.Sign(uRevDigest.Bytes(), pk)
	if err != nil {
		panic(err)
	}
	users = append(users, userVector{
		Name: "user_revoke_api_key_universal", PrimaryType: "ExchangeAction", DomainChainID: testChainID, Nonce: n,
		Message:    json.RawMessage(mustJSON(map[string]any{"payloadHash": uRevHash.Hex(), "nonce": n, "payloadJSON": mustJSON(uRevPayload)})),
		StructHash: uRevEA.StructHash().Hex(), Digest: uRevDigest.Hex(),
		Signature: "0x02" + hex.EncodeToString(uRevRaw), Source: "go-sdk primitives (python-sdk route)",
	})

	// --- Go encoding/json string escaping (goJSONStringify parity) ----------
	escCases := []string{
		"plain", "<script>&amp;", "quote\"back\\slash", "line\nfeed\rtab\t",
		"bell\bform\f", "ctl\x01\x1f", "sep par ", "unicode-äöü-€-😀",
	}
	escOut := map[string]string{}
	for _, c := range escCases {
		escOut[c] = mustJSON(c)
	}

	// --- decimal canonicalisation vectors -----------------------------------
	decCases := []string{
		"0.4060", "0.406", "95000", "95000.00", "0.0000001", "1e-7", "1E+3",
		"000123.4500", "-0.500", "-0", "0", "0.000", "1000000", "12345678901234567890.123",
		"0.1", ".5", "1.", "3.14159265358979323846",
	}
	decOut := map[string]string{}
	for _, c := range decCases {
		decOut[c] = decimal.RequireFromString(c).String()
	}
	decExtra := []string{
		"+32.1", "1.234e+2", "001.230", "0.00000000000000000001", "-1.5e-3",
		"123456789012345678901234567890", "5e-9", "1e21", "-000.000100",
	}
	decExtraOut := map[string]string{}
	for _, c := range decExtra {
		decExtraOut[c] = decimal.RequireFromString(c).String()
	}

	addr := crypto.PubkeyToAddress(pk.PublicKey).Hex()
	result := map[string]any{
		"privateKey":         "0x" + testKeyHex,
		"address":            addr,
		"chainID":            testChainID,
		"vectors":            out,
		"userVectors":        users,
		"decimals":           decOut,
		"decimalsExtra":      decExtraOut,
		"goJSONStrings":      escOut,
		"domainSpot":         sep(ctypes.SpotDomainName, testChainID),
		"domainPerps":        sep(ctypes.PerpsDomainName, testChainID),
		"domainUniv":         sep(ctypes.UniversalDomainName, 1),
		"domainUnivNet":      sep(ctypes.UniversalDomainName, testChainID),
		"domainPerpsMainnet": sep(ctypes.PerpsDomainName, 286623),
		"domainSpotMainnet":  sep(ctypes.SpotDomainName, 286623),
		"bigIntCheck":        new(big.Int).SetUint64(testChainID).String(),
		"sigTypeExch":        int(enums.SignatureTypeEIP712),
		"sigTypeUniv":        int(enums.SignatureTypeEIP712Universal),
		"permissionMasks": map[string]uint64{
			"TRADE": enums.APIKeyPermissionTrade.Mask(), "CANCEL": enums.APIKeyPermissionCancel.Mask(),
			"WITHDRAW": enums.APIKeyPermissionWithdraw.Mask(), "TRANSFER": enums.APIKeyPermissionTransfer.Mask(),
		},
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(result); err != nil {
		panic(err)
	}
}
