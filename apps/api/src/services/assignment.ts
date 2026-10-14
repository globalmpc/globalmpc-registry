import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { ConflictStatus, IndependenceGap } from "@mpc/domain";
import { conflict, unprocessable } from "../errors.js";
import {
  basisBlockers,
  loadAuthorityBasis,
  loadCredential,
  reviewAssignmentIndependence,
} from "./attestation-basis.js";

/**
 * Appointing a reviewer to a case — spec 02 §2.4·§2.8·§2.9, 13 AC-16, REQ-DAPP-018·044.
 *
 * Case creation and reassignment appoint through this one function, so a replacement reviewer
 * passes exactly the checks the first one did.
 *
 * What the assigner states (`conflictStatus`) is a disclosure. It is recorded as given and an
 * `unresolved` conflict still blocks signing, but it cannot waive a rule the server checks:
 *
 * - the credential belongs to the reviewer, is valid, and its issuer is an accepted authority
 *   recognized for every claim type in the case, and its scope covers them (AC-15·AC-16);
 * - the reviewer is not the assigner, did not submit the evidence, and does not belong to the
 *   operating organization (02 §2.4 rules 1·2, §2.8).
 */

type Tx = postgres.TransactionSql;

export interface AssignReviewerInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly projectId: string;
  readonly claimIds: readonly string[];
  readonly reviewerSubjectId: string;
  readonly credentialId: string;
  readonly conflictStatus: ConflictStatus;
  readonly assignerSubjectId: string | null;
}

export interface Assignment {
  readonly id: string;
  readonly independenceReviewed: boolean;
  readonly independenceGaps: readonly IndependenceGap[];
}

export async function assignReviewer(tx: Tx, input: AssignReviewerInput): Promise<Assignment> {
  const credential = await loadCredential(tx, input.credentialId);
  if (!credential) {
    throw unprocessable("ASSIGNMENT_CREDENTIAL_NOT_FOUND", "Credential not found");
  }
  // A credential is a claim about one person. Assigning someone under another person's
  // credential makes the credential check meaningless (02 §2.9).
  if (credential.subjectId !== input.reviewerSubjectId) {
    throw unprocessable(
      "ASSIGNMENT_CREDENTIAL_NOT_HELD",
      "The credential does not belong to the assigned reviewer",
    );
  }

  const basis = await loadAuthorityBasis(tx, credential, input.claimIds);
  const blockers = basisBlockers({
    basis,
    credentialStatus: credential.currentStatus,
    // Neither is decided at assignment: there is no signature yet, and this is the assignment.
    signatureValid: true,
    assignedToThisCase: true,
  });
  if (blockers.length > 0) {
    throw unprocessable(
      "ASSIGNMENT_BASIS_REJECTED",
      "This credential cannot be the basis for reviewing these claims",
      {
        blockers,
        credentialStatus: credential.currentStatus,
        outsideAuthorityScope: basis.outsideAuthorityScope,
        outsideCredentialScope: basis.outsideCredentialScope,
      },
    );
  }

  const independence = await reviewAssignmentIndependence(tx, {
    projectId: input.projectId,
    claimIds: input.claimIds,
    reviewerSubjectId: input.reviewerSubjectId,
    assignerSubjectId: input.assignerSubjectId,
    credential,
  });
  if (independence.review.violations.length > 0) {
    throw conflict(
      "ASSIGNMENT_INDEPENDENCE_VIOLATION",
      "This reviewer is not independent of the evidence or its operator",
      { violations: independence.review.violations },
    );
  }

  const id = randomUUID();
  await tx`
    INSERT INTO core.assignments (
      id, tenant_id, case_id, subject_id, credential_id,
      independence_reviewed, independence_basis, conflict_status, assigned_by
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.caseId}, ${input.reviewerSubjectId},
      ${input.credentialId}, ${independence.review.reviewed},
      ${tx.json(independence.basis as never)}, ${input.conflictStatus},
      ${input.assignerSubjectId}
    )
  `;

  return {
    id,
    independenceReviewed: independence.review.reviewed,
    independenceGaps: independence.review.gaps,
  };
}
