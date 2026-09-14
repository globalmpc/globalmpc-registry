import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Safe Transaction Service integration — spec 08 §8.9.
 *
 * The contract's `ANCHOR_SUBMITTER_ROLE` is held by a Safe multisig. The worker cannot submit
 * directly from an EOA and **only creates proposals** — people collect signatures and execute
 * on the Safe side.
 *
 * To post a proposal the proposer must be a Safe owner and must sign the proposal itself. That
 * signature is not execution authority but a mark of "I posted this proposal" — execution
 * separately needs threshold-many owner signatures.
 *
 * **A posted proposal is not an executed one.** Without separating the two states, the chain
 * can hold nothing while we believe it was "submitted".
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
  /** The Safe's next nonce. Must differ per proposal. */
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
  | { readonly kind: "unknown" };

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
  /** Proposer key. Must be a Safe owner. Distinct from execution authority. */
  readonly proposerPrivateKey: Hex;
}

export function createSafeClient(options: SafeServiceOptions): SafeClient {
  const proposer = privateKeyToAccount(options.proposerPrivateKey);

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${options.serviceUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Safe service ${response.status}: ${body.slice(0, 300)}`);
    }

    // 204 has no body. Proposal creation returns it.
    return response.status === 204 ? null : response.json();
  }

  return {
    async nextNonce(safeAddress) {
      const info = (await request(`/api/v1/safes/${safeAddress}/`)) as { nonce: number };
      return info.nonce;
    },

    async propose(input) {
      const safeTxHash = computeSafeTxHash({
        safeAddress: input.safeAddress as Hex,
        chainId: options.chainId,
        to: input.to as Hex,
        data: input.data as Hex,
        nonce: input.nonce,
      });

      // Proposer signature. Not execution authority — a mark of "I posted this proposal".
      const signature = await proposer.sign({ hash: safeTxHash });

      await request(`/api/v1/safes/${input.safeAddress}/multisig-transactions/`, {
        method: "POST",
        body: JSON.stringify({
          to: input.to,
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
        const tx = (await request(`/api/v1/multisig-transactions/${safeTxHash}/`)) as {
          isExecuted: boolean;
          isSuccessful: boolean | null;
          transactionHash: string | null;
          confirmations?: unknown[];
          confirmationsRequired: number;
        };

        if (tx.isExecuted && tx.transactionHash) {
          // Executed does not mean succeeded. A failed execution is also executed.
          return tx.isSuccessful === false
            ? { kind: "rejected" }
            : { kind: "executed", transactionHash: tx.transactionHash.toLowerCase() };
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
