import { blockExplorerAddressUrl } from "@/lib/wallet";

/**
 * Anchor contract display — the contract the anchoring transaction was sent to, as stored.
 *
 * A new contract version is deployed at a new address, so the chain and hash alone do not say
 * which contract holds the root. The address is shown in full, like a transaction hash, so it can
 * be compared by eye with the explorer. Never filled in from this deployment's own contract: an
 * anchor whose contract was not recorded says so instead.
 */
export function ContractLink({
  chainId,
  address,
  transactionHash,
}: {
  readonly chainId: number | null;
  /** Undefined when the API predates the field. */
  readonly address: string | null | undefined;
  readonly transactionHash: string | null;
}) {
  if (!transactionHash) return <span className="mono">Not submitted</span>;
  if (!address) return <span className="meta">Not recorded for this anchor</span>;
  const url = chainId === null ? null : blockExplorerAddressUrl(chainId, address);
  return url ? (
    <a className="mono" href={url} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>
      {address}
    </a>
  ) : (
    <span className="mono" style={{ wordBreak: "break-all" }}>
      {address}
    </span>
  );
}
