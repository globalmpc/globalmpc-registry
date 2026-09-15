import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import {
  decideRegistryProposalRequest,
  proposeAttestationSchemaRequest,
  proposeCredentialRequest,
  proposePolicySetRequest,
  type REGISTRY_KINDS,
} from "@mpc/api-contract";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import {
  findAttestationSchema,
  findCredential,
  findPolicySet,
  holderOrganization,
  materializeAttestationSchema,
  materializeCredential,
  materializePolicySet,
  validateAttestationSchema,
  validateCredential,
  validatePolicySet,
  type Validated,
} from "../services/review-registry.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
  type EnrolledSession,
} from "./shared.js";

/**
 * Review registry proposals — spec 02 §2.8, W-066 / Q-020.
 *
 * Credentials, attestation schemas and compliance policy sets used to be created only by the
 * bootstrap CLI, where "approval" was a name the operator typed. Here the operator proposes and
 * **someone else, holding the designated review role, decides**. Approval writes the registry
 * row through the same function the CLI uses.
 *
 * **Why an HTTP path at all (Q-020).** Keeping these in the CLI, as tenant creation is (Q-003),
 * would keep one hijacked operator session away from them — but it would also keep approval a
 * statement nobody verifies, and schemas and policies gain versions for as long as the system
 * runs, so the CLI would be a standing path, not a one-time seed. What limits a hijacked
 * operator session here is that it can only propose: approval needs a second, different
 * person, and the DB rejects a decision by the proposer (`registry_proposal_two_person`).
 *
 * **Superseding does not mutate.** A new version is a new proposal and, once approved, a new
 * row. The previous row keeps its state and content — assessments and attestations made under
 * it stay reproducible (02 §2.8 forbids retroactive change).
 */

type Tx = postgres.TransactionSql;
type RegistryKind = (typeof REGISTRY_KINDS)[number];

interface ProposalRow {
  id: string;
  kind: RegistryKind;
  item_key: string;
  item_version: number;
  payload: Record<string, unknown>;
  rationale: string;
  effective_from: Date;
  proposed_by_subject_id: string;
  proposed_at: Date;
  state: "pending" | "approved" | "rejected";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  materialized_id: string | null;
  version: number;
}

function toProposal(row: ProposalRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    kind: row.kind,
    itemKey: row.item_key,
    itemVersion: row.item_version,
    payload: row.payload,
    rationale: row.rationale,
    effectiveFrom: row.effective_from.toISOString(),
    proposedBySubjectId: row.proposed_by_subject_id,
    proposedAt: row.proposed_at.toISOString(),
    state: row.state,
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    materializedId: row.materialized_id,
    version: row.version,
    requestId,
    asOf,
  };
}

/** What a proposal records, resolved and validated at proposal time. */
interface Prepared<Stored> {
  readonly itemKey: string;
  readonly effectiveFrom: Date;
  readonly payload: Stored;
}

/**
 * What differs between the three registries. Everything else — authorization, the two-person
 * rule, versions, audit — is shared, so it cannot differ.
 */
interface KindSpec<Body extends { rationale: string }, Stored extends Record<string, unknown>> {
  readonly kind: RegistryKind;
  /** Path segment under `/api/v1/review-registry/`. */
  readonly segment: string;
  /** Audit resource type of the registry row approval creates. */
  readonly resourceType: string;
  readonly requestSchema: z.ZodType<Body, z.ZodTypeDef, unknown>;
  /** Shape of `payload` as stored. Re-read at decision time rather than trusted blindly. */
  readonly storedSchema: z.ZodType<Stored, z.ZodTypeDef, unknown>;
  prepare(tx: Tx, tenantId: string, body: Body, now: Date): Promise<Validated<Prepared<Stored>>>;
  /** The registry row this version would duplicate, if one exists. */
  findExisting(tx: Tx, tenantId: string, stored: Stored): Promise<string | null>;
  /** Re-validates (time has passed since the proposal) and writes the registry row. */
  materialize(tx: Tx, tenantId: string, id: string, stored: Stored, now: Date): Promise<Validated<true>>;
  /** Whose credential this is — they do not approve it themselves. */
  holderOf?(stored: Stored): string;
}

