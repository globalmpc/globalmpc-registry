import type { z } from "zod";
import {
  anchorBatchStatus,
  authorityEntry,
  authorityVersionEntry,
  jurisdictionProfileView,
  publicProjection,
  readinessAssessment,
  registryEntryVersion,
  registryProposal,
  sourceConnectionEntry,
  verificationAttestation,
} from "./resources.js";

/**
 * The nine structures of 06 §6 and their ID · version · status · event linkage — 13 §13.13.
 *
 * Each linkage names the contract schema and field that carries it, and the domain events the
 * structure emits. **A missing linkage is listed in `gaps`, not left out.** The contract test
 * checks both directions: every named field exists in its schema, and every linkage without a
 * field or event is declared a gap. When someone adds the missing piece, the test fails until
 * the gap entry is removed — so this list cannot silently go stale in either direction.
 */
export type StructureLink = "id" | "version" | "status" | "events";

export interface FieldRef {
  readonly schema: z.ZodTypeAny;
  readonly schemaName: string;
  readonly field: string;
}

export interface StructureContract {
  readonly name: string;
  readonly id: FieldRef;
  readonly version: FieldRef | null;
  readonly status: FieldRef | null;
  /** Domain event types the API emits for this structure (07 §7.4, §7.12). */
  readonly events: readonly string[];
  /** Linkages the contract does not carry yet, with the reason. */
  readonly gaps: Readonly<Partial<Record<StructureLink, string>>>;
}

const ref = (schema: z.ZodTypeAny, schemaName: string, field: string): FieldRef => ({
  schema,
  schemaName,
  field,
});

export const NINE_STRUCTURES: readonly StructureContract[] = [
  {
    name: "Authority & Trust Registry",
    id: ref(authorityEntry, "authorityEntry", "id"),
    version: ref(authorityVersionEntry, "authorityVersionEntry", "version"),
    status: ref(authorityEntry, "authorityEntry", "state"),
    events: ["authority.registered", "authority.state_changed"],
    gaps: {},
  },
  {
    name: "Verification Party Registry",
    id: ref(registryProposal, "registryProposal", "id"),
    version: ref(registryProposal, "registryProposal", "itemVersion"),
    status: ref(registryProposal, "registryProposal", "state"),
    events: [],
    gaps: { events: "credential approval writes an audit record but emits no domain event" },
  },
  {
    name: "Attestation Schema Registry",
    id: ref(registryProposal, "registryProposal", "id"),
    version: ref(registryProposal, "registryProposal", "itemVersion"),
    status: ref(registryProposal, "registryProposal", "state"),
    events: [],
    gaps: { events: "schema approval writes an audit record but emits no domain event" },
  },
  {
    name: "Verification Attestation",
    id: ref(verificationAttestation, "verificationAttestation", "id"),
    version: null,
    status: ref(verificationAttestation, "verificationAttestation", "state"),
    events: ["verification_attestation.signed", "verification_attestation.disputed"],
    gaps: {
      version: "versions are a supersede chain (`supersedesId`); the record has no version field",
    },
  },
  {
    name: "Compliance Policy Engine",
    id: ref(readinessAssessment, "readinessAssessment", "id"),
    version: ref(readinessAssessment, "readinessAssessment", "ruleSetVersion"),
    status: ref(readinessAssessment, "readinessAssessment", "status"),
    events: ["readiness.assessed"],
    gaps: {},
  },
  {
    name: "Evidence Snapshot + BNB Chain Anchor",
    id: ref(registryEntryVersion, "registryEntryVersion", "id"),
    version: ref(registryEntryVersion, "registryEntryVersion", "version"),
    status: ref(anchorBatchStatus, "anchorBatchStatus", "confirmationState"),
    events: ["registry.version.published", "anchor.submitted"],
    gaps: {},
  },
  {
    name: "Public Explorer",
    id: ref(publicProjection, "publicProjection", "stableId"),
    version: ref(publicProjection, "publicProjection", "version"),
    status: ref(publicProjection, "publicProjection", "status"),
    events: ["registry.version.published", "registry.version.revoked"],
    gaps: {},
  },
  {
    name: "Evidence Adapter Framework",
    id: ref(sourceConnectionEntry, "sourceConnectionEntry", "id"),
    version: ref(sourceConnectionEntry, "sourceConnectionEntry", "version"),
    status: ref(sourceConnectionEntry, "sourceConnectionEntry", "state"),
    events: ["source_receipt.received"],
    gaps: {},
  },
  {
    name: "Mongolia Jurisdiction Profile",
    id: ref(jurisdictionProfileView, "jurisdictionProfileView", "jurisdiction"),
    version: null,
    status: null,
    events: [],
    gaps: {
      version:
        "reviewed versions are recorded (`core.jurisdiction_profiles`), but this view is computed from authorities on read and carries none",
      status:
        "the reviewed version holds `approved|stale|suspended` (07 §7.12); this view does not carry it",
      events:
        "`jurisdiction_profile.*` is emitted when a reviewed version is recorded, not by this view",
    },
  },
];

/** Field names of an object schema, looking through `.strict()`, `.merge()` and effects. */
export function schemaFields(schema: z.ZodTypeAny): readonly string[] {
  const shape = (schema as { shape?: unknown }).shape;
  if (shape && typeof shape === "object") return Object.keys(shape);
  const inner = (schema as { _def?: { schema?: z.ZodTypeAny; innerType?: z.ZodTypeAny } })._def;
  if (inner?.schema) return schemaFields(inner.schema);
  if (inner?.innerType) return schemaFields(inner.innerType);
  return [];
}
