import type postgres from "postgres";
import {
  STANDING_ATTESTATION_STATES,
  computeClaimGrade,
  deriveVerificationState,
  type AttestationType,
  type EvidenceTier,
  type VerificationState,
} from "@mpc/domain";
import { notFound } from "../errors.js";

/**
 * A claim's assessment — spec 05 §5.3, REQ-DAPP-004.
 *
 * The claim's content never changes (migration 0063). What changes is how it is assessed: the
 * verification state follows the attestations standing over it, and the grade follows the state,
 * the attestations and the open conflicts. Both are computed here so that signing, revoking,
 * superseding and recording a conflict cannot each compute them differently.
 */

type Tx = postgres.TransactionSql;

/**
 * Names the cause of the axis changes this transaction makes.
 *
 * The history rows are written by triggers (migration 0064); this is how they learn why. The
 * setting is transaction-local, so it cannot leak into another request.
 */
export async function setProvenanceCause(
  tx: Tx,
  cause: string,
  actorSubjectId: string | null,
): Promise<void> {
  await tx`SELECT set_config('mpc.provenance_cause', ${cause}, true)`;
  await tx`SELECT set_config('mpc.provenance_actor', ${actorSubjectId ?? ""}, true)`;
}

async function standingAttestationTypes(tx: Tx, claimId: string): Promise<AttestationType[]> {
  const rows = await tx<{ attestation_type: AttestationType }[]>`
    SELECT DISTINCT a.attestation_type
    FROM core.verification_attestations a
    WHERE ${claimId}::uuid = ANY(a.claim_scope)
      AND a.state = ANY(${[...STANDING_ATTESTATION_STATES]}::text[])
  `;
  return rows.map((row) => row.attestation_type);
}

/** Recomputes the grade from the claim's attestation and conflict state. */
export async function recomputeGrade(tx: Tx, claimId: string): Promise<string> {
  const [claim] = await tx<
    {
      evidence_tier: EvidenceTier | null;
      verification_state: VerificationState;
      excluded_by_rule: boolean;
    }[]
  >`
    SELECT evidence_tier, verification_state, excluded_by_rule
    FROM core.claims WHERE id = ${claimId}
  `;
  if (!claim) throw notFound("Claim not found");

  const attestationTypes = await standingAttestationTypes(tx, claimId);

  const [conflicts] = await tx<{ count: string }[]>`
    SELECT count(*)::text AS count FROM core.claim_conflicts
    WHERE claim_id = ${claimId} AND resolved_at IS NULL
  `;

  const grade = computeClaimGrade({
    verificationState: claim.verification_state,
    evidenceTier: claim.evidence_tier,
    attestationTypes,
    unresolvedConflictCount: Number(conflicts?.count ?? "0"),
    excludedByRule: claim.excluded_by_rule,
  });

  await tx`UPDATE core.claims SET grade = ${grade}, version = version + 1 WHERE id = ${claimId}`;
  return grade;
}

export interface ClaimReassessment {
  readonly claimId: string;
  readonly fromState: VerificationState;
  readonly toState: VerificationState;
  readonly grade: string;
  readonly version: number;
}

/**
 * Moves a claim's verification state to what its standing attestations support, then
 * recomputes the grade. Called after an attestation is signed, revoked or superseded.
 */
export async function reassessClaim(tx: Tx, claimId: string): Promise<ClaimReassessment> {
  const [claim] = await tx<{ verification_state: VerificationState }[]>`
    SELECT verification_state FROM core.claims WHERE id = ${claimId} FOR UPDATE
  `;
  if (!claim) throw notFound("Claim not found");

  const toState = deriveVerificationState({
    current: claim.verification_state,
    standingAttestationTypes: await standingAttestationTypes(tx, claimId),
  });
  if (toState !== claim.verification_state) {
    await tx`UPDATE core.claims SET verification_state = ${toState} WHERE id = ${claimId}`;
  }

  const grade = await recomputeGrade(tx, claimId);
  const [after] = await tx<{ version: number }[]>`
    SELECT version FROM core.claims WHERE id = ${claimId}
  `;
  return {
    claimId,
    fromState: claim.verification_state,
    toState,
    grade,
    version: after!.version,
  };
}
