package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/blockchain/evm"
	evmmock "github.com/smartcontractkit/cre-sdk-go/capabilities/blockchain/evm/mock"
	crehttp "github.com/smartcontractkit/cre-sdk-go/capabilities/networking/http"
	httpmock "github.com/smartcontractkit/cre-sdk-go/capabilities/networking/http/mock"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/scheduler/cron"
	"github.com/smartcontractkit/cre-sdk-go/cre"
	"github.com/smartcontractkit/cre-sdk-go/cre/testutils"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func fixture() (*Config, RegistryReport) {
	config := &Config{Schedule: "0 */5 * * * *", ReportURL: "https://registry.example/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports",
		PublicKey: "approved-v1", ChainName: "anvil-devnet", ChainID: "31337", Receiver: "0x" + strings.Repeat("ab", 20), TTLSeconds: "300", GasLimit: "500000"}
	report := RegistryReport{ChainID: "31337", Receiver: config.Receiver, RecordID: crypto.Keccak256Hash([]byte("mpc-registry:project:" + config.PublicKey)).Hex(), RegistryVersion: "1", ContentHash: "0x" + strings.Repeat("22", 32), ObservedAt: "1700000000", ValidUntil: "1700000300", Sequence: "9007199254740993", Status: 2}
	return config, report
}
func jsonBytes(t *testing.T, input any) []byte {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
func testRuntime(t *testing.T) *testutils.TestRuntime {
	t.Helper()
	return testutils.NewRuntime(t, testutils.Secrets{"main": {"REGISTRY_BEARER_TOKEN": "test-token"}})
}
func cronPayload() *cron.Payload {
	return &cron.Payload{ScheduledExecutionTime: &timestamppb.Timestamp{Seconds: 1700000000}}
}
func httpMock(t *testing.T) *httpmock.ClientCapability {
	t.Helper()
	client, err := httpmock.NewClientCapability(t)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
func evmMock(t *testing.T) *evmmock.ClientCapability {
	t.Helper()
	client, err := evmmock.NewClientCapability(anvilSelector, t)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
func successfulDelivery() *evm.WriteReportReply {
	success := evm.ReceiverContractExecutionStatus_RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS
	return &evm.WriteReportReply{TxStatus: evm.TxStatus_TX_STATUS_SUCCESS, ReceiverContractExecutionStatus: &success, TxHash: bytes.Repeat([]byte{3}, 32)}
}

func TestSDKWorkflow(t *testing.T) {
	config, report := fixture()
	runtime := testRuntime(t)
	calls, writes := 0, 0
	httpMock(t).SendRequest = func(_ context.Context, request *crehttp.Request) (*crehttp.Response, error) {
		calls++
		if request.Url != config.ReportURL || request.Method != "POST" || request.MultiHeaders["Authorization"].Values[0] != "Bearer test-token" {
			t.Fatal("incorrect request or authorization")
		}
		key, err := executionKey(config, 1700000000, 0)
		if err != nil {
			t.Fatal(err)
		}
		if request.MultiHeaders["Idempotency-Key"].Values[0] != key {
			t.Fatal("unstable execution key")
		}
		var body reportRequest
		if err := decodeStrict(request.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body != (reportRequest{config.PublicKey, config.ChainID, strings.ToLower(config.Receiver), config.TTLSeconds}) {
			t.Fatal("incorrect report request body")
		}
		return &crehttp.Response{StatusCode: 200, Body: jsonBytes(t, report)}, nil
	}
	evmMock(t).WriteReport = func(_ context.Context, request *evm.WriteReportRequest) (*evm.WriteReportReply, error) {
		writes++
		if !bytes.Equal(request.Receiver, common.HexToAddress(config.Receiver).Bytes()) {
			t.Fatal("wrong receiver")
		}
		args, err := reportArguments()
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := args.Unpack(request.Report.RawReport[cre.ReportMetadataHeaderLength:])
		if err != nil {
			t.Fatal(err)
		}
		if decoded[0].(interface{ String() string }).String() != "31337" || decoded[3].(uint64) != 1 || decoded[7].(uint64) != 9007199254740993 || decoded[8].(uint8) != 2 {
			t.Fatalf("wrong ABI values: %v", decoded)
		}
		if request.GasConfig.GasLimit != 500000 {
			t.Fatal("gas limit missing")
		}
		return successfulDelivery(), nil
	}
	hash, err := onCron(config, runtime, cronPayload())
	if err != nil {
		t.Fatal(err)
	}
	if hash != "0x"+strings.Repeat("03", 32) || calls != 1 || writes != 1 {
		t.Fatal("workflow did not complete exactly once")
	}
	if workflow, err := initWorkflow(config, nil, runtime); err != nil || len(workflow) != 1 {
		t.Fatal("cron trigger missing")
	}
}

func TestHTTPFailures(t *testing.T) {
	for _, code := range []uint32{301, 401, 403, 409, 429, 500} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			config, _ := fixture()
			runtime := testRuntime(t)
			httpMock(t).SendRequest = func(context.Context, *crehttp.Request) (*crehttp.Response, error) {
				return &crehttp.Response{StatusCode: code, Body: []byte("SECRET")}, nil
			}
			if _, err := onCron(config, runtime, cronPayload()); err == nil || err.Error() != "Registry request failed" {
				t.Fatalf("not fail-closed: %v", err)
			}
		})
	}
	t.Run("transport-error-redacted", func(t *testing.T) {
		config, _ := fixture()
		runtime := testRuntime(t)
		httpMock(t).SendRequest = func(context.Context, *crehttp.Request) (*crehttp.Response, error) {
			return nil, errors.New("SECRET upstream token")
		}
		if _, err := onCron(config, runtime, cronPayload()); err == nil || strings.Contains(err.Error(), "SECRET") {
			t.Fatal("transport error leaked")
		}
	})
}

func TestMalformedReports(t *testing.T) {
	cases := map[string]map[string]any{
		"chain": {"chainId": "1"}, "receiver": {"receiver": "0x" + strings.Repeat("33", 20)}, "record": {"recordId": "0x" + strings.Repeat("44", 32)},
		"version-zero": {"registryVersion": "0"}, "overflow": {"sequence": "18446744073709551616"}, "fraction": {"sequence": "1.5"}, "json-number": {"sequence": 1},
		"lifetime": {"validUntil": "1700000301"}, "nonpositive-lifetime": {"validUntil": "1700000000"}, "status": {"status": 6}, "negative-status": {"status": -1},
		"unknown-field": {"privateData": "SECRET"}, "zero-hash": {"contentHash": "0x" + strings.Repeat("00", 32)},
	}
	for name, mutation := range cases {
		t.Run(name, func(t *testing.T) {
			config, report := fixture()
			var body map[string]any
			if err := json.Unmarshal(jsonBytes(t, report), &body); err != nil {
				t.Fatal(err)
			}
			for key, value := range mutation {
				body[key] = value
			}
			if _, err := validateReport(jsonBytes(t, body), config); err == nil {
				t.Fatal("invalid report accepted")
			}
		})
	}
	for name, body := range map[string][]byte{"syntax": []byte("SECRET invalid JSON"), "array": []byte("[]"), "null": []byte("null"), "oversize": bytes.Repeat([]byte("x"), maxReportBytes+1)} {
		t.Run(name, func(t *testing.T) {
			config, _ := fixture()
			runtime := testRuntime(t)
			httpMock(t).SendRequest = func(context.Context, *crehttp.Request) (*crehttp.Response, error) {
				return &crehttp.Response{StatusCode: 200, Body: body}, nil
			}
			if _, err := onCron(config, runtime, cronPayload()); err == nil || strings.Contains(err.Error(), "SECRET") {
				t.Fatal("bad report accepted or leaked")
			}
		})
	}
}

func TestConfigurationBoundaries(t *testing.T) {
	cases := []map[string]any{
		{"reportUrl": "http://registry.example/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports"},
		{"reportUrl": "https://user:password@registry.example/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports"},
		{"reportUrl": "https://registry.example/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports?token=x"},
		{"reportUrl": "http://127.0.0.2/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports", "allowLocalHttp": true},
		{"chainName": "ethereum-mainnet", "chainId": "1"}, {"receiver": "0x" + strings.Repeat("00", 20)},
		{"collectUrl": "https://registry.example/collect"}, {"collectBody": map[string]any{}}, {"ttlSeconds": "3601"}, {"gasLimit": "0"},
	}
	for index, mutation := range cases {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			config, _ := fixture()
			var body map[string]any
			if err := json.Unmarshal(jsonBytes(t, config), &body); err != nil {
				t.Fatal(err)
			}
			for key, value := range mutation {
				body[key] = value
			}
			if _, err := parseConfig(jsonBytes(t, body)); err == nil {
				t.Fatal("unsafe configuration accepted")
			}
		})
	}
	t.Run("explicit-loopback", func(t *testing.T) {
		config, _ := fixture()
		config.ReportURL = strings.Replace(config.ReportURL, "https://registry.example", "http://127.0.0.1:3001", 1)
		config.AllowLocalHTTP = true
		if _, err := parseConfig(jsonBytes(t, config)); err != nil {
			t.Fatal(err)
		}
	})
}

