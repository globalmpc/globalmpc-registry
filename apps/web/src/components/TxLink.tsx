import { blockExplorerTxUrl } from "@/lib/wallet";

/**
 * transaction hash 표시. 체인 탐색기로 갈 수 있으면 링크로 둔다.
 *
 * 링크 문구는 hash 자체다. "View on BscScan"으로 바꾸면 증명서의 hash와 눈으로
 * 대조할 수 없다.
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
