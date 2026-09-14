import { blockExplorerTxUrl } from "@/lib/wallet";

/**
 * Transaction hash display. Rendered as a link when a chain explorer is available.
 *
 * The link text is the hash itself. Changing it to "View on BscScan" makes it impossible to compare by eye
 * with the hash on the certificate.
 */
export function TxLink({
  chainId,
  hash,
}: {
  readonly chainId: number | null;
  readonly hash: string | null;
}) {
  if (!hash) return <span className="mono">Not submitted</span>;
  const url = chainId === null ? null : blockExplorerTxUrl(chainId, hash);
  return url ? (
    <a className="mono" href={url} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>
      {hash}
    </a>
  ) : (
    <span className="mono" style={{ wordBreak: "break-all" }}>
      {hash}
    </span>
  );
}
