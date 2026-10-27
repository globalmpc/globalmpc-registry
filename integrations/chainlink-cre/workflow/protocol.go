package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Anvil's selector in the official Chainlink chain-selectors registry.
const anvilSelector uint64 = 7759470850252068959
const maxReportBytes = 16384

var decimalPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
var addressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
var hashPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
var reportPathPattern = regexp.MustCompile(`^/api/v1/projects/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/cre-reports$`)
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

type Config struct {
	Schedule       string `json:"schedule"`
	ReportURL      string `json:"reportUrl"`
	PublicKey      string `json:"publicKey"`
	ChainName      string `json:"chainName"`
	ChainID        string `json:"chainId"`
	Receiver       string `json:"receiver"`
	TTLSeconds     string `json:"ttlSeconds"`
	GasLimit       string `json:"gasLimit"`
	AllowLocalHTTP bool   `json:"allowLocalHttp"`
}

type RegistryReport struct {
	ChainID         string `json:"chainId"`
	Receiver        string `json:"receiver"`
	RecordID        string `json:"recordId"`
	RegistryVersion string `json:"registryVersion"`
	ContentHash     string `json:"contentHash"`
	ObservedAt      string `json:"observedAt"`
	ValidUntil      string `json:"validUntil"`
	Sequence        string `json:"sequence"`
	Status          uint8  `json:"status"`
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("invalid JSON fields")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("invalid JSON document")
	}
	return nil
}

func unsigned(value string, bits int) (*big.Int, error) {
	if len(value) > 78 || !decimalPattern.MatchString(value) {
		return nil, errors.New("invalid unsigned integer")
	}
	integer, ok := new(big.Int).SetString(value, 10)
	if !ok || integer.Sign() <= 0 || integer.BitLen() > bits {
		return nil, errors.New("integer outside report bounds")
	}
	return integer, nil
}

func parseConfig(data []byte) (*Config, error) {
	if len(data) > maxReportBytes {
		return nil, errors.New("configuration too large")
	}
	config := new(Config)
	if err := decodeStrict(data, config); err != nil {
		return nil, err
	}
	if err := validateConfig(config); err != nil {
		return nil, err
	}
	config.Receiver = strings.ToLower(config.Receiver)
	return config, nil
}

func validateConfig(config *Config) error {
	if config == nil || len(config.Schedule) == 0 || len(config.Schedule) > 100 || len(config.PublicKey) == 0 || len(config.PublicKey) > 200 {
		return errors.New("invalid workflow configuration")
	}
	// This proof of concept cannot submit to a public chain.
	if config.ChainName != "anvil-devnet" || config.ChainID != "31337" {
		return errors.New("only Anvil chain 31337 is supported in this proof of concept")
	}
	if !addressPattern.MatchString(config.Receiver) || common.HexToAddress(config.Receiver) == (common.Address{}) {
		return errors.New("invalid receiver")
	}
	ttl, err := unsigned(config.TTLSeconds, 64)
	if err != nil || ttl.Uint64() > 3600 {
		return errors.New("invalid report TTL")
	}
	if _, err := unsigned(config.GasLimit, 64); err != nil {
		return errors.New("invalid gas limit")
	}
	if len(config.ReportURL) > 2048 {
		return errors.New("invalid Registry endpoint")
	}
	endpoint, err := url.Parse(config.ReportURL)
	if err != nil || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.ForceQuery || strings.Contains(config.ReportURL, "#") || endpoint.Fragment != "" || endpoint.RawPath != "" || !reportPathPattern.MatchString(endpoint.Path) {
		return errors.New("invalid Registry endpoint")
	}
	if endpoint.Host == "" || endpoint.Opaque != "" {
		return errors.New("invalid Registry endpoint")
	}
	if endpoint.Port() != "" {
		port, err := strconv.Atoi(endpoint.Port())
		if err != nil || port < 1 || port > 65535 {
			return errors.New("invalid endpoint port")
		}
	}
	if endpoint.Scheme != "https" {
		host := endpoint.Hostname()
		if !(config.AllowLocalHTTP && endpoint.Scheme == "http" && (host == "127.0.0.1" || host == "localhost" || host == "::1")) {
			return errors.New("HTTPS required outside explicit loopback demo")
		}
	}
	return nil
}

