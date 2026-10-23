import type postgres from "postgres";
import {
  SOURCE_RESULT_BEHAVIOUR,
  aggregateReadiness,
  weakestGrade,
  type Grade,
  type ReadinessStatus,
  type SourceResult,
} from "@mpc/domain";
import {
  PROJECT_FACT_KEYS,
  type ConfirmationStatus,
  type ProjectFactKey,
  type ProjectScope,
} from "@mpc/api-contract";
import { unprocessable } from "../errors.js";

/**
 * Project Registry reads and the evidence check shared by the project routes.
 *
 * The routes in `projects.ts` and `project-registry.ts` both need the list row and the matrix;
 * keeping the queries here means the list, the PATCH response and the overview cannot describe
 * the same project differently.
 */

type Tx = postgres.TransactionSql;

export interface EvidenceRef {
  readonly kind: "upload" | "source_receipt" | "attestation";
  readonly id: string;
}

/**
 * Checks that an evidence reference exists **in this project** and may carry the status.
 *
 * A bare id is not evidence. Without this check, any UUID — another project's upload, a revoked
 * attestation, a lookup that returned "no record" — would satisfy the database's "confirmed has
 * evidence" rule and make the matrix read as confirmed on nothing.
 *
 * - `upload`: must not be rejected or infected; `confirmed` needs it promoted out of quarantine.
 * - `source_receipt`: `confirmed` needs a result that permits canonical acceptance
 *   (`SOURCE_RESULT_BEHAVIOUR` owns that meaning; a successful call is not a confirmation).
 * - `attestation`: revoked or superseded attestations cannot be a basis (04 invariant 3);
 *   `confirmed` needs one that is signed or active.
 */
export async function assertEvidenceUsable(
  tx: Tx,
  tenantId: string,
  projectId: string,
  evidence: EvidenceRef,
  status: ConfirmationStatus,
): Promise<void> {
  const confirming = status === "confirmed";
  const refuse = (reason: string) =>
    unprocessable("EVIDENCE_NOT_USABLE", "This evidence cannot support the recorded status", {
      evidence,
      status,
      reason,
    });

  if (evidence.kind === "upload") {
    const [row] = await tx<{ state: string }[]>`
      SELECT state FROM core.object_uploads
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${evidence.id}
    `;
    if (!row) throw notInProject(evidence);
    if (row.state === "rejected" || row.state === "scanned_infected") throw refuse(`upload is ${row.state}`);
    if (confirming && row.state !== "promoted") throw refuse(`upload is ${row.state}, not promoted`);
    return;
  }

  if (evidence.kind === "source_receipt") {
    const [row] = await tx<{ result: SourceResult }[]>`
      SELECT result FROM core.source_receipts
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${evidence.id}
    `;
    if (!row) throw notInProject(evidence);
    if (confirming && !SOURCE_RESULT_BEHAVIOUR[row.result].permitsCanonicalAcceptance) {
      throw refuse(`source result ${row.result} does not permit acceptance`);
    }
    return;
  }

  const [row] = await tx<{ state: string }[]>`
    SELECT a.state FROM core.verification_attestations a
    JOIN core.verification_cases c ON c.id = a.case_id AND c.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${tenantId} AND c.project_id = ${projectId} AND a.id = ${evidence.id}
  `;
  if (!row) throw notInProject(evidence);
  if (row.state === "revoked" || row.state === "superseded") throw refuse(`attestation is ${row.state}`);
  if (confirming && row.state !== "signed" && row.state !== "active") {
    throw refuse(`attestation is ${row.state}`);
  }
}

function notInProject(evidence: EvidenceRef) {
  // Another tenant's or another project's id reads the same as a missing one.
  return unprocessable("EVIDENCE_NOT_IN_PROJECT", "No such evidence in this project", { evidence });
}