// --- credential -------------------------------------------------------------

const storedCredential = proposeCredentialRequest
  .omit({ rationale: true })
  .extend({ organizationId: z.string().uuid().nullable() });
type StoredCredential = z.infer<typeof storedCredential>;

const CREDENTIAL: KindSpec<z.infer<typeof proposeCredentialRequest>, StoredCredential> = {
  kind: "credential",
  segment: "credentials",
  resourceType: "credential",
  requestSchema: proposeCredentialRequest,
  storedSchema: storedCredential,
  async prepare(tx, tenantId, body, now) {
    const checked = validateCredential(body, now);
    if (!checked.ok) return checked;

    const [subject] = await tx<{ id: string }[]>`
      SELECT id FROM core.subjects WHERE tenant_id = ${tenantId} AND id = ${body.subjectId}
    `;
    if (!subject) throw notFound("Subject not found");

    // Resolved now and stored, so the approver sees the organization that will be recorded.
    const organizationId = await holderOrganization(tx, tenantId, body.subjectId);
    const { rationale: _rationale, ...fields } = body;
    return {
      ok: true,
      value: {
        itemKey: `${body.subjectId}/${body.issuerReference}`,
        effectiveFrom: checked.value.issuedAt,
        payload: { ...fields, organizationId },
      },
    };
  },
  async findExisting(tx, tenantId, stored) {
    return (await findCredential(tx, tenantId, stored.subjectId, stored.issuerReference))?.id ?? null;
  },
  async materialize(tx, tenantId, id, stored, now) {
    // It may have expired while waiting for a decision.
    const checked = validateCredential(stored, now);
    if (!checked.ok) return checked;
    await materializeCredential(tx, {
      id,
      tenantId,
      subjectId: stored.subjectId,
      organizationId: stored.organizationId,
      credential: checked.value,
    });
    return { ok: true, value: true };
  },
  holderOf: (stored) => stored.subjectId,
};

// --- attestation schema -----------------------------------------------------

const storedSchema = proposeAttestationSchemaRequest.omit({ rationale: true, effectiveFrom: true });
type StoredSchema = z.infer<typeof storedSchema>;

const ATTESTATION_SCHEMA: KindSpec<z.infer<typeof proposeAttestationSchemaRequest>, StoredSchema> = {
  kind: "attestation_schema",
  segment: "attestation-schemas",
  resourceType: "attestation_schema",
  requestSchema: proposeAttestationSchemaRequest,
  storedSchema,
  async prepare(_tx, _tenantId, body) {
    const checked = validateAttestationSchema(body);
    if (!checked.ok) return checked;
    const { rationale: _rationale, effectiveFrom, ...fields } = body;
    return {
      ok: true,
      value: { itemKey: body.schemaKey, effectiveFrom: new Date(effectiveFrom), payload: fields },
    };
  },
  async findExisting(tx, tenantId, stored) {
    return (await findAttestationSchema(tx, tenantId, stored.schemaKey, stored.schemaVersion))?.id ?? null;
  },
  async materialize(tx, tenantId, id, stored) {
    const checked = validateAttestationSchema(stored);
    if (!checked.ok) return checked;
    await materializeAttestationSchema(tx, { id, tenantId, schema: checked.value, state: "active" });
    return { ok: true, value: true };
  },
};

// --- compliance policy set --------------------------------------------------

const storedPolicySet = proposePolicySetRequest.omit({ rationale: true });
type StoredPolicySet = z.infer<typeof storedPolicySet>;

