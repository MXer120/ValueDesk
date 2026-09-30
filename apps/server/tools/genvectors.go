// Command genvectors emits reference signing vectors produced by the OFFICIAL
// SoDEX Go SDK. The TypeScript signer in src/signing is asserted against this
// output by test/vectors.test.ts.
//
// This is the whole correctness argument for the signer: rather than trusting a
// hand-port of the EIP-712 + Go-JSON rules, we make the reference implementation
// produce the bytes and require an exact match.
//
// Usage (from a checkout of sodex-go-sdk-public, with this file copied in):
//
//	go run ./tools/genvectors > vectors.json
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/shopspring/decimal"

	"github.com/sodex-tech/sodex-go-sdk-public/common/enums"
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

func d(s string) *decimal.Decimal { v := decimal.RequireFromString(s); return &v }
func u64(v uint64) *uint64        { return &v }
func str(s string) *string        { return &s }

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

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

	addr := crypto.PubkeyToAddress(pk.PublicKey).Hex()
	result := map[string]any{
		"privateKey":   "0x" + testKeyHex,
		"address":      addr,
		"chainID":      testChainID,
		"vectors":      out,
		"decimals":     decOut,
		"domainSpot":   ctypes.NewEIP712Domain(ctypes.SpotDomainName, testChainID).DomainSeparator().Hex(),
		"domainPerps":  ctypes.NewEIP712Domain(ctypes.PerpsDomainName, testChainID).DomainSeparator().Hex(),
		"domainUniv":   ctypes.NewEIP712Domain(ctypes.UniversalDomainName, uint64(1)).DomainSeparator().Hex(),
		"bigIntCheck":  new(big.Int).SetUint64(testChainID).String(),
		"sigTypeExch":  int(enums.SignatureTypeEIP712),
		"sigTypeUniv":  int(enums.SignatureTypeEIP712Universal),
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(result); err != nil {
		panic(err)
	}
}