func validateReport(data []byte, config *Config) (*RegistryReport, error) {
	if len(data) > maxReportBytes {
		return nil, errors.New("Registry response exceeds report limit")
	}
	report := new(RegistryReport)
	if err := decodeStrict(data, report); err != nil {
		return nil, errors.New("Registry returned an invalid status report")
	}
	if report.ChainID != config.ChainID || !addressPattern.MatchString(report.Receiver) || !strings.EqualFold(report.Receiver, config.Receiver) || !hashPattern.MatchString(report.RecordID) || !strings.EqualFold(report.RecordID, crypto.Keccak256Hash([]byte("mpc-registry:project:"+config.PublicKey)).Hex()) {
		return nil, errors.New("Registry report identity/domain mismatch")
	}
	if !hashPattern.MatchString(report.ContentHash) || common.HexToHash(report.ContentHash) == (common.Hash{}) || report.Status < 1 || report.Status > 5 {
		return nil, errors.New("invalid report content or status")
	}
	for _, value := range []string{report.RegistryVersion, report.Sequence, report.ObservedAt, report.ValidUntil} {
		if _, err := unsigned(value, 64); err != nil {
			return nil, err
		}
	}
	observed, _ := strconv.ParseUint(report.ObservedAt, 10, 64)
	until, _ := strconv.ParseUint(report.ValidUntil, 10, 64)
	ttl, _ := strconv.ParseUint(config.TTLSeconds, 10, 64)
	if until <= observed || until-observed > ttl {
		return nil, errors.New("invalid report lifetime")
	}
	report.Receiver = strings.ToLower(report.Receiver)
	report.RecordID = strings.ToLower(report.RecordID)
	report.ContentHash = strings.ToLower(report.ContentHash)
	return report, nil
}

func executionKey(config *Config, seconds int64, nanos int32) (string, error) {
	if seconds <= 0 || nanos < 0 || nanos >= 1000000000 {
		return "", errors.New("invalid scheduled time")
	}
	identity, err := json.Marshal([]any{config.ReportURL, config.PublicKey, config.ChainID, strings.ToLower(config.Receiver), config.TTLSeconds, strconv.FormatInt(seconds, 10), nanos})
	if err != nil {
		return "", err
	}
	return "cre-" + fmt.Sprintf("%x", crypto.Keccak256(identity)) + "-report", nil
}

func reportArguments() (abi.Arguments, error) {
	names := []string{"uint256", "address", "bytes32", "uint64", "bytes32", "uint64", "uint64", "uint64", "uint8"}
	arguments := make(abi.Arguments, len(names))
	for index, name := range names {
		kind, err := abi.NewType(name, "", nil)
		if err != nil {
			return nil, err
		}
		arguments[index] = abi.Argument{Type: kind}
	}
	return arguments, nil
}

func encodeReport(report *RegistryReport) ([]byte, error) {
	arguments, err := reportArguments()
	if err != nil {
		return nil, err
	}
	chainID, err := unsigned(report.ChainID, 256)
	if err != nil {
		return nil, err
	}
	version, _ := strconv.ParseUint(report.RegistryVersion, 10, 64)
	observed, _ := strconv.ParseUint(report.ObservedAt, 10, 64)
	until, _ := strconv.ParseUint(report.ValidUntil, 10, 64)
	sequence, _ := strconv.ParseUint(report.Sequence, 10, 64)
	return arguments.Pack(chainID, common.HexToAddress(report.Receiver), common.HexToHash(report.RecordID), version,
		common.HexToHash(report.ContentHash), observed, until, sequence, report.Status)
}
