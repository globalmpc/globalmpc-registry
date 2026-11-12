# CRE Receiver

`RegistryStatusReceiver` receives CRE status reports through an ERC-1967 UUPS proxy.
The existing RegistryAnchorV1 is separate and unchanged.

## BSC Testnet (97)

Proxy: `0x40197afF5a3DB7542ceFF4198FC52DC730A6C39F`

Implementation: `0xd85249F6884cDB5884e1aF3CD52D02c3E34aC965`

Deployment addresses and transactions are recorded in
[`cre-receiver-deployment.json`](../docs/operations/cre-receiver-deployment.json).

## Deploy

From the repository root, load the ignored `.env.dev` containing
`ANCHOR_DEPLOYER_KEY` and `ANCHOR_ADMIN`, then run:

```sh
forge test --root contracts
forge script --root contracts contracts/script/DeployRegistryStatusReceiver.s.sol:DeployRegistryStatusReceiver \
  --rpc-url "$BSC_TESTNET_RPC_URL" --chain-id 97 --legacy --gas-price 1000000000 --broadcast --slow
```

The script deploys the implementation and atomically initializes the proxy.
Upgrade/configuration authority is `ANCHOR_ADMIN`; ownership transfers require
acceptance by the new owner. The implementation cannot be initialized directly.
Only97 and local31337 are accepted. On97 the official Chainlink Forwarder is
required; public development keys are refused.

Optional deployment inputs: `CRE_WORKFLOW_ID`, `CRE_WORKFLOW_OWNER`,
`CRE_MAX_REPORT_TTL` (default3600 seconds). Omit both workflow fields before CRE
registration: every report is rejected until the owner binds the real identity.

## Bind the registered workflow

Use the proxy address as CRE's receiver. Get the actual workflow ID and owner
from the registered CRE workflow, then call as the Receiver owner:

```sh
cast send --account registry-dev-admin --rpc-url "$BSC_TESTNET_RPC_URL" \
  "$CRE_RECEIVER_ADDRESS" 'configureWorkflow(bytes32,address)' \
  "$CRE_WORKFLOW_ID" "$CRE_WORKFLOW_OWNER"
```

`registry-dev-admin` is an encrypted Foundry keystore imported interactively.
Both workflow values must be nonzero. A later binding change rejects the previous
identity without deleting observations or resetting replay protection.

## Upgrade

Deploy the reviewed new implementation, verify storage-layout compatibility and
run the upgrade-preservation tests, then call as the current owner:

```sh
cast send --account registry-dev-admin --rpc-url "$BSC_TESTNET_RPC_URL" \
  "$CRE_RECEIVER_ADDRESS" 'upgradeToAndCall(address,bytes)' "$NEW_IMPLEMENTATION" 0x
```

Upgrade authority can change Receiver logic. The proxy address, observation state,
configuration and sequence protections must survive each approved upgrade.
