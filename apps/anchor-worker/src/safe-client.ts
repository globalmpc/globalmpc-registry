import { encodeAbiParameters, getAddress, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Safe Transaction Service integration — spec 08 §8.9.
 *
 * The contract's `ANCHOR_SUBMITTER_ROLE` is held by a Safe multisig. The worker cannot submit
 * directly from an EOA and **only creates proposals** — people collect signatures and execute
 * on the Safe side.
 *
 * To post a proposal the proposer must be a Safe owner and must sign the proposal itself.
 * **That signature counts toward the threshold.** It is a raw signature over `safeTxHash`
 * (v = 27/28), which Safe's `checkNSignatures` accepts as the proposer owner's approval. With a
 * threshold of N, execution needs only N - 1 further owner signatures. Whether the worker
 * should hold an owner key at all is an open decision (OD-12); this module does not settle it.
 *
 * **A posted proposal is not an executed one.** Without separating the two states, the chain
 * can hold nothing while we believe it was "submitted".
 *
 * **Addresses sent to the service are EIP-55 checksummed.** The service rejects a lowercase
 * address in the path with 422 and a lowercase `to` in the body. Configuration and the DB keep
 * lowercase, so the conversion happens here, at the boundary.
 */

export interface SafeTransactionInput {
  readonly safeAddress: string;
  readonly to: string;
  readonly data: string;
  readonly nonce: number;
}

export interface SafeProposal {
  readonly safeTxHash: string;
  readonly nonce: number;
}

export interface SafeClient {
  /**
   * The nonce for the next proposal. Must differ per proposal.
   *
   * Counts proposals still collecting signatures, not only executed ones. Two proposals at the
   * same nonce compete: only one can ever execute.
   */
  nextNonce(safeAddress: string): Promise<number>;
  /** Posts a proposal. Returns the Safe-side identifier. */
  propose(input: SafeTransactionInput): Promise<SafeProposal>;
  /** Proposal status lookup. Includes the transaction hash once executed. */
  status(safeTxHash: string): Promise<SafeProposalStatus>;
}

export type SafeProposalStatus =
  | { readonly kind: "pending"; readonly confirmations: number; readonly threshold: number }
  | { readonly kind: "executed"; readonly transactionHash: string }
  | { readonly kind: "rejected" }
  /**
   * A different transaction executed at this proposal's nonce — a rejection in the Safe UI, or
   * another proposal. This one can never execute.
   */
  | { readonly kind: "replaced"; readonly replacedBy: string }
  | { readonly kind: "unknown" };

/** The next proposal nonce: past every proposal still collecting signatures. */
export function nextNonceAfter(onChainNonce: number, pendingNonces: readonly number[]): number {
  return pendingNonces.reduce((next, nonce) => Math.max(next, nonce + 1), onChainNonce);
}

/**
 * Safe transaction hash — EIP-712.
 *
 * We do not trust the service's value; we compute it ourselves and compare. If the service
 * returned the hash of different calldata, we would sign the wrong thing.
 */
const SAFE_TX_TYPEHASH =
  "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8" as const;

const DOMAIN_SEPARATOR_TYPEHASH =
  "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218" as const;

export function computeSafeTxHash(input: {
  readonly safeAddress: Hex;
  readonly chainId: number;
  readonly to: Hex;
  readonly data: Hex;
  readonly nonce: number;
}): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(input.chainId), input.safeAddress],
    ),
  );

  const safeTxStructHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        SAFE_TX_TYPEHASH,
        input.to,
        // Anchor submission sends no ether. A nonzero value is a fund movement.
        0n,
        keccak256(input.data),
        // CALL(0). DELEGATECALL(1) can rewrite the Safe's storage, so it is not used.
        0,
        0n,
        0n,
        0n,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        BigInt(input.nonce),
      ],
    ),
  );

  // EIP-712: 0x19 0x01 ‖ domainSeparator ‖ structHash
  return keccak256(`0x1901${domainSeparator.slice(2)}${safeTxStructHash.slice(2)}` as Hex);
}

export interface SafeServiceOptions {
  /** Safe Transaction Service base URL. Differs per chain. */
  readonly serviceUrl: string;
  readonly chainId: number;
  /** Proposer key. Must be a Safe owner. Its proposal signature counts toward the threshold. */
  readonly proposerPrivateKey: Hex;
  /** Replaced in tests. */
  readonly fetchImpl?: typeof fetch;
}

interface ServiceMultisigTransaction {
  readonly safe: string;
  readonly safeTxHash: string;
  readonly nonce: number | string;
  readonly isExecuted: boolean;
  readonly isSuccessful: boolean | null;
  readonly transactionHash: string | null;
  readonly confirmations?: unknown[];
  readonly confirmationsRequired: number;
}

