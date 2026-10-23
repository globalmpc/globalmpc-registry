import type postgres from "postgres";
import type { Hex } from "@mpc/canonical";
import { notFound, unprocessable, unavailable } from "../errors.js";
import { hashSnapshotInput, snapshotClaimFingerprint, type SnapshotClaimRow } from "./evidence-snapshot.js";
import { canonicalBytes, type CanonicalValue } from "@mpc/canonical";
import {
  computeEvidenceLedger,
  evidenceLedgerSemantic,
  loadEvidenceLedgerSnapshot,
  publicLedgerProjection,
  ledgerInputHash,
} from "@mpc/db";

/** Keep assessment inputs stable until the publication transaction commits. */
export async function lockEvidenceLedgerPublicationInputs(tx: postgres.TransactionSql): Promise<void> {
  try {
    await tx`SELECT core.lock_ledger_publication_inputs()`;
  } catch (error) {
    if ((error as {code?: string}).code === "55P03") {
      throw unavailable("PUBLICATION_EVIDENCE_BUSY", "Evidence is being updated; retry publication with the same idempotency key");
    }
    throw error;
  }
}

/** A ledger is a separately approved, frozen statement, never a client-authored assessment. */
export async function assertEvidenceLedgerProjection(
  tx: postgres.TransactionSql,
  tenantId: string,
  registryType: "project" | "verification",
  projectId: string,
  projection: Readonly<Record<string, unknown>>,
  evaluatedAt: Date,
): Promise<void> {
  const ledger = projection["evidenceLedger"];
  if (ledger === undefined) return;
  if (registryType !== "project" || ledger === null || typeof ledger !== "object") {
    throw unprocessable("PUBLICATION_LEDGER_INVALID", "Only a project can publish an evidence ledger");
  }
  const snapshotId = (ledger as Record<string, unknown>)["snapshotId"];
  if (typeof snapshotId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshotId)) {
    throw unprocessable("PUBLICATION_LEDGER_INVALID", "An assessed snapshot is required");
  }
  const stored = await loadEvidenceLedgerSnapshot(tx, tenantId, projectId, snapshotId);
  if (!stored || stored.inputSnapshotHash !== ledgerInputHash(stored.inputBasis, stored.evaluatedAt)
      || !sameCanonical(ledger, publicLedgerProjection(stored))) {
    throw unprocessable("PUBLICATION_LEDGER_MISMATCH", "The ledger must match this project's recorded assessment");
  }
  const current = await computeEvidenceLedger(tx, tenantId, projectId, evaluatedAt);
  if (!current || !sameCanonical(evidenceLedgerSemantic(stored), evidenceLedgerSemantic(current))) {
    throw unprocessable("PUBLICATION_LEDGER_STALE", "Evidence changed since assessment; assess again and prepare a new draft");
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalBytes(comparableLedger(left))).equals(Buffer.from(canonicalBytes(comparableLedger(right))));
}

/** Private assessment metadata has integer versions; the canonical format uses decimal strings. */
function comparableLedger(value: unknown): CanonicalValue {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(comparableLedger);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, comparableLedger(item)]));
  }
  throw unprocessable("PUBLICATION_LEDGER_INVALID", "The ledger contains an unsupported value");
}

/**
 * What the server knows about a registry subject — spec 05 §5.6·§5.9·§5.12.
 *
 * A publication used to carry its own evidence: the client sent the source snapshot hash, the
 * commercial-reuse status and the lifecycle, and the route stored them. A client that sent a
 * made-up hash, `confirmed` for an unconfirmed source or another project's name got a public,
 * anchored record saying so. Everything here is read from the database instead, and the route
 * rejects a projection that says something different.
 */

export type CommercialReuse = "confirmed" | "unconfirmed" | "prohibited";

export interface PublicationSubject {
  /** The project the entry belongs to. A verification entry belongs to its case's project. */
  readonly projectId: string;
  /** Required public key, when the registry fixes one. */
  readonly publicKey: string | null;
  readonly sourceSnapshotHash: Hex;
  readonly commercialReuse: CommercialReuse;
  /** Projection fields with a server-known value. Stating them differently is a rejection. */
  readonly identity: Readonly<Record<string, unknown>>;
  /** `status` values a projection may carry — the state before or after this publication. */
  readonly acceptedStatuses: readonly string[];
  /** The `status` actually stored. The client does not get to claim it. */
  readonly publishedStatus: string;
}

/**
 * The weakest terms among the receipts win — AC-13, 05 §5.9.
 *
 * "Rights not confirmed are not used as operating, publication or offering grounds." One
 * prohibited source makes the whole basis prohibited, one unconfirmed makes it unconfirmed, and
 * **no receipt at all is unconfirmed** — nothing missing is filled in as present.
 */
export function weakestCommercialReuse(values: readonly string[]): CommercialReuse {
  if (values.length === 0) return "unconfirmed";
  if (values.includes("prohibited")) return "prohibited";
  if (values.every((value) => value === "confirmed")) return "confirmed";
  return "unconfirmed";
}

export async function resolvePublicationSubject(
  tx: postgres.TransactionSql,
  tenantId: string,
  registryType: "project" | "verification",
  subjectId: string,
): Promise<PublicationSubject> {
  return registryType === "project"
    ? resolveProject(tx, tenantId, subjectId)
    : resolveAttestation(tx, tenantId, subjectId);
}