func TestDeliveryFailures(t *testing.T) {
	for name, modify := range map[string]func(*evm.WriteReportReply){
		"fatal":    func(result *evm.WriteReportReply) { result.TxStatus = evm.TxStatus_TX_STATUS_FATAL },
		"reverted": func(result *evm.WriteReportReply) { result.TxStatus = evm.TxStatus_TX_STATUS_REVERTED },
		"consumer-reverted": func(result *evm.WriteReportReply) {
			failed := evm.ReceiverContractExecutionStatus_RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED
			result.ReceiverContractExecutionStatus = &failed
		},
		"consumer-unknown": func(result *evm.WriteReportReply) { result.ReceiverContractExecutionStatus = nil },
		"hash-missing":     func(result *evm.WriteReportReply) { result.TxHash = nil },
	} {
		t.Run(name, func(t *testing.T) {
			config, report := fixture()
			runtime := testRuntime(t)
			httpMock(t).SendRequest = func(context.Context, *crehttp.Request) (*crehttp.Response, error) {
				return &crehttp.Response{StatusCode: 200, Body: jsonBytes(t, report)}, nil
			}
			evmMock(t).WriteReport = func(context.Context, *evm.WriteReportRequest) (*evm.WriteReportReply, error) {
				result := successfulDelivery()
				modify(result)
				return result, nil
			}
			if _, err := onCron(config, runtime, cronPayload()); err == nil || err.Error() != "CRE report delivery did not succeed" {
				t.Fatalf("failed delivery reported success: %v", err)
			}
		})
	}
}

