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
| Anchor wallet daily cap value | `ANCHOR_DAILY_SPEND_CAP_WEI`. Without it, the worker refuses to start | Sized per [Loss cap for the anchor wallet](README.md#loss-cap-for-the-anchor-wallet) |
| Funding cap and procedure | Code cannot enforce it. It is a finance and operations procedure | **Undecided** |
| Golden path completed on staging | Has it actually run against the mainnet contract? | **Not done** |

**Do not deploy while the four are undecided.** In particular, deploying before the signers are
decided leaves a contract on mainnet whose admin, submitter, and pauser are all one EOA, and there
is no way back from that except changing the address.

## Procedure

### 1. Confirm what is being deployed

```bash
cd contracts
forge build --sizes
forge test -vv        # every test must pass
```

The commit deployed must be **the commit that ran on staging.** Record `git rev-parse HEAD`.

### 2. Prepare the role addresses

```bash
export ANCHOR_ADMIN=0x...      # Safe multisig
export ANCHOR_SUBMITTER=0x...  # Safe multisig
export ANCHOR_PAUSER=0x...     # security response organization
```

If the three are the same, the script prints `WARNING: single-key deployment. Local/testnet only.`
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

### 5. Verify

Finished deploying and working are different things.

```bash
# Did the role go to the Safe? If the deployer EOA still holds it, go back to step 4.
cast call "$ANCHOR_CONTRACT_ADDRESS" "hasRole(bytes32,address)(bool)" \
  "$(cast keccak 'ANCHOR_SUBMITTER_ROLE')" "$ANCHOR_SUBMITTER" --rpc-url "$BSC_MAINNET_RPC"

# Does the worker start against that address? Without `ANCHOR_DAILY_SPEND_CAP_WEI` it
# refuses to start — that refusal is the intent (O1).
docker compose logs anchor-worker | grep anchor.worker.started
```

### 6. A person watches the first submission

Until the first batch reaches `confirmed`, watch `/w/anchors` and the `mpc_anchor_transactions`
gauge together (`deploy/observability/alerts.yml`). On failure, do not retry automatically — it
fails again for the same reason, or becomes a duplicate submission.

## Rolling back

**A contract cannot be rolled back.** If deployed wrongly, the only path is to deploy to a new
address and change the configuration, and the roots anchored before that remain on the old
contract. Explorer's proof verification would then span two addresses, so **not producing that
state is the purpose of this procedure.**

`pause` can be reversed. In a security incident, the `pauser` moves first, not a new deployment.