async function resolveProject(
  tx: postgres.TransactionSql,
  tenantId: string,
  projectId: string,
): Promise<PublicationSubject> {
  const [project] = await tx<
    {
      id: string;
      project_key: string;
      name: string;
      host_country_iso3: string;
      minerals: string[];
      lifecycle_state: string;
    }[]
  >`
    SELECT id, project_key, name, host_country_iso3, minerals, lifecycle_state
    FROM core.projects
    WHERE tenant_id = ${tenantId} AND id = ${projectId}
  `;
  if (!project) throw notFound("Project not found");

  /**
   * The project's whole evidence set at this moment, hashed the way a review snapshot is.
   *
   * Unlike a review, a project entry may be published before any evidence exists — the Project
   * Registry is where a project starts (04 §4.3 `draft→registered`). An empty set still hashes
   * to a fixed value, so the recorded hash says "nothing yet" rather than something invented.
   */
  const claims = await tx<SnapshotClaimRow[]>`
    SELECT id, value_text, grade, catalog_entry_id, catalog_version, structured_values, document_upload_ids FROM core.claims
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
  `;
  const artifacts = await tx<{ id: string }[]>`
    SELECT id FROM core.artifacts
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND revoked_at IS NULL
  `;
  const receipts = await tx<{ id: string; commercial_reuse: string }[]>`
    SELECT id, commercial_reuse FROM core.source_receipts
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
  `;

  const sourceSnapshotHash = hashSnapshotInput({
    claimIds: claims.map((claim) => claim.id),
    artifactIds: artifacts.map((artifact) => artifact.id),
    receiptIds: receipts.map((receipt) => receipt.id),
    claimFingerprints: claims.map(snapshotClaimFingerprint),
  });

  // 11 §11.4: `registered` means "a Registry record exists", and publication creates it.
  // Any other state stays — publication does not push the lifecycle forward.
  const publishedStatus =
    project.lifecycle_state === "draft" ? "registered" : project.lifecycle_state;

  return {
    projectId: project.id,
    publicKey: project.project_key,
    sourceSnapshotHash,
    commercialReuse: weakestCommercialReuse(receipts.map((receipt) => receipt.commercial_reuse)),
    identity: {
      stableId: project.id,
      projectKey: project.project_key,
      projectName: project.name,
      hostCountry: project.host_country_iso3,
      mineral: project.minerals,
    },
    acceptedStatuses: [...new Set([project.lifecycle_state, publishedStatus])],
    publishedStatus,
  };
}

/**
 * A Verification Registry entry is a signed attestation — 05 §5.6.
 *
 * "claim/evidence snapshot hash, reviewer credential reference, attestation type…" all come
 * from one signed record. Pointing the entry at a project, or at an attestation still being
 * drafted, would publish a review outcome nobody signed.
 */
const PUBLISHABLE_ATTESTATION_STATES = ["signed", "active"];

async function resolveAttestation(
  tx: postgres.TransactionSql,
  tenantId: string,
  attestationId: string,
): Promise<PublicationSubject> {
  const [attestation] = await tx<
    { id: string; state: string; evidence_snapshot_hash: string; project_id: string }[]
  >`
    SELECT a.id, a.state, a.evidence_snapshot_hash, c.project_id
    FROM core.verification_attestations a
    JOIN core.verification_cases c ON c.tenant_id = a.tenant_id AND c.id = a.case_id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${attestationId}
  `;
  if (!attestation) {
    throw unprocessable(
      "REGISTRY_SUBJECT_NOT_SIGNED",
      "A Verification Registry entry must point to a signed attestation in this tenant",
    );
  }
  if (!PUBLISHABLE_ATTESTATION_STATES.includes(attestation.state)) {
    throw unprocessable(
      "REGISTRY_SUBJECT_NOT_SIGNED",
      "Only a signed or active attestation can be published",
      { state: attestation.state, publishableStates: PUBLISHABLE_ATTESTATION_STATES },
    );
  }

  // The receipts behind the claims the reviewer signed for. A claim without a receipt counts
  // as unconfirmed — its terms are unknown.
  const sources = await tx<{ commercial_reuse: string | null }[]>`
    SELECT r.commercial_reuse
    FROM core.verification_attestations a
    JOIN core.claims cl ON cl.tenant_id = a.tenant_id AND cl.id = ANY (a.claim_scope)
    LEFT JOIN core.source_receipts r
      ON r.tenant_id = cl.tenant_id AND r.id = cl.source_receipt_id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${attestationId}
  `;

  return {
    projectId: attestation.project_id,
    publicKey: null,
    sourceSnapshotHash: attestation.evidence_snapshot_hash as Hex,
    commercialReuse: weakestCommercialReuse(
      sources.map((source) => source.commercial_reuse ?? "unconfirmed"),
    ),
    identity: { stableId: attestation.id },
    acceptedStatuses: [attestation.state],
    publishedStatus: attestation.state,
  };
}

/**
 * Projection fields that disagree with the subject.
 *
 * A field the projection leaves out is not a disagreement — the allowlist decides what may be
 * present, this decides only that what is present is true.
 */
export function projectionMismatches(
  projection: Readonly<Record<string, unknown>>,
  subject: PublicationSubject,
): string[] {
  const mismatched = Object.entries(subject.identity)
    .filter(([field]) => field in projection)
    .filter(([field, value]) => JSON.stringify(projection[field]) !== JSON.stringify(value))
    .map(([field]) => field);

  if (!subject.acceptedStatuses.includes(String(projection["status"]))) {
    mismatched.push("status");
  }
  return mismatched;
}
