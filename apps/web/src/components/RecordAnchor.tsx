"use client";

import { useEffect, useState } from "react";
import { ApiError, getInclusionProof, type InclusionProof } from "@/lib/api";
import { blockExplorerTxUrl, chainDisplayName } from "@/lib/wallet";

type Lookup =
  | { state: "loading" | "absent" | "unavailable" }
  | { state: "ready"; proof: InclusionProof };

export function useRecordAnchor(versionId: string) {
  const [lookup, setLookup] = useState<Lookup>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    getInclusionProof(versionId).then(proof => {
      if (current) setLookup(proof.entryVersionId === versionId
        ? { state: "ready", proof } : { state: "unavailable" });
    }).catch((error: unknown) => {
      if (current) setLookup({ state: error instanceof ApiError && error.status === 404 &&
        error.envelope.code === "NOT_FOUND" ? "absent" : "unavailable" });
    });
    return () => { current = false; };
  }, [versionId, attempt]);
  function retry() {
    setLookup({ state: "loading" });
    setAttempt(value => value + 1);
  }
  return { lookup, retry };
}

export function hasConfirmedAnchor(proof: InclusionProof): boolean {
  return proof.merkleVerified && proof.included && proof.confirmationState === "confirmed" &&
    Number.isSafeInteger(proof.chainId) && Number(proof.chainId) > 0 && /^0x[0-9a-f]{64}$/i.test(proof.transactionHash ?? "");
}

export function isAnchorPending(proof: InclusionProof): boolean {
  return proof.merkleVerified && !proof.included && ["created", "signed", "proposed", "submitted", "included"].includes(proof.confirmationState);
}

function anchorSummary(proof: InclusionProof) {
  if (!proof.merkleVerified) return "Proof does not match the batch";
  switch (proof.confirmationState) {
    case "created":
    case "signed": return "Batch prepared · awaiting submission";
    case "proposed": return "Anchor proposed · awaiting approval";
    case "submitted":
    case "included": return "Transaction submitted · awaiting confirmation";
    case "confirmed":
      return hasConfirmedAnchor(proof) && proof.chainId !== null
        ? `Confirmed on ${chainDisplayName(proof.chainId)}` : "Confirmation could not be verified";
    case "replaced":
    case "reverted":
    case "reorged":
    case "dropped":
    case "failed":
    case "reconciliation_required": return "Anchor not confirmed · needs attention";
    default: return "Confirmation status unavailable";
  }
}

export function RecordAnchor({ lookup, retry, version }: {
  readonly lookup: Lookup;
  readonly retry: () => void;
  readonly version: string;
}) {
  const proof = lookup.state === "ready" ? lookup.proof : null;
  const url = proof && hasConfirmedAnchor(proof) && proof.chainId !== null && proof.transactionHash ? blockExplorerTxUrl(proof.chainId, proof.transactionHash) : null;
  const messages = {
    absent: "Not recorded on-chain",
    unavailable: "Could not load on-chain status",
    loading: "Checking on-chain status…",
  };
  return <div className="record-anchor" aria-label="On-chain record" role="status">
    <strong>On-chain record · v{version}</strong>
    <span className={proof && hasConfirmedAnchor(proof) ? "state-label state-reviewed" : "state-label"}>
      {lookup.state === "ready" ? anchorSummary(lookup.proof) : messages[lookup.state]}
    </span>
    {url ? <a href={url} target="_blank" rel="noreferrer">View transaction ↗</a> : null}
    {lookup.state === "unavailable" ? <button type="button" onClick={retry}>Retry status</button> : null}
  </div>;
}
