import type { StateMachine } from "./state-machine.js";
import type { AttestationType, VerificationState } from "./provenance.js";

/**
 * Movement on the provenance axes — spec 05 §5.3, REQ-DAPP-004.
 *
 * A claim's verification state is an outcome of verification, not something its submitter
 * declares. It is derived from the attestations standing over the claim, so signing moves it up
 * and a revocation or supersession moves it back down to what the remaining attestations support.
 */

/** What each attestation type establishes about a claim. */
const STATE_ESTABLISHED_BY: Readonly<Record<AttestationType, VerificationState>> = {
  // A machine-verifiable proof checks integrity, not meaning.
  cryptographic_attestation: "machine_checked",
  professional_signoff: "analyst_checked",
  laboratory_accreditation: "analyst_checked",
  legal_notarization: "analyst_checked",
  independent_assurance: "independently_assured",
};

const RANK: Readonly<Record<Exclude<VerificationState, "rejected">, number>> = {
  unreviewed: 0,
  machine_checked: 1,
  analyst_checked: 2,
  independently_assured: 3,
};

/**
 * The verification state the standing attestations support.
 *
 * `rejected` is kept once reached: an attestation elsewhere does not un-reject a claim, and no
 * outcome here produces it — rejection is a separate decision.
 */
export function deriveVerificationState(input: {
  readonly current: VerificationState;
  readonly standingAttestationTypes: readonly AttestationType[];
}): VerificationState {
  if (input.current === "rejected") return "rejected";

  let best: Exclude<VerificationState, "rejected"> = "unreviewed";
  for (const type of input.standingAttestationTypes) {
    const established = STATE_ESTABLISHED_BY[type] as Exclude<VerificationState, "rejected">;
    if (RANK[established] > RANK[best]) best = established;
  }
  return best;
}

/**
 * Attestation states that count as standing for a claim.
 *
 * The same set the grade computation uses. A `disputed`, `stale_candidate`, `revoked` or
 * `superseded` attestation no longer supports the claim.
 */
export const STANDING_ATTESTATION_STATES = ["signed", "active"] as const;

export const ARTIFACT_LIFECYCLE_STATES = [
  "created",
  "validated",
  "accepted",
  "rejected",
  "superseded",
  "revoked",
  "published",
] as const;
export type ArtifactLifecycleState = (typeof ARTIFACT_LIFECYCLE_STATES)[number];

/**
 * Artifact lifecycle — 05 §5.3. `created → validated → accepted|rejected → superseded|revoked`,
 * and only a `public_projection` may be `published`. The DB mirrors this table
 * (`core.artifact_lifecycle_allows`, migration 0064).
 */
export const artifactLifecycleMachine: StateMachine<ArtifactLifecycleState> = {
  name: "artifact_lifecycle",
  initial: "created",
  states: ARTIFACT_LIFECYCLE_STATES,
  transitions: {
    created: ["validated", "rejected", "superseded", "revoked"],
    validated: ["accepted", "rejected", "superseded", "revoked"],
    accepted: ["published", "superseded", "revoked"],
    published: ["superseded", "revoked"],
    rejected: [],
    superseded: [],
    revoked: [],
  },
};
