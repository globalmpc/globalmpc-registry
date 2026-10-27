//go:build wasip1

package main

import "github.com/smartcontractkit/cre-sdk-go/cre/wasm"

func main() { wasm.NewRunner(parseConfig).Run(initWorkflow) }