interface VersionRow {
  key: string;
  version: number;
  status: ConfirmationStatus;
  evidence_kind: EvidenceRef["kind"] | null;
  evidence_ref: string | null;
  as_of: Date | null;
  reason: string;
  recorded_by_subject_id: string;
  recorded_at: Date;
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function evidenceOf(kind: EvidenceRef["kind"] | null, ref: string | null): EvidenceRef | null {
  return kind && ref ? { kind, id: ref } : null;
}

function toVersionView(row: VersionRow) {
  return {
    version: row.version,
    status: row.status,
    evidence: evidenceOf(row.evidence_kind, row.evidence_ref),
    asOf: dateOnly(row.as_of),
    reason: row.reason,
    recordedBySubjectId: row.recorded_by_subject_id,
    recordedAt: row.recorded_at.toISOString(),
  };
}

/**
 * The confirmed/pending matrix — every key, recorded or not.
 *
 * An unrecorded key is returned as `pending` with `recorded: false` rather than left out. A
 * missing row reads as "not applicable" or as "fine"; the matrix must show that nobody has
 * confirmed it yet (11 §11.5).
 *
 * The current value is the latest version, not `project_facts`: rows written before versioning
 * existed have no history, and they are shown as unrecorded rather than trusted.
 */
export async function readFacts(tx: Tx, tenantId: string, projectId: string) {
  const rows = await tx<VersionRow[]>`
    SELECT fact_key AS key, version, status, evidence_kind, evidence_ref, as_of, reason,
           recorded_by_subject_id, recorded_at
    FROM core.project_fact_versions
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
    ORDER BY fact_key, version DESC
  `;

  // Rows written before version history existed (0068 leaves them for review). The offering
  // gate and the lifecycle guard read them, so the screen shows their status too rather than
  // `pending` beside a gate that counts them.
  const unversioned = await tx<{ fact_key: string; status: VersionRow["status"] }[]>`
    SELECT fact_key, status FROM core.project_facts
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
  `;

  const catalog = await tx<{ claim_type: string }[]>`
    SELECT DISTINCT claim_type FROM core.claim_types
    WHERE tenant_id = ${tenantId} AND effective_from <= now()
    ORDER BY claim_type
  `;
  // Catalog confirmations use their exact claim-type key; no mapping to the seven gate facts.
  // Keep historical rows visible even when their catalog is not currently effective.
  const factKeys = [...new Set<string>([
    ...PROJECT_FACT_KEYS,
    ...catalog.map((row) => row.claim_type),
    ...rows.map((row) => row.key),
  ])];
  return factKeys.map((factKey) => {
    const history = rows.filter((row) => row.key === factKey);
    const latest = history[0];
    const legacyStatus = unversioned.find((row) => row.fact_key === factKey)?.status;
    return {
      factKey,
      status: latest?.status ?? legacyStatus ?? ("pending" as const),
      recorded: latest !== undefined,
      evidence: latest ? evidenceOf(latest.evidence_kind, latest.evidence_ref) : null,
      asOf: latest ? dateOnly(latest.as_of) : null,
      version: latest?.version ?? 0,
      history: history.map(toVersionView),
    };
  });
}

export function isProjectFactKey(value: string): value is ProjectFactKey {
  return (PROJECT_FACT_KEYS as readonly string[]).includes(value);
}

interface PartyRow {
  id: string;
  project_id: string;
  party_role: "sponsor_operator" | "host_country_spv" | "issuer";
  legal_name: string;
  organization_id: string | null;
  jurisdiction: string | null;
  status: ConfirmationStatus;
  evidence_kind: EvidenceRef["kind"] | null;
  evidence_ref: string | null;
  as_of: Date | null;
  submitted_by_subject_id: string;
  submitted_at: Date;
  version: number;
}

export async function readParties(tx: Tx, tenantId: string, projectId: string, partyId?: string) {
  const parties = await tx<PartyRow[]>`
    SELECT id, project_id, party_role, legal_name, organization_id, jurisdiction, status,
           evidence_kind, evidence_ref, as_of, submitted_by_subject_id, submitted_at, version
    FROM core.project_parties
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
      AND ${partyId === undefined ? tx`TRUE` : tx`id = ${partyId}`}
    ORDER BY party_role, submitted_at
  `;
  const ids = parties.map((party) => party.id);
  const versions =
    ids.length === 0
      ? []
      : await tx<VersionRow[]>`
          SELECT party_id::text AS key, version, status, evidence_kind, evidence_ref, as_of,
                 reason, recorded_by_subject_id, recorded_at
          FROM core.project_party_versions
          WHERE tenant_id = ${tenantId} AND party_id = ANY(${ids}::uuid[])
          ORDER BY version DESC
        `;

  return parties.map((party) => ({
    id: party.id,
    projectId: party.project_id,
    partyRole: party.party_role,
    legalName: party.legal_name,
    organizationId: party.organization_id,
    jurisdiction: party.jurisdiction,
    status: party.status,
    evidence: evidenceOf(party.evidence_kind, party.evidence_ref),
    asOf: dateOnly(party.as_of),
    submittedBySubjectId: party.submitted_by_subject_id,
    submittedAt: party.submitted_at.toISOString(),
    version: party.version,
    history: versions.filter((row) => row.key === party.id).map(toVersionView),
  }));
}

export async function readRegistrationRequests(tx: Tx, tenantId: string, projectId: string) {
  const rows = await tx<
    {
      id: string;
      project_id: string;
      note: string;
      requested_by_subject_id: string;
      requested_at: Date;
      answered: boolean;
    }[]
  >`
    SELECT r.id, r.project_id, r.note, r.requested_by_subject_id, r.requested_at,
           EXISTS (
             SELECT 1
             FROM core.registry_entries e
             JOIN core.registry_entry_versions v ON v.entry_id = e.id
             WHERE e.tenant_id = r.tenant_id AND e.registry_type = 'project'
               AND e.subject_id = r.project_id AND v.published_at > r.requested_at
           ) AS answered
    FROM core.project_registration_requests r
    WHERE r.tenant_id = ${tenantId} AND r.project_id = ${projectId}
    ORDER BY r.requested_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    note: row.note,
    requestedBySubjectId: row.requested_by_subject_id,
    requestedAt: row.requested_at.toISOString(),
    answeredByPublication: row.answered,
  }));
}

export async function readStakeholderEvents(tx: Tx, tenantId: string, projectId: string) {
  const rows = await tx<
    {
      id: string;
      project_id: string;
      category: "relationship" | "consent" | "obligation" | "dispute";
      summary: string;
      occurred_on: Date;
      status: ConfirmationStatus;
      evidence_kind: EvidenceRef["kind"] | null;
      evidence_ref: string | null;
      supersedes_id: string | null;
      superseded_by_id: string | null;
      recorded_by_subject_id: string;
      recorded_at: Date;
    }[]
  >`
    SELECT e.id, e.project_id, e.category, e.summary, e.occurred_on, e.status, e.evidence_kind,
           e.evidence_ref, e.supersedes_id, s.id AS superseded_by_id,
           e.recorded_by_subject_id, e.recorded_at
    FROM core.project_stakeholder_events e
    LEFT JOIN core.project_stakeholder_events s ON s.supersedes_id = e.id
    WHERE e.tenant_id = ${tenantId} AND e.project_id = ${projectId}
    ORDER BY e.occurred_on DESC, e.recorded_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    category: row.category,
    summary: row.summary,
    occurredOn: dateOnly(row.occurred_on)!,
    status: row.status,
    evidence: evidenceOf(row.evidence_kind, row.evidence_ref),
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
    recordedBySubjectId: row.recorded_by_subject_id,
    recordedAt: row.recorded_at.toISOString(),
  }));
}

