# opBNB testnet (5611) contract deployment

opBNB testnet is the public rehearsal chain. Its roots prove nothing anyone relies on, so the
anchor worker submits with its own EOA there instead of through a Safe. **That allowance is for
5611 only.** Mainnet stays Safe-only; see [Mainnet (56) contract deployment
procedure](mainnet-contract.md).

## Which chains accept an EOA submitter

The deployment script refuses an `ANCHOR_SUBMITTER` without contract code on every chain except
these two. The worker's `ANCHOR_EOA_CHAIN_IDS` accepts the same set.

| Chain | `ANCHOR_SUBMITTER` |
|---|---|
| 31337 local (anvil) | EOA or contract |
| 5611 opBNB testnet | EOA or contract |
| 56 BSC mainnet, 97 BSC testnet, 204 opBNB mainnet, any other | Contract (the Safe) only |

The list is closed. A new chain, test or not, needs the Safe until the script and worker both add it.

## Procedure

### 1. Fund the keys

Both the deployer and the submitter EOA pay gas in tBNB on opBNB testnet. Use the BNB Chain
testnet faucet. If it dispenses only on BSC testnet (97), bridge the tBNB to opBNB testnet.
Fund only what the rehearsal needs: these are still keys, and a leaked submitter key can anchor
garbage roots on this contract until the pauser pauses it and the admin revokes the role.

### 2. Name the role holders

```bash
export OPBNB_TESTNET_RPC_URL=https://opbnb-testnet-rpc.bnbchain.org   # or your provider
export ANCHOR_DEPLOYER_KEY=0x...   # funded deployer EOA
export ANCHOR_ADMIN=0x...
export ANCHOR_SUBMITTER=0x...      # the anchor worker's address
export ANCHOR_PAUSER=0x...
export ANCHOR_ADMIN_DELAY_SECONDS=3600   # required, no default; 300–2592000 on 5611
```

`ANCHOR_ADMIN_DELAY_SECONDS` is how long an admin handover or renounce must wait. The admin role
moves in two steps (`beginDefaultAdminTransfer`, then `acceptDefaultAdminTransfer` by the new
admin after the delay), so a wrong address or a stolen admin key cannot take it at once. On 5611
the script accepts 300 seconds (enough to cancel a mistaken handover) up to 30 days; 3600 is
recommended. The upper bound catches a milliseconds typo, which would freeze handovers for
years. Only the admin can change the delay later, through the same delayed flow.

On testnet the submitter may be the worker's EOA: the address of `ANCHOR_SIGNER_PRIVATE_KEY`.
Generate a fresh key for it — never an anvil/hardhat default or a key committed in this
repository; the worker refuses those on any chain but 31337. Derive its address without putting
the key on the command line, where it lands in shell history and the process list:

```bash
cast wallet address --interactive   # prompts for the key
```

Once the worker runs (step 4), the `signer` field of its `anchor.worker.started` log line shows
the same address; check it matches `ANCHOR_SUBMITTER`.

All three role holders and the deployer must be fresh keys. Off 31337 the script refuses any of
them that is an anvil/hardhat account (0–19) or a committed fixture, and the error names the
variable (`ANCHOR_ADMIN is a public development key …`). A public admin is the worst case:
whoever uses its key first can grant themselves the submitter role. The list matches the
worker's (`packages/config/src/dev-keys.ts`).

All three role variables are still required. Keep `ANCHOR_ADMIN` on a key other than the
worker's signer: the signer is a hot key in the worker's environment, and as admin it could
grant itself every role. Naming one key for all three is accepted on testnet but discouraged;
the script then prints `WARNING: single-key deployment. Local chain or opBNB testnet only.`
That warning is a stop signal anywhere else.

### 3. Deploy

```bash
cd contracts
forge build --sizes
forge test

forge script script/DeployRegistryAnchor.s.sol:DeployRegistryAnchor \
  --rpc-url opbnb_testnet --broadcast
```

`opbnb_testnet` resolves to `OPBNB_TESTNET_RPC_URL` through `foundry.toml`. Explorer
verification is not configured in this repository for any chain, so do not pass `--verify`.

The run record lands in `contracts/broadcast/DeployRegistryAnchor.s.sol/5611/`. That directory
is git-ignored, so copy the contract address and transaction hash into the deployment record.

### 4. Configure the worker

```bash
CHAIN_ID=5611
CHAIN_RPC_URL=$OPBNB_TESTNET_RPC_URL
ANCHOR_CONTRACT_ADDRESS=0x...   # the RegistryAnchorV1 address from the deployment log
ANCHOR_EOA_CHAIN_IDS=5611
ANCHOR_CONFIRMATIONS=12         # production value (threat model T8); .env.example's 2 is anvil-only
```

Put the address in the deployment environment, not in code. The rest of the worker
configuration, including the required `ANCHOR_DAILY_SPEND_CAP_WEI`, is in
[deployment.md](deployment.md).