const POLICY_SET: KindSpec<z.infer<typeof proposePolicySetRequest>, StoredPolicySet> = {
  kind: "policy_set",
  segment: "policy-sets",
  resourceType: "compliance_policy_set",
  requestSchema: proposePolicySetRequest,
  storedSchema: storedPolicySet,
  async prepare(_tx, _tenantId, body) {
    const checked = validatePolicySet(body.definition);
    if (!checked.ok) return checked;
    // Version and effective date live in the rule set itself. A second copy on the proposal
    // could disagree with it.
    return {
      ok: true,
      value: {
        itemKey: checked.value.ruleSetId,
        effectiveFrom: new Date(checked.value.effectiveFrom),
        payload: { definition: body.definition },
      },
    };
  },
  async findExisting(tx, tenantId, stored) {
    const checked = validatePolicySet(stored.definition);
    if (!checked.ok) return null;
    return (await findPolicySet(tx, tenantId, checked.value.ruleSetId, checked.value.version))?.id ?? null;
  },
  async materialize(tx, tenantId, id, stored) {
    const checked = validatePolicySet(stored.definition);
    if (!checked.ok) return checked;
    await materializePolicySet(tx, {
      id,
      tenantId,
      ruleSet: checked.value,
      definition: stored.definition,
      state: "effective",
    });
    return { ok: true, value: true };
  },
};

// --- routes -----------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** A proposal names the person who made it. A session without a subject has no one to name. */
function subjectOf(session: EnrolledSession): string {
  if (!session.subjectId) {
    throw forbidden("SUBJECT_REQUIRED", "This session is not bound to a person");
  }
  return session.subjectId;
}

function isUniqueViolation(caught: unknown, constraint?: string): boolean {
  if (!(caught instanceof Error) || (caught as { code?: string }).code !== "23505") return false;
  return constraint === undefined || caught.message.includes(constraint);
}

async function readProposal(
  tx: Tx,
  tenantId: string,
  kind: RegistryKind,
  id: string,
): Promise<ProposalRow | undefined> {
  if (!UUID_PATTERN.test(id)) return undefined;
  const [row] = await tx<ProposalRow[]>`
    SELECT * FROM core.registry_proposals
    WHERE tenant_id = ${tenantId} AND kind = ${kind}::core.registry_kind AND id = ${id}
  `;
  return row;
}

async function lockProposal(
  tx: Tx,
  tenantId: string,
  kind: RegistryKind,
  id: string,
): Promise<ProposalRow | undefined> {
  if (!UUID_PATTERN.test(id)) return undefined;
  const [row] = await tx<ProposalRow[]>`
    SELECT * FROM core.registry_proposals
    WHERE tenant_id = ${tenantId} AND kind = ${kind}::core.registry_kind AND id = ${id}
    FOR UPDATE
  `;
  return row;
}

async function nextItemVersion(
  tx: Tx,
  tenantId: string,
  kind: RegistryKind,
  itemKey: string,
): Promise<number> {
  const [row] = await tx<{ next: number }[]>`
    SELECT COALESCE(max(item_version), 0) + 1 AS next FROM core.registry_proposals
    WHERE tenant_id = ${tenantId} AND kind = ${kind}::core.registry_kind AND item_key = ${itemKey}
  `;
  return Number(row!.next);
}

