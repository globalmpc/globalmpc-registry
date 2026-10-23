import { ApiError, apiFetch, type ApiErrorEnvelope } from "./api";

export interface CatalogField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "date";
  required: boolean;
}
export interface CatalogEntry {
  id: string;
  claimType: string;
  catalogVersion: number;
  displayName: string;
  description: string | null;
  definition: { fields: CatalogField[] };
}
export interface LedgerItem {
  grade?: string | null;
  reviewScope?: string[];
  reviews?: {
    reviewerHandle: string;
    credentialType: string;
    attestationType: string;
    signedAt: string;
    limitations: string;
  }[];
  catalogVersion?: number | string;
  claimType: string;
  displayName: string;
  status: string;
  reasons: string[];
  limitations: string[];
}
export interface LedgerSummary {
  evaluatedAt: string;
  inputSnapshotHash: string;
  items: LedgerItem[];
  stages: {
    gateId: string;
    ruleSetVersion: string;
    status: string;
    missing?: string[];
    reviewedItems?: string;
    requiredItems?: string;
  }[];
  currentStage: string | null;
  limitations: string[];
}
export interface LedgerCurrent {
  evaluatedAt: string;
  warnings: {
    catalogVersion?: string;
    claimType: string;
    status: string;
    reasons: string[];
  }[];
}
async function read<T>(path: string, token: string): Promise<T> {
  const response = await apiFetch(path, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok)
    throw new ApiError(
      response.status,
      (await response.json()) as ApiErrorEnvelope,
    );
  return response.json() as Promise<T>;
}
export function listClaimCatalog(token: string, cursor?: string) {
  return read<{ items: CatalogEntry[]; nextCursor: string | null }>(
    `/api/v1/claim-types${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    token,
  );
}
export function getEvidenceLedger(token: string, projectId: string) {
  return read<{ snapshot: LedgerSummary }>(
    `/api/v1/projects/${projectId}/evidence-ledger`,
    token,
  );
}
export async function persistEvidenceLedger(
  token: string,
  projectId: string,
  idempotencyKey: string,
) {
  const response = await apiFetch(
    `/api/v1/projects/${projectId}/evidence-ledger`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: "{}",
    },
  );
  if (!response.ok)
    throw new ApiError(
      response.status,
      (await response.json()) as ApiErrorEnvelope,
    );
  return response.json() as Promise<{
    snapshot: LedgerSummary;
    publicProjection: LedgerSummary & { snapshotId: string };
  }>;
}
