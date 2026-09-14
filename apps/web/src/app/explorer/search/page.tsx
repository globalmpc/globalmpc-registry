"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { searchPublicRecords, type PublicSearchMatch, type PublicSearchResult } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { GlobalSearchForm } from "@/components/GlobalSearchForm";
import { TxLink } from "@/components/TxLink";

/** 지갑 주소 모양. 공개 기록에는 제출자 주소가 없어서 이것으로는 찾을 수 없다. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

const MATCHED_ON_LABEL: Readonly<Record<PublicSearchMatch["matchedOn"], string>> = {
  transaction_hash: "Transaction hash",
  merkle_root: "Merkle root",
  leaf_hash: "Leaf hash",
  batch_id: "Batch id",
  public_key: "Registry key",
  text: "Name, country, or mineral",
};

function recordHref(match: PublicSearchMatch): string {
  return match.registryType === "project"
    ? `/explorer/projects/${encodeURIComponent(match.publicKey)}`
    : `/explorer?registryType=${match.registryType}&publicKey=${encodeURIComponent(match.publicKey)}`;
}

/**
 * 공개 통합 검색 결과.
 *
 * 방문자가 가진 단서가 무엇이든(registry key, BscScan의 transaction hash, 증명서의
 * Merkle root·leaf hash) 게시된 기록으로 잇는다. `?q=`를 받으므로 결과를 링크로
 * 보낼 수 있다.
 */
export default function PublicSearchPage() {
  const [query, setQuery] = useState<string | null>(null);
  const [result, setResult] = useState<PublicSearchResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
    setQuery(q);
    if (!q || ADDRESS_SHAPE.test(q)) return;
    searchPublicRecords(q)
      .then(setResult)
      .catch((caught: unknown) => setError(caught));
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Search public records</h1>
          <p className="sub">
            Look up a published record by its registry key, the transaction that anchored it, the
            Merkle root, or its leaf hash.
          </p>
        </div>
      </div>

      <GlobalSearchForm initial={query ?? ""} />

      {error ? <ErrorNotice error={error} /> : null}

      {query && ADDRESS_SHAPE.test(query) ? (
        <div className="notice" data-testid="search-address-notice">
          <div className="title">Wallet addresses are not searchable here</div>
          Public records do not carry the address of whoever submitted them, so an address cannot
          lead to a record. Search by registry key or by a transaction hash instead.
        </div>
      ) : null}

      {result ? (
        <div className="panel" data-testid="search-results">
          {result.matches.length === 0 ? (
            <p className="sub" style={{ margin: 0 }} data-testid="search-empty">
              Nothing published matches “{result.query}”. This is not a permission problem — only
              published records are searchable.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Registry</th>
                    <th>Matched on</th>
                    <th>Status</th>
                    <th>Version</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matches.map((match) => (
                    <tr key={`${match.entryVersionId}-${match.matchedOn}`}>
                      <td>
                        <Link href={recordHref(match)}>{match.publicKey}</Link>
                      </td>
                      <td className="mono">{match.registryType}</td>
                      <td>{MATCHED_ON_LABEL[match.matchedOn]}</td>
                      <td className="mono">{match.status}</td>
                      <td className="mono">{match.version}</td>
                      <td>
                        {result.kind === "hash" ? (
                          <TxLink chainId={result.chainId} hash={match.transactionHash} />
                        ) : (
                          <span className="meta">Open the record</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