function registerKind<Body extends { rationale: string }, Stored extends Record<string, unknown>>(
  app: FastifyInstance,
  sql: postgres.Sql,
  spec: KindSpec<Body, Stored>,
): void {
  const base = `/api/v1/review-registry/${spec.segment}/proposals`;

  function readContext(request: FastifyRequest) {
    const context = requireReadContext(request);
    assertAuthorized(
      context.session,
      "review_registry.read",
      tenantResource(context.tenantId),
      sessionFacts(context.session),
    );
    return context;
  }

  app.get(base, async (request) => {
    const { tenantId } = readContext(request);
    const { requestId, asOf } = request.context;
    // Pending first — that is what the reader is here to decide.
    const rows = await withTenant(sql, { tenantId }, (tx) => tx<ProposalRow[]>`
      SELECT * FROM core.registry_proposals
      WHERE tenant_id = ${tenantId} AND kind = ${spec.kind}::core.registry_kind
      ORDER BY (state = 'pending') DESC, proposed_at DESC
    `);
    return { items: rows.map((row) => toProposal(row, requestId, asOf)), requestId, asOf };
  });

  app.get<{ Params: { proposalId: string } }>(`${base}/:proposalId`, async (request, reply) => {
    const { tenantId } = readContext(request);
    const { requestId, asOf } = request.context;
    const row = await withTenant(sql, { tenantId }, (tx) =>
      readProposal(tx, tenantId, spec.kind, request.params.proposalId),
    );
    if (!row) throw notFound("Proposal not found");
    reply.header("etag", etagOf(row.version));
    return toProposal(row, requestId, asOf);
  });

  app.post(base, async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "review_registry.propose",
      tenantResource(tenantId),
      sessionFacts(session),
    );
    const body = parseBody(spec.requestSchema, request.body);
    const proposer = subjectOf(session);

    const { requestId, asOf, correlationId } = request.context;
    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
        const prepared = await spec.prepare(tx, tenantId, body, new Date(asOf));
        if (!prepared.ok) throw unprocessable(prepared.code, prepared.message, prepared.details);
        const { itemKey, effectiveFrom, payload } = prepared.value;

        // Refused up front: failing at approval would leave the approver unable to act on it.
        const existing = await spec.findExisting(tx, tenantId, payload);
        if (existing) {
          throw conflict("REGISTRY_ITEM_EXISTS", "This version is already in the registry", {
            registryId: existing,
          });
        }

        const [pending] = await tx<{ id: string }[]>`
          SELECT id FROM core.registry_proposals
          WHERE tenant_id = ${tenantId} AND kind = ${spec.kind}::core.registry_kind
            AND item_key = ${itemKey} AND state = 'pending'
        `;
        if (pending) {
          throw conflict("REGISTRY_PROPOSAL_PENDING", "A proposal for this item is already waiting", {
            pendingProposalId: pending.id,
          });
        }

        const id = randomUUID();
        const itemVersion = await nextItemVersion(tx, tenantId, spec.kind, itemKey);
        try {
          await tx`
            INSERT INTO core.registry_proposals (
              id, tenant_id, kind, item_key, item_version, payload, rationale,
              effective_from, proposed_by_subject_id
            ) VALUES (
              ${id}, ${tenantId}, ${spec.kind}::core.registry_kind, ${itemKey}, ${itemVersion},
              ${tx.json(payload as never)}, ${body.rationale}, ${effectiveFrom}, ${proposer}
            )
          `;
        } catch (caught) {
          // Another proposal for the same item landed between the check and the insert.
          if (isUniqueViolation(caught)) {
            throw conflict("REGISTRY_PROPOSAL_PENDING", "A proposal for this item is already waiting");
          }
          throw caught;
        }

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: `review_registry.${spec.kind}.proposed`,
          resourceType: "registry_proposal",
          resourceId: id,
          afterVersion: 1,
          reason: body.rationale,
          correlationId,
          requestIp: request.ip,
          detail: { kind: spec.kind, itemKey, itemVersion },
        });

        const row = await readProposal(tx, tenantId, spec.kind, id);
        return toProposal(row!, requestId, asOf);
      }),
    );
  });

  app.post<{ Params: { proposalId: string } }>(
    `${base}/:proposalId/decision`,
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // If-Match before authorization and body: a missing header is answered as missing, not
      // hidden behind a 403 or a body error the client would keep fixing.
      const expected = requireIfMatch(request);
      const effectiveRole = assertAuthorized(
        session,
        "review_registry.approve",
        tenantResource(tenantId, {
          state: "pending",
          statesAllowingAction: ["pending"],
          // Approval requires independence, as authority review does.
          separationSensitive: true,
        }),
        sessionFacts(session),
      );
      const body = parseBody(decideRegistryProposalRequest, request.body);
      const decider = subjectOf(session);

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
          const proposal = await lockProposal(tx, tenantId, spec.kind, request.params.proposalId);
          if (!proposal) throw notFound("Proposal not found");
          assertVersionMatches(expected, proposal.version, "registry_proposal");

          if (proposal.state !== "pending") {
            throw unprocessable("REGISTRY_PROPOSAL_ALREADY_DECIDED", "Proposal is already decided", {
              state: proposal.state,
            });
          }

          /**
           * Two-person rule — 02 §2.8.
           *
           * The DB CHECK blocks the same thing, but filtering here first says why. A constraint
           * violation message does not tell the user what to do next.
           */
          if (proposal.proposed_by_subject_id === decider) {
            throw unprocessable(
              "REGISTRY_PROPOSAL_SELF_APPROVAL",
              "The proposer cannot decide their own proposal",
              { hint: "Another holder of the review role decides" },
            );
          }

          const stored = spec.storedSchema.parse(proposal.payload);
          const approved = body.decision === "approve";
          const materializedId = approved
            ? await materializeApproved(tx, tenantId, spec, stored, decider, new Date(asOf))
            : null;

          await tx`
            UPDATE core.registry_proposals
            SET state = ${approved ? "approved" : "rejected"}::core.registry_proposal_state,
                decided_by_subject_id = ${decider},
                decided_at = now(),
                decision_reason = ${body.reason},
                materialized_id = ${materializedId},
                version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${proposal.id}
          `;

          const detail = {
            kind: spec.kind,
            itemKey: proposal.item_key,
            itemVersion: proposal.item_version,
            materializedId,
          };
          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: `review_registry.${spec.kind}.${approved ? "approved" : "rejected"}`,
            resourceType: "registry_proposal",
            resourceId: proposal.id,
            beforeVersion: proposal.version,
            afterVersion: proposal.version + 1,
            reason: body.reason,
            correlationId,
            requestIp: request.ip,
            detail,
          });

          // The registry row's own record points back to the proposal that justified it.
          if (materializedId) {
            await recordAudit(tx, {
              tenantId,
              session,
              effectiveRole,
              command: `review_registry.${spec.kind}.materialized`,
              resourceType: spec.resourceType,
              resourceId: materializedId,
              afterVersion: 1,
              reason: proposal.rationale,
              correlationId,
              requestIp: request.ip,
              detail: {
                ...detail,
                proposalId: proposal.id,
                effectiveFrom: proposal.effective_from.toISOString(),
              },
            });
          }

          reply.header("etag", etagOf(proposal.version + 1));
          const row = await readProposal(tx, tenantId, spec.kind, proposal.id);
          return toProposal(row!, requestId, asOf);
        }),
      );
    },
  );
}