func TestExecutionIdentity(t *testing.T) {
	config, _ := fixture()
	key, _ := executionKey(config, 1700000000, 0)
	upper := *config
	upper.Receiver = "0x" + strings.ToUpper(strings.TrimPrefix(config.Receiver, "0x"))
	normalized, _ := executionKey(&upper, 1700000000, 0)
	if key != normalized {
		t.Fatal("address casing changes idempotency")
	}
	changed := *config
	changed.TTLSeconds = "301"
	different, _ := executionKey(&changed, 1700000000, 0)
	if key == different {
		t.Fatal("TTL not bound")
	}
	next, _ := executionKey(config, 1700000001, 0)
	if key == next {
		t.Fatal("execution not bound")
	}
	if _, err := onCron(config, testRuntime(t), &cron.Payload{}); err == nil {
		t.Fatal("missing cron time accepted")
	}
}

func TestMissingCredential(t *testing.T) {
	config, _ := fixture()
	calls := 0
	runtime := testutils.NewRuntime(t, nil)
	httpMock(t).SendRequest = func(context.Context, *crehttp.Request) (*crehttp.Response, error) {
		calls++
		return nil, errors.New("unexpected")
	}
	if _, err := onCron(config, runtime, cronPayload()); err == nil || calls != 0 {
		t.Fatal("HTTP called without credential")
	}
}

