import type { AnchorChainMoveRefusal, AnchorChainMoveRequest } from "@/lib/api";

/** What the old chain's worker is waiting for, in plain words. */
export function moveWaitText(request: AnchorChainMoveRequest, chainId: number): string {
  if (request.lastCheckedAt === null) {
    return `the chain ${chainId} worker has not checked it yet`;
  }
  switch (request.waitReason) {
    case "open_send":
      return `waiting: a send is still open on chain ${chainId}`;
    case "open_proposal":
      return `waiting: a Safe proposal is still open on chain ${chainId}`;
    case "signer_pending":
      return `waiting: the signer has a transaction not yet mined on chain ${chainId}`;
    case "check_failed":
      return `waiting: chain ${chainId} could not be read; the worker will retry`;
    case null:
      return `waiting for the chain ${chainId} worker`;
    default:
      return `waiting: ${request.waitReason}`;
  }
}

/**
 * Why the old chain's worker refused the move, and what the operator can do. The batch stays on
 * its chain in every case.
 */
export function moveRefusalText(refusal: AnchorChainMoveRefusal, chainId: number): string {
  const target = refusal.toChainId === null ? "" : ` to chain ${refusal.toChainId}`;
  switch (refusal.reason) {
    case "batch_on_chain":
      return `Move${target} refused: the batch is already on chain ${chainId}`;
    case "other_transaction":
      return `Move${target} refused: the batch has another transaction there`;
    case "send_outcome_unknown":
      // The worker cannot read back what an earlier send did, so the batch may be on chain
      // already, on a contract no record names. A resubmit on the old chain asks only the
      // contract configured now before sending, so the operator checks every contract that chain
      // ever used. A send an operator settled blocks the move for good; one whose receipt the
      // node no longer returns blocks it until the node does.
      return (
        `Move${target} refused: what an earlier send on chain ${chainId} did could not be read ` +
        `back, so the batch may already be there. Check every contract registered for chain ` +
        `${chainId} for this batch before resubmitting it there: a resubmit checks only the ` +
        `contract configured now. Asking for the move again is refused the same way — for good ` +
        `if an operator settled that send.`
      );
    case "target_not_allowed":
      return `Move${target} refused: that chain is not supported, or not in the same environment (mainnet/testnet) as chain ${chainId}`;
    case "not_movable":
      return (
        `Move${target} dropped: the batch's transaction on chain ${chainId} changed ` +
        `(now ${refusal.result ?? "in another state"}) before the move was made; resubmit again ` +
        `if it still needs moving`
      );
    default:
      return `Move${target} refused: ${refusal.reason}`;
  }
}
