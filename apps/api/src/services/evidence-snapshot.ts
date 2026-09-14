import type postgres from "postgres";
import { canonicalBytes, keccak256, type Hex } from "@mpc/canonical";
import { badRequest } from "../errors.js";

/**
 * Evidence snapshot — spec 04 §4.2, 05 §5.12.
 *
 * 검토자가 서명하는 대상은 "그 시점의 근거 집합"이다. 시점을 고정하지 않으면
 * 서명 후 근거가 바뀌어도 서명이 유효해 보인다.
 *
 * 두 가지 규칙:
 *
 * 1. **artifact ID를 정렬한 뒤 직렬화한다.** 같은 집합이면 순서와 무관하게 같은
 *    hash가 나와야 한다 — 조회 순서가 달라졌다고 snapshot이 달라지면 재현할 수 없다.
 * 2. **빈 snapshot을 만들 수 없다.** 근거 없는 검토는 존재하지 않는다.
 */

export interface EvidenceSnapshot {
  readonly hash: Hex;
  readonly claimIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly receiptIds: readonly string[];
}

interface SnapshotInput {
  readonly claimIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly receiptIds: readonly string[];
  /** claim의 현재 내용까지 포함해야 값이 바뀐 것을 탐지할 수 있다. */
  readonly claimFingerprints: readonly { id: string; valueText: string; grade: string }[];
}

function canonicalForm(input: SnapshotInput) {
  const sorted = <T>(values: readonly T[], key: (value: T) => string) =>
    [...values].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

  return {
    snapshotVersion: "1",
    claimIds: [...input.claimIds].sort(),
    artifactIds: [...input.artifactIds].sort(),
    receiptIds: [...input.receiptIds].sort(),
    claims: sorted(input.claimFingerprints, (claim) => claim.id).map((claim) => ({
      id: claim.id,
      valueText: claim.valueText,
      grade: claim.grade,
    })),
  };
}

export function hashSnapshotInput(input: SnapshotInput): Hex {
  return keccak256(canonicalBytes(canonicalForm(input)));
}

/**
 * verification case의 현재 근거로 snapshot을 만든다.
 *
 * case에 연결된 claim과 그 claim이 근거로 삼는 artifact·receipt를 모은다.
 */
export async function buildEvidenceSnapshot(
  tx: postgres.TransactionSql,
  projectId: string,
  claimIds: readonly string[],
): Promise<EvidenceSnapshot> {
  if (claimIds.length === 0) {
    throw badRequest(
      "EVIDENCE_SNAPSHOT_EMPTY",
      "근거 없는 검토는 만들 수 없다. claim을 하나 이상 지정한다",
    );
  }

  const claims = await tx<{ id: string; value_text: string; grade: string }[]>`
    SELECT id, value_text, grade FROM core.claims
    WHERE project_id = ${projectId} AND id = ANY(${claimIds as string[]}::uuid[])
  `;

  if (claims.length !== claimIds.length) {
    throw badRequest(
      "EVIDENCE_SNAPSHOT_CLAIM_MISSING",
      "지정한 claim 중 이 프로젝트에 없는 것이 있다",
      { requested: claimIds.length, found: claims.length },
    );
  }

  const artifacts = await tx<{ id: string }[]>`
    SELECT id FROM core.artifacts
    WHERE project_id = ${projectId} AND revoked_at IS NULL
  `;

  const receipts = await tx<{ id: string }[]>`
    SELECT id FROM core.source_receipts WHERE project_id = ${projectId}
  `;

  const input: SnapshotInput = {
    claimIds: claims.map((claim) => claim.id),
    artifactIds: artifacts.map((artifact) => artifact.id),
    receiptIds: receipts.map((receipt) => receipt.id),
    claimFingerprints: claims.map((claim) => ({
      id: claim.id,
      valueText: claim.value_text,
      grade: claim.grade,
    })),
  };

  return {
    hash: hashSnapshotInput(input),
    claimIds: input.claimIds,
    artifactIds: input.artifactIds,
    receiptIds: input.receiptIds,
  };
}
