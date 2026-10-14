import { describe, expect, it } from "vitest";
import {
  artifactLifecycleMachine,
  deriveVerificationState,
} from "../src/provenance-axes.js";
import { canTransition, validateMachine } from "../src/state-machine.js";

describe("verification state follows standing attestations — REQ-DAPP-004", () => {
  it("no attestation leaves a claim unreviewed", () => {
    expect(deriveVerificationState({ current: "unreviewed", standingAttestationTypes: [] })).toBe(
      "unreviewed",
    );
  });

  it("a professional sign-off makes a claim analyst_checked", () => {
    expect(
      deriveVerificationState({
        current: "unreviewed",
        standingAttestationTypes: ["professional_signoff"],
      }),
    ).toBe("analyst_checked");
  });

  it("independent assurance makes a claim independently_assured", () => {
    expect(
      deriveVerificationState({
        current: "unreviewed",
        standingAttestationTypes: ["professional_signoff", "independent_assurance"],
      }),
    ).toBe("independently_assured");
  });

  it("a cryptographic attestation is a machine check only", () => {
    expect(
      deriveVerificationState({
        current: "unreviewed",
        standingAttestationTypes: ["cryptographic_attestation"],
      }),
    ).toBe("machine_checked");
  });

  it("losing the attestation moves the state back down", () => {
    expect(
      deriveVerificationState({ current: "independently_assured", standingAttestationTypes: [] }),
    ).toBe("unreviewed");
  });

  it("rejected stays rejected", () => {
    expect(
      deriveVerificationState({
        current: "rejected",
        standingAttestationTypes: ["independent_assurance"],
      }),
    ).toBe("rejected");
  });
});

describe("artifact lifecycle — 05 §5.3", () => {
  it("is a valid machine", () => {
    expect(() => validateMachine(artifactLifecycleMachine)).not.toThrow();
  });

  it("follows created → validated → accepted → superseded", () => {
    expect(canTransition(artifactLifecycleMachine, "created", "validated")).toBe(true);
    expect(canTransition(artifactLifecycleMachine, "validated", "accepted")).toBe(true);
    expect(canTransition(artifactLifecycleMachine, "accepted", "superseded")).toBe(true);
  });

  it("cannot skip validation", () => {
    expect(canTransition(artifactLifecycleMachine, "created", "accepted")).toBe(false);
  });

  it("revoked and superseded are terminal", () => {
    expect(artifactLifecycleMachine.transitions.revoked).toEqual([]);
    expect(artifactLifecycleMachine.transitions.superseded).toEqual([]);
  });
});
