# Mainnet (56) contract deployment procedure

The mainnet deployment **has not been made yet.** This document sets what to do, and in what
order, when it is.

> **Do not deploy from this document alone.** A staging environment is a prerequisite. The
> release policy distinguishes lowering a gate from skipping a stage; the latter invalidates the
> whole document. Production promotion is discussed only after the golden path has run end to end
> on staging against the mainnet contract.

## Why the contract is treated separately

The release policy pins **the one thing that changes** at production promotion to the contract
address. Code, image, and configuration must be identical to staging; the moment anything else
differs, what was verified on staging is no longer what is verified in production.

So the goal of this procedure is not "deploy to mainnet" but **"produce a state in which only the
address differs."**

## What must be settled before deploying

| Item | Why | Status |
|---|---|---|
| Safe multisig signer list | The Safe holds `admin` and `submitter`. If one EOA holds all three, the premise that "even MPC itself cannot change this alone" collapses | **Undecided** — OD-12 |
| Organization holding `pauser` | Security response must be in different hands from deployment and operations | **Undecided** — OD-12 |
| Anchor wallet daily cap value | `ANCHOR_DAILY_SPEND_CAP_WEI`. Without it, the worker refuses to start | Sized per [Loss cap for the anchor wallet](deployment.md#loss-cap-for-the-anchor-wallet) |
| Funding cap and procedure | Code cannot enforce it. It is a finance and operations procedure | **Undecided** |
| Golden path completed on staging | Has it actually run against the mainnet contract? | **Not done** |

**Do not deploy while the four are undecided.** In particular, deploying before the signers are
decided leaves a contract on mainnet whose admin, submitter, and pauser are all one EOA, and there
is no way back from that except changing the address.

## Procedure

### 1. Confirm what is being deployed

```bash
# Start at the repository root, on the release commit validated in staging.
foundryup --install v1.8.5
git submodule update --init --recursive
pnpm install --frozen-lockfile

# Record these with the staging and production build evidence.
forge --version
git submodule status --recursive
pnpm why @openzeppelin/contracts

cd contracts
forge build --sizes
forge test -vv        # every test must pass
```

The commit deployed must be **the commit that ran on staging.** Record `git rev-parse HEAD`.
Staging must have run the build using **Foundry 1.8.5, OpenZeppelin Contracts 5.6.1 and
forge-std v1.17.0**, with Solidity 0.8.28 and the compiler settings in `foundry.toml`.
Check the recorded tool version, lockfile and submodule revision against that staging build.

Treat the move from OpenZeppelin 5.4.0 to 5.6.1 as a new dependency build requiring staging
validation. Unchanged application Solidity sources alone do not establish that compiled
bytecode is unchanged. Validation of the earlier dependency set does not validate this one;
complete staging validation again before promoting it.

### 2. Prepare the role addresses

```bash
export ANCHOR_ADMIN=0x...      # Safe multisig
export ANCHOR_SUBMITTER=0x...  # Safe multisig
export ANCHOR_PAUSER=0x...     # security response organization
export ANCHOR_ADMIN_DELAY_SECONDS=172800   # required; script accepts 86400–2592000
```

The admin role can only be handed over in two steps, and the new admin can accept only after
`ANCHOR_ADMIN_DELAY_SECONDS`. That delay is the window in which the Safe signers see an unwanted
handover (`DefaultAdminTransferScheduled`) and cancel it. Use two days or more. The script
refuses less than one day (86400) on 56 and on every other chain that needs a Safe submitter,
and more than 30 days (2592000) everywhere but the local chain: a milliseconds typo would freeze
handovers for years, and shortening the delay later waits out the difference.

On 56 the script reverts unless `ANCHOR_SUBMITTER` has contract code. Deploy the Safe first; an
EOA or a Safe address not yet deployed is refused. Only the local chain (31337) and opBNB testnet
(5611) accept an EOA submitter ([testnet procedure](testnet-contract.md)).

If the three are the same, the script prints
`WARNING: single-key deployment. Local chain or opBNB testnet only.`
**Stop if that warning appears** — on mainnet, that layout is not the intent.

### 3. Deploy

```bash
ANCHOR_DEPLOYER_KEY=... \
  forge script script/DeployRegistryAnchor.s.sol:DeployRegistryAnchor \
  --rpc-url "$BSC_MAINNET_RPC" --broadcast --verify
```

The deployer key is **an EOA, not the Safe.** Immediately after deployment the roles are held by
the Safe named above, so this key has no privileges afterwards. Discard it anyway.

A record appears under `broadcast/DeployRegistryAnchor.s.sol/56/`. **Commit it** — if which
address came from which commit exists only outside the repository, it cannot be reproduced.

### 4. Pin the address

```bash
ANCHOR_CONTRACT_ADDRESS=0x...   # the RegistryAnchorV1 address from the deployment log
CHAIN_ID=56
```

Put both values in the deployment environment. **Not in code** — doing so makes staging and
production different code, and the one-change rule is broken.

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
- **Signer roles.** The Safe must hold `ANCHOR_SUBMITTER_ROLE` on the new contract before the
  switch (step 5); on mainnet it is the only submitter. Open Safe proposals for the old contract
  stay useful only while the Safe keeps that role there: executed after it is revoked, the inner
  call fails, no root is stored and the row ends `reconciliation_required` (resubmit it through
  the API, which sends to the new contract). Reject such proposals in the Safe instead of
  executing them.
- **A batch already on the old contract is not checked on the new one.** A row a person resubmits
  after the switch is sent to the new contract, even if an earlier attempt stored it on the old
  one. Resolve `reconciliation_required`, `dropped` and `reverted` rows before switching, or
  check the old contract (`getBatch`) before resubmitting one.

The conservative order is still the safe default: let `submitted`, `included` and `proposed`
rows settle (`SELECT state, count(*) FROM chain.transactions WHERE state IN
('submitted','included','proposed') GROUP BY state` returns nothing) before switching. Anchors
already recorded keep the contract stored with their hash.

### 5. Verify

Finished deploying and working are different things.

```bash
# Did the role go to the Safe? If the deployer EOA still holds it, go back to step 4.
cast call "$ANCHOR_CONTRACT_ADDRESS" "hasRole(bytes32,address)(bool)" \
  "$(cast keccak 'ANCHOR_SUBMITTER_ROLE')" "$ANCHOR_SUBMITTER" --rpc-url "$BSC_MAINNET_RPC"

# Does the worker start against that address? Without `ANCHOR_DAILY_SPEND_CAP_WEI` it
# refuses to start — that refusal is the intent (O1).
docker compose -f docker/docker-compose.yml logs anchor-worker | grep anchor.worker.started
```

### 6. A person watches the first submission

Until the first batch reaches `confirmed`, watch `/w/anchors` and the `mpc_anchor_transactions`
gauge together (`config/observability/alerts.yml`). On failure, do not retry automatically — it
fails again for the same reason, or becomes a duplicate submission.

## Rolling back

**A contract cannot be rolled back.** If deployed wrongly, the only path is to deploy to a new
address and change the configuration, and the roots anchored before that remain on the old
contract. Explorer's proof verification would then span two addresses, so **not producing that
state is the purpose of this procedure.**

`pause` can be reversed. In a security incident, the `pauser` moves first, not a new deployment.
Pause stops submissions **and** corrections (`revokeBatch`, `supersedeBatch`): both are
permanent, so a compromised submitter must not be able to make them after the pause. Reads and
proof verification keep working. Rotate the submitter role, then unpause, then correct.

When correcting, supersede before you revoke. A batch takes one `supersededBy` link, and only an
unrevoked chain head can become a successor, so **revoking a successor ends its predecessor's
line for good** (after A→B, revoking B leaves A with no way forward). Submit the replacement,
supersede the bad head with it, and revoke a head only when its line should end.