interface ServicePage<T> {
  readonly results: readonly T[];
}

export function createSafeClient(options: SafeServiceOptions): SafeClient {
  const proposer = privateKeyToAccount(options.proposerPrivateKey);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchImpl(`${options.serviceUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Safe service ${response.status}: ${body.slice(0, 300)}`);
    }

    // Proposal creation answers 201 without a body. Parsing an empty body as JSON would turn a
    // successful proposal into a failure.
    const body = await response.text();
    return body ? (JSON.parse(body) as unknown) : null;
  }

  /** Multisig transactions of one Safe. `trusted` narrows to owner-posted ones by default. */
  async function listTransactions(
    safeAddress: string,
    query: Record<string, string>,
  ): Promise<readonly ServiceMultisigTransaction[]> {
    const params = new URLSearchParams(query).toString();
    const page = (await request(
      `/api/v1/safes/${getAddress(safeAddress)}/multisig-transactions/?${params}`,
    )) as ServicePage<ServiceMultisigTransaction>;
    return page.results;
  }

  /**
   * Another transaction executed at `nonce`, if any.
   *
   * Asked of the service's index, not of the on-chain nonce. The on-chain nonce moves the moment
   * our own proposal executes, before the service indexes it — judging from it would mark our own
   * success as replaced. `trusted=false` includes transactions executed without being proposed
   * through the service.
   */
  async function executedAtNonce(
    safeAddress: string,
    nonce: number,
  ): Promise<ServiceMultisigTransaction | undefined> {
    const executed = await listTransactions(safeAddress, {
      nonce: String(nonce),
      executed: "true",
      trusted: "false",
    });
    return executed.find((tx) => tx.isExecuted);
  }

  return {
    async nextNonce(safeAddress) {
      // The Safe info nonce is the on-chain one: it does not count proposals awaiting signatures.
      // Same rule as Safe's own API kit (`getNextNonce`): past the highest pending nonce.
      const info = (await request(`/api/v1/safes/${getAddress(safeAddress)}/`)) as {
        nonce: number | string;
      };
      const onChainNonce = Number(info.nonce);
      const pending = await listTransactions(safeAddress, {
        executed: "false",
        nonce__gte: String(onChainNonce),
        ordering: "-nonce",
        limit: "1",
      });
      return nextNonceAfter(
        onChainNonce,
        pending.map((tx) => Number(tx.nonce)),
      );
    },

    async propose(input) {
      const safeTxHash = computeSafeTxHash({
        safeAddress: input.safeAddress as Hex,
        chainId: options.chainId,
        to: input.to as Hex,
        data: input.data as Hex,
        nonce: input.nonce,
      });

      // Proposer signature. The service requires it, and Safe counts it as one owner approval.
      const signature = await proposer.sign({ hash: safeTxHash });

      await request(`/api/v1/safes/${getAddress(input.safeAddress)}/multisig-transactions/`, {
        method: "POST",
        body: JSON.stringify({
          to: getAddress(input.to),
          value: "0",
          data: input.data,
          operation: 0,
          safeTxGas: "0",
          baseGas: "0",
          gasPrice: "0",
          gasToken: null,
          refundReceiver: null,
          nonce: input.nonce,
          contractTransactionHash: safeTxHash,
          sender: proposer.address,
          signature,
        }),
      });

      return { safeTxHash, nonce: input.nonce };
    },

    async status(safeTxHash) {
      try {
        const tx = (await request(
          `/api/v1/multisig-transactions/${safeTxHash}/`,
        )) as ServiceMultisigTransaction;

        if (tx.isExecuted && tx.transactionHash) {
          // Executed does not mean succeeded. A failed execution is also executed.
          return tx.isSuccessful === false
            ? { kind: "rejected" }
            : { kind: "executed", transactionHash: tx.transactionHash.toLowerCase() };
        }

        const winner = await executedAtNonce(tx.safe, Number(tx.nonce));
        if (winner && winner.safeTxHash.toLowerCase() !== safeTxHash.toLowerCase()) {
          return { kind: "replaced", replacedBy: winner.safeTxHash.toLowerCase() };
        }

        return {
          kind: "pending",
          confirmations: tx.confirmations?.length ?? 0,
          threshold: tx.confirmationsRequired,
        };
      } catch {
        // The service does not know this hash. Either not yet propagated or the proposal is
        // gone — the two are indistinguishable here, so nothing is cleaned up automatically.
        return { kind: "unknown" };
      }
    },
  };
}