/** Writes the registry row for an approved proposal and returns its id. */
async function materializeApproved<Body extends { rationale: string }, Stored extends Record<string, unknown>>(
  tx: Tx,
  tenantId: string,
  spec: KindSpec<Body, Stored>,
  stored: Stored,
  decider: string,
  now: Date,
): Promise<string> {
  // A credential's holder does not confirm their own credential (02 §2.8, §2.9).
  if (spec.holderOf?.(stored) === decider) {
    throw unprocessable(
      "REGISTRY_CREDENTIAL_SELF_APPROVAL",
      "The holder cannot approve their own credential",
      { hint: "Another holder of the review role decides" },
    );
  }

  const existing = await spec.findExisting(tx, tenantId, stored);
  if (existing) {
    throw conflict("REGISTRY_ITEM_EXISTS", "This version is already in the registry", {
      registryId: existing,
    });
  }

  const id = randomUUID();
  let result: Validated<true>;
  try {
    result = await spec.materialize(tx, tenantId, id, stored, now);
  } catch (caught) {
    // The CLI inserted the same version between the check and the insert.
    if (isUniqueViolation(caught)) {
      throw conflict("REGISTRY_ITEM_EXISTS", "This version is already in the registry");
    }
    throw caught;
  }
  if (!result.ok) throw unprocessable(result.code, result.message, result.details);
  return id;
}

export async function registerReviewRegistryRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  registerKind(app, sql, CREDENTIAL);
  registerKind(app, sql, ATTESTATION_SCHEMA);
  registerKind(app, sql, POLICY_SET);
}