**Switching to a new contract version.** New sends and Safe proposals go to the configured
`ANCHOR_CONTRACT_ADDRESS`; a transaction already recorded is judged against the contract stored
with its hash. After the switch the worker keeps tracking a send to the old contract still in
flight, a confirmed row inside the reorg watch, and a Safe proposal built for the old contract and
executed later, against that old contract's `RootSubmitted` log; when it follows another
transaction that stored a batch, it looks on that same contract. Draining is therefore not needed
for those rows to settle correctly, but the following still matter:

- **The old contract stays readable** through `CHAIN_RPC_URL`: keep an endpoint on the same chain.
  Tracking, following and public proofs of earlier anchors read it.
- **Rows recorded before the worker stored the contract** (`contract_address` NULL with a
  `tx_hash`) have only the configuration to go by. Before switching, check that none is still
  tracked — with the default reorg watch (`ANCHOR_REORG_WATCH_MS`, 30 minutes), this returns 0:

  ```sql
  SELECT count(*) FROM chain.transactions
  WHERE tx_hash IS NOT NULL AND contract_address IS NULL
    AND (state IN ('submitted', 'included')
         OR (state = 'confirmed' AND confirmed_at > now() - interval '30 minutes'));
  ```

  Otherwise wait for them to settle and leave the watch; switched earlier, they end
  `reconciliation_required`.
- **Signer roles.** The worker's signer (EOA) or the Safe must hold `ANCHOR_SUBMITTER_ROLE` on
  the new contract before the switch (step 5). Open Safe proposals for the old contract stay
  useful only while the Safe keeps that role there: executed after it is revoked, the inner call
  fails, no root is stored and the row ends `reconciliation_required` (resubmit it through the
  API, which sends to the new contract). Reject such proposals in the Safe instead of executing
  them.
- **A batch already on the old contract is not checked on the new one.** A row a person resubmits
  after the switch is sent to the new contract, even if an earlier attempt stored it on the old
  one. Resolve `reconciliation_required`, `dropped` and `reverted` rows before switching, or
  check the old contract (`getBatch`) before resubmitting one.

The conservative order is still the safe default: let `submitted`, `included` and `proposed`
rows settle (`SELECT state, count(*) FROM chain.transactions WHERE state IN
('submitted','included','proposed') GROUP BY state` returns nothing) before switching. Anchors
already recorded keep the contract stored with their hash.

### 5. Verify

```bash
cast call "$ANCHOR_CONTRACT_ADDRESS" "hasRole(bytes32,address)(bool)" \
  "$(cast keccak 'ANCHOR_SUBMITTER_ROLE')" "$ANCHOR_SUBMITTER" --rpc-url "$OPBNB_TESTNET_RPC_URL"
```

It must return `true` for the worker's address before the worker starts submitting.

## Deployment record

The current opBNB testnet deployment. It is not upgradeable: a new version is a new address,
and this one stays readable. Public proofs and hash search name the contract each anchor was
sent to (`contractAddress`, stored with the transaction hash), so anchors made here keep pointing
at this address after a new version is deployed.

| Field | Value |
|---|---|
| Chain | opBNB testnet (5611) |
| Contract | RegistryAnchorV1 (runtime 5,874 bytes) |
| Address | [`0x40197aff5a3db7542ceff4198fc52dc730a6c39f`](https://testnet.opbnbscan.com/address/0x40197aff5a3db7542ceff4198fc52dc730a6c39f) |
| Deploy transaction | [`0xb988b33f528f9a151fb34bea4c343ae9118dd1598969936de7f16425dcb884a3`](https://testnet.opbnbscan.com/tx/0xb988b33f528f9a151fb34bea4c343ae9118dd1598969936de7f16425dcb884a3) |
| Block | 217760921 |
| Source commit | `a3b8538` (`contracts/src` unchanged since `060c1f3`) |
| Admin (`DEFAULT_ADMIN_ROLE`, `defaultAdmin()`) | `0xb4BED63690D1A7DB7E7a1f856eE42F82ECf22D3f` |
| Pauser (`PAUSER_ROLE`) | `0xb4BED63690D1A7DB7E7a1f856eE42F82ECf22D3f` |
| Submitter (`ANCHOR_SUBMITTER_ROLE`) | `0x97839769Ca75A189C8E55Ef77c61fA3fC6aF7ab6` |
| Admin delay (`defaultAdminDelay()`) | 3600 s |
| Deployed | 2026-10-29 |

Checked on chain after deployment: the submitter role is held only by the submitter, the admin
and pauser roles by the admin, no admin handover is pending, and the contract is not paused.

## Correcting a batch

`revokeBatch` and `supersedeBatch` are permanent, and the order matters. A batch takes one
`supersededBy` link, and only an unrevoked head of a chain can become a successor. So
**revoking a successor ends its predecessor's line for good**: after A→B, revoking B leaves A
pointing at a withdrawn root, and neither A nor B can be linked onward. To correct, submit the
replacement and supersede the bad head with it first. Revoke a head only when that line should
end with no replacement.