export interface ProjectListFilters {
  readonly assignment?: "mine" | undefined;
  readonly stage?: string | undefined;
  readonly hostCountry?: string | undefined;
  readonly grade?: Grade | undefined;
  readonly gap?: "true" | undefined;
  readonly stale?: "true" | undefined;
  readonly referenceStatus?: string | undefined;
}

interface ProjectBaseRow {
  id: string;
  project_key: string;
  name: string;
  host_country_iso3: string;
  minerals: string[];
  reference_status: "none" | "official_reference" | "synthetic_test_project";
  relationship_status: ConfirmationStatus;
  lifecycle_state: string;
  owner_organization_id: string;
  owner_organization_name: string;
  project_registry_status: "none" | "draft" | "published" | "revoked" | "superseded";
  version: number;
  updated_at: Date;
}

/**
 * Project List rows — 11 §11.3.
 *
 * Aggregates (weakest grade, readiness, stale signals) are computed with the domain functions
 * rather than re-ranked in SQL: a second ranking table would sooner or later disagree with the
 * one that readiness and provenance use.
 *
 * Filters run after aggregation and before the limit, so a filtered list is never "the first 50
 * projects, then filtered".
 */
export async function listProjectItems(
  tx: Tx,
  tenantId: string,
  visible: ProjectScope,
  filters: ProjectListFilters,
  subjectId: string | null,
  onlyProjectId?: string,
  /**
   * Rows to read when no filter runs after aggregation (grade, gap, stale). Those filters need
   * every project aggregated first; without them the newest rows are the answer.
   */
  sqlLimit?: number,
) {
  const projects = await tx<ProjectBaseRow[]>`
    SELECT p.id, p.project_key, p.name, p.host_country_iso3, p.minerals, p.reference_status,
           COALESCE(
             (SELECT v.status::text FROM core.project_fact_versions v
              WHERE v.project_id = p.id AND v.fact_key = 'relationship'
              ORDER BY v.version DESC LIMIT 1),
             'pending'
           ) AS relationship_status,
           p.lifecycle_state, p.owner_organization_id, o.legal_name AS owner_organization_name,
           COALESCE(
             (SELECT v.status::text FROM core.registry_entries e
              JOIN core.registry_entry_versions v ON v.entry_id = e.id
              WHERE e.tenant_id = p.tenant_id AND e.registry_type = 'project' AND e.subject_id = p.id
              ORDER BY v.created_at DESC, v.version DESC LIMIT 1),
             'none'
           ) AS project_registry_status,
           p.version, p.updated_at
    FROM core.projects p
    JOIN core.organizations o ON o.id = p.owner_organization_id AND o.tenant_id = p.tenant_id
    WHERE p.tenant_id = ${tenantId}
      AND ${visible === "all" ? tx`TRUE` : tx`p.id = ANY(${visible as string[]}::uuid[])`}
      AND ${onlyProjectId === undefined ? tx`TRUE` : tx`p.id = ${onlyProjectId}`}
      AND ${filters.stage === undefined ? tx`TRUE` : tx`p.lifecycle_state = ${filters.stage}`}
      AND ${
        filters.hostCountry === undefined
          ? tx`TRUE`
          : tx`p.host_country_iso3 = ${filters.hostCountry.toUpperCase()}`
      }
      AND ${
        filters.referenceStatus === undefined
          ? tx`TRUE`
          : tx`p.reference_status = ${filters.referenceStatus}`
      }
      AND ${
        filters.assignment === "mine"
          ? tx`EXISTS (
              SELECT 1 FROM core.assignments a
              JOIN core.verification_cases c ON c.id = a.case_id
              WHERE c.project_id = p.id AND a.subject_id = ${subjectId} AND a.revoked_at IS NULL
            )`
          : tx`TRUE`
      }
    ORDER BY p.updated_at DESC, p.id DESC
    ${sqlLimit === undefined ? tx`` : tx`LIMIT ${sqlLimit}`}
  `;
  if (projects.length === 0) return [];
  const ids = projects.map((project) => project.id);

  const grades = await tx<{ project_id: string; grade: Grade }[]>`
    SELECT project_id, grade FROM core.claims
    WHERE tenant_id = ${tenantId} AND project_id = ANY(${ids}::uuid[]) AND NOT excluded_by_rule
  `;
  const assessments = await tx<{ project_id: string; status: ReadinessStatus }[]>`
    SELECT DISTINCT ON (project_id, gate_id) project_id, status
    FROM core.compliance_assessments
    WHERE tenant_id = ${tenantId} AND project_id = ANY(${ids}::uuid[])
    ORDER BY project_id, gate_id, generated_at DESC
  `;
  const stale = await tx<{ project_id: string; open: number }[]>`
    SELECT project_id, count(*)::int AS open FROM core.evidence_stale_signals
    WHERE tenant_id = ${tenantId} AND project_id = ANY(${ids}::uuid[]) AND resolution = 'open'
    GROUP BY project_id
  `;

  const items = projects.map((project) => {
    const projectGrades = grades.filter((row) => row.project_id === project.id).map((row) => row.grade);
    const latest = assessments
      .filter((row) => row.project_id === project.id)
      .map((row) => row.status);
    return {
      id: project.id,
      projectKey: project.project_key,
      name: project.name,
      hostCountryIso3: project.host_country_iso3,
      minerals: project.minerals,
      referenceStatus: project.reference_status,
      relationshipStatus: project.relationship_status,
      lifecycleState: project.lifecycle_state,
      projectRegistryStatus: project.project_registry_status,
      // Never assessed stays null. aggregateReadiness([]) is not_evaluable, which is a result
      // someone could act on; "no assessment ran" is a different fact.
      readinessSummary: latest.length === 0 ? null : aggregateReadiness(latest),
      weakestGrade: projectGrades.length === 0 ? null : weakestGrade(projectGrades),
      openStaleSignals: stale.find((row) => row.project_id === project.id)?.open ?? 0,
      ownerOrganizationId: project.owner_organization_id,
      ownerOrganizationName: project.owner_organization_name,
      version: project.version,
      updatedAt: project.updated_at.toISOString(),
    };
  });

  return items
    .filter((item) => filters.grade === undefined || item.weakestGrade === filters.grade)
    .filter(
      (item) =>
        filters.gap === undefined ||
        item.readinessSummary === "gap" ||
        item.readinessSummary === "not_evaluable",
    )
    .filter((item) => filters.stale === undefined || item.openStaleSignals > 0);
  // The cap is the route's (`PROJECT_LIST_LIMIT`): cutting here would hide that rows were left out.
}
