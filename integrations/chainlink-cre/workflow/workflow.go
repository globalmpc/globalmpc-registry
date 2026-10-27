package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/blockchain/evm"
	crehttp "github.com/smartcontractkit/cre-sdk-go/capabilities/networking/http"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/scheduler/cron"
	"github.com/smartcontractkit/cre-sdk-go/cre"
	"google.golang.org/protobuf/types/known/durationpb"
)

type reportRequest struct {
	PublicKey  string `json:"publicKey"`
	ChainID    string `json:"chainId"`
	Receiver   string `json:"receiver"`
	TTLSeconds string `json:"ttlSeconds"`
}

func requestRegistryReport(config *Config, runtime cre.NodeRuntime, token, key string) (string, error) {
	body, err := json.Marshal(reportRequest{config.PublicKey, config.ChainID, strings.ToLower(config.Receiver), config.TTLSeconds})
	if err != nil {
		return "", errors.New("failed to prepare Registry request")
	}
	response, err := (&crehttp.Client{}).SendRequest(runtime, &crehttp.Request{
		Url: config.ReportURL, Method: "POST", Body: body,
		MultiHeaders: map[string]*crehttp.HeaderValues{
			"Authorization":   {Values: []string{"Bearer " + token}},
			"Content-Type":    {Values: []string{"application/json"}},
			"Idempotency-Key": {Values: []string{key}},
		}, Timeout: durationpb.New(20 * time.Second), CacheSettings: &crehttp.CacheSettings{Store: false},
	}).Await()
	// Do not reflect transport errors or response bodies into logs; they may contain credentials.
	if err != nil || response == nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", errors.New("Registry request failed")
	}
	report, err := validateReport(response.Body, config)
	if err != nil {
		return "", err
	}
	canonical, err := json.Marshal(report)
	if err != nil {
		return "", errors.New("failed to prepare consensus report")
	}
	return string(canonical), nil
}

func onCron(config *Config, runtime cre.Runtime, payload *cron.Payload) (string, error) {
	if err := validateConfig(config); err != nil {
		return "", err
	}
	if payload == nil || payload.ScheduledExecutionTime == nil {
		return "", errors.New("cron scheduled time required")
	}
	scheduled := payload.ScheduledExecutionTime
	if err := scheduled.CheckValid(); err != nil {
		return "", errors.New("invalid cron timestamp")
	}
	key, err := executionKey(config, scheduled.Seconds, scheduled.Nanos)
	if err != nil {
		return "", err
	}
	secret, err := runtime.GetSecret(&cre.SecretRequest{Id: "REGISTRY_BEARER_TOKEN"}).Await()
	if err != nil || secret == nil || !tokenPattern.MatchString(secret.Value) {
		return "", errors.New("Registry credential unavailable")
	}
	canonical, err := cre.RunInNodeMode(config, runtime, func(config *Config, nodeRuntime cre.NodeRuntime) (string, error) {
		return requestRegistryReport(config, nodeRuntime, secret.Value, key)
	}, cre.ConsensusIdenticalAggregation[string]()).Await()
	if err != nil {
		return "", err
	}
	report, err := validateReport([]byte(canonical), config)
	if err != nil {
		return "", err
	}
	encoded, err := encodeReport(report)
	if err != nil {
		return "", err
	}
	signed, err := runtime.GenerateReport(&cre.ReportRequest{EncodedPayload: encoded, EncoderName: "evm", SigningAlgo: "ecdsa", HashingAlgo: "keccak256"}).Await()
	if err != nil {
		return "", errors.New("CRE report generation failed")
	}
	gas, _ := strconv.ParseUint(config.GasLimit, 10, 64)
	result, err := (&evm.Client{ChainSelector: anvilSelector}).WriteReport(runtime, &evm.WriteCreReportRequest{
		Receiver: common.HexToAddress(config.Receiver).Bytes(), Report: signed, GasConfig: &evm.GasConfig{GasLimit: gas},
	}).Await()
	if err != nil || result == nil || result.TxStatus != evm.TxStatus_TX_STATUS_SUCCESS || result.ReceiverContractExecutionStatus == nil || *result.ReceiverContractExecutionStatus != evm.ReceiverContractExecutionStatus_RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS || len(result.TxHash) != 32 {
		return "", errors.New("CRE report delivery did not succeed")
	}
	runtime.Logger().Info("Registry status report delivered")
	return "0x" + hex.EncodeToString(result.TxHash), nil
}

func initWorkflow(config *Config, _ *slog.Logger, _ cre.SecretsProvider) (cre.Workflow[*Config], error) {
	if err := validateConfig(config); err != nil {
		return nil, err
	}
	return cre.Workflow[*Config]{cre.Handler(cron.Trigger(&cron.Config{Schedule: config.Schedule}), onCron)}, nil
}