func TestStatusPreservation(t *testing.T) {
	for status := uint8(1); status <= 5; status++ {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			config, report := fixture()
			report.Status = status
			runtime := testRuntime(t)
			httpMock(t).SendRequest = func(context.Context, *crehttp.Request) (*crehttp.Response, error) {
				return &crehttp.Response{StatusCode: 200, Body: jsonBytes(t, report)}, nil
			}
			evmMock(t).WriteReport = func(_ context.Context, request *evm.WriteReportRequest) (*evm.WriteReportReply, error) {
				args, _ := reportArguments()
				decoded, err := args.Unpack(request.Report.RawReport[cre.ReportMetadataHeaderLength:])
				if err != nil {
					t.Fatal(err)
				}
				if decoded[8].(uint8) != status {
					t.Fatal("status rewritten")
				}
				return successfulDelivery(), nil
			}
			if _, err := onCron(config, runtime, cronPayload()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRequiredReportFields(t *testing.T) {
	for _, field := range []string{"chainId", "receiver", "recordId", "registryVersion", "contentHash", "observedAt", "validUntil", "sequence", "status"} {
		t.Run(field, func(t *testing.T) {
			config, report := fixture()
			var input map[string]any
			if err := json.Unmarshal(jsonBytes(t, report), &input); err != nil {
				t.Fatal(err)
			}
			delete(input, field)
			if _, err := validateReport(jsonBytes(t, input), config); err == nil {
				t.Fatal("missing required report field accepted")
			}
		})
	}
}

func TestInvalidScheduledTime(t *testing.T) {
	for name, payload := range map[string]*cron.Payload{"nil": nil, "missing": {}, "negative": {ScheduledExecutionTime: &timestamppb.Timestamp{Seconds: -1}}, "invalid-nanos": {ScheduledExecutionTime: &timestamppb.Timestamp{Seconds: 1700000000, Nanos: 1000000000}}, "out-of-range": {ScheduledExecutionTime: &timestamppb.Timestamp{Seconds: 253402300800}}} {
		t.Run(name, func(t *testing.T) {
			config, _ := fixture()
			calls := 0
			runtime := testRuntime(t)
			httpMock(t).SendRequest = func(context.Context, *crehttp.Request) (*crehttp.Response, error) {
				calls++
				return nil, errors.New("unexpected HTTP")
			}
			if _, err := onCron(config, runtime, payload); err == nil || calls != 0 {
				t.Fatal("invalid trigger made an HTTP request")
			}
		})
	}
}

func TestConfigurationInputLimits(t *testing.T) {
	config, _ := fixture()
	for name, modify := range map[string]func(*Config){
		"empty-public-key": func(config *Config) { config.PublicKey = "" }, "public-key-limit": func(config *Config) { config.PublicKey = strings.Repeat("x", 201) },
		"empty-schedule": func(config *Config) { config.Schedule = "" }, "schedule-limit": func(config *Config) { config.Schedule = strings.Repeat("x", 101) },
		"negative-ttl": func(config *Config) { config.TTLSeconds = "-1" }, "ttl-overflow": func(config *Config) { config.TTLSeconds = "18446744073709551616" },
		"gas-fraction": func(config *Config) { config.GasLimit = "1.1" }, "numeric-input-limit": func(config *Config) { config.GasLimit = strings.Repeat("9", 79) },
		"url-limit": func(config *Config) { config.ReportURL = strings.Repeat("x", 2049) }, "encoded-path": func(config *Config) { config.ReportURL = strings.Replace(config.ReportURL, "/api/", "/%61pi/", 1) },
		"fragment": func(config *Config) { config.ReportURL += "#" }, "port": func(config *Config) {
			config.ReportURL = strings.Replace(config.ReportURL, "registry.example", "registry.example:65536", 1)
		},
	} {
		t.Run(name, func(t *testing.T) {
			copy := *config
			modify(&copy)
			if _, err := parseConfig(jsonBytes(t, &copy)); err == nil {
				t.Fatal("out-of-bounds configuration accepted")
			}
		})
	}
	if _, err := parseConfig(bytes.Repeat([]byte("x"), maxReportBytes+1)); err == nil {
		t.Fatal("oversized config accepted")
	}
	if _, err := parseConfig(append(jsonBytes(t, config), []byte(" {}")...)); err == nil {
		t.Fatal("trailing config document accepted")
	}
	if _, err := initWorkflow(nil, nil, nil); err == nil {
		t.Fatal("nil configuration accepted")
	}
}

func TestReceiverCanonicalization(t *testing.T) {
	config, report := fixture()
	config.Receiver = "0x" + strings.ToUpper(strings.TrimPrefix(config.Receiver, "0x"))
	report.Receiver = config.Receiver
	parsed, err := parseConfig(jsonBytes(t, config))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Receiver != strings.ToLower(config.Receiver) {
		t.Fatal("configuration receiver not normalized")
	}
	runtime := testRuntime(t)
	httpMock(t).SendRequest = func(_ context.Context, request *crehttp.Request) (*crehttp.Response, error) {
		var body reportRequest
		if err := decodeStrict(request.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Receiver != strings.ToLower(config.Receiver) {
			t.Fatal("HTTP body receiver not normalized")
		}
		return &crehttp.Response{StatusCode: 200, Body: jsonBytes(t, report)}, nil
	}
	evmMock(t).WriteReport = func(context.Context, *evm.WriteReportRequest) (*evm.WriteReportReply, error) {
		return successfulDelivery(), nil
	}
	if _, err := onCron(config, runtime, cronPayload()); err != nil {
		t.Fatal(err)
	}
}
