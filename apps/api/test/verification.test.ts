import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildServer } from "../src/server.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { hashSnapshotInput } from "../src/services/evidence-snapshot.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describe("evidence snapshot 해시", () => {
  const base = {
    claimIds: ["c1", "c2"],
    artifactIds: ["a1"],
    receiptIds: ["r1"],
    claimFingerprints: [
      { id: "c1", valueText: "100", grade: "verified" },
      { id: "c2", valueText: "200", grade: "partially_verified" },
    ],
  };

  it("순서와 무관하게 같은 hash가 나온다", () => {
    const reordered = {
      claimIds: ["c2", "c1"],
      artifactIds: ["a1"],
      receiptIds: ["r1"],
      claimFingerprints: [...base.claimFingerprints].reverse(),
    };
    expect(hashSnapshotInput(reordered)).toBe(hashSnapshotInput(base));
  });

  it("claim 값이 바뀌면 hash가 바뀐다", () => {
    const changed = {
      ...base,
      claimFingerprints: [
        { id: "c1", valueText: "101", grade: "verified" },
        base.claimFingerprints[1]!,
      ],
    };
    expect(hashSnapshotInput(changed)).not.toBe(hashSnapshotInput(base));
  });

  it("grade가 바뀌면 hash가 바뀐다", () => {
    const changed = {
      ...base,
      claimFingerprints: [
        { id: "c1", valueText: "100", grade: "partially_verified" },
        base.claimFingerprints[1]!,
      ],
    };
    expect(hashSnapshotInput(changed)).not.toBe(hashSnapshotInput(base));
  });

  it("artifact가 추가되면 hash가 바뀐다", () => {
    expect(hashSnapshotInput({ ...base, artifactIds: ["a1", "a2"] })).not.toBe(
      hashSnapshotInput(base),
    );
  });
});

describeDb("Verification과 EIP-712 서명", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let config: AppConfig;
  let claimId: string;
  let stewardToken: string;
  let reviewerToken: string;

  // 매 실행마다 새 키를 만든다. wallet_address는 (address, chain_id) 전역
  // UNIQUE라 고정 키를 쓰면 이전 실행의 행과 충돌한다.
  const reviewerAccount = privateKeyToAccount(generatePrivateKey());
  /** DB의 reviewer wallet을 이 주소로 바꾸므로 헤더도 같은 값을 써야 한다. */
  const reviewerWallet = reviewerAccount.address.toLowerCase();
  const outsiderAccount = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    fx = await setupFixture();
    config = loadConfig(testEnv());

    // reviewer의 wallet 주소를 고정 키의 주소로 바꾼다. 실제 서명을 검증하려면
    // 테스트가 그 키를 갖고 있어야 한다.
    await fx.sql`
      UPDATE core.wallet_identities
      SET wallet_address = ${reviewerAccount.address.toLowerCase()}
      WHERE subject_id = ${fx.reviewerSubjectA}
    `;

    app = await buildServer(config, fx.appSql);

    stewardToken = await signIn(app, fx.stewardA);
    // reviewer는 DB 주소를 바꿨으므로 그 키로 직접 로그인한다.
    reviewerToken = await signIn(app, { address: reviewerWallet as `0x${string}`, account: reviewerAccount });

    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        claimType: "mining_right_registration",
        valueText: "MV-012345",
        sourceCoordinate: { document: "extract", page: "1" },
        evidenceTier: "P1",
        verificationState: "analyst_checked",
      },
    });
    claimId = claim.json().id;
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function createCase() {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectId: fx.projectA,
        schemaId: fx.schemaA,
        claimIds: [claimId],
        reviewerSubjectId: fx.reviewerSubjectA,
        credentialId: fx.credentialA,
      },
    });
    return response.json() as { id: string; assignmentId: string; evidenceSnapshotHash: string };
  }

  async function draftAttestation(
    caseId: string,
    assignmentId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/verification-cases/${caseId}/attestations`,
      headers: { authorization: `Bearer ${reviewerToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        assignmentId,
        attestationType: "professional_signoff",
        claimScope: [claimId],
        findings: [{ note: "등록 상태 확인" }],
        citations: [{ source: "registry-extract" }],
        limitations: "이 검토는 등록 상태에 한정되며 권리 완전성을 확인하지 않는다",
        ...overrides,
      },
    });
  }

  function requestSignature(attestationId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/attestations/${attestationId}/signature-requests`,
      headers: { authorization: `Bearer ${reviewerToken}`, "idempotency-key": idempotencyKey() },
      payload: {},
    });
  }

  async function signTypedData(
    typedData: { domain: unknown; types: unknown; primaryType: string; message: Record<string, unknown> },
    account = reviewerAccount,
  ) {
    // viem의 typed-data 제네릭은 리터럴 타입을 요구한다. 응답은 런타임 값이므로
    // 호출부에서 한 번만 넓힌다.
    const payload = {
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: {
        ...typedData.message,
        issuedAt: BigInt(typedData.message["issuedAt"] as string),
        expiresAt: BigInt(typedData.message["expiresAt"] as string),
      },
    } as unknown as Parameters<typeof account.signTypedData>[0];

    return account.signTypedData(payload);
  }

  function submitSignature(attestationId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/attestations/${attestationId}/signatures`,
      headers: { authorization: `Bearer ${reviewerToken}`, "idempotency-key": idempotencyKey() },
      payload: body,
    });
  }

  it("근거 없이 case를 만들 수 없다", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectId: fx.projectA,
        schemaId: fx.schemaA,
        claimIds: [],
        reviewerSubjectId: fx.reviewerSubjectA,
        credentialId: fx.credentialA,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("배정된 검토자가 목록에서 자기 case와 검토 범위를 찾는다", async () => {
    const created = await createCase();

    // 배정을 만든 사람(steward)과 서명하는 사람(reviewer)이 다르므로, 검토자가
    // 자기 배정에 도달할 경로가 없으면 흐름이 끊긴다.
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/verification-cases`,
      headers: { authorization: `Bearer ${reviewerToken}` },
    });

    expect(response.statusCode).toBe(200);
    const found = (response.json().items as { id: string; claimIds: string[] }[]).find(
      (item) => item.id === created.id,
    );

    // 검토 범위는 snapshot 해시가 아니라 목록으로 복원된다. 해시는 바뀌었는지만
    // 알려 줄 뿐 무엇이었는지 말하지 못한다.
    expect(found?.claimIds).toEqual([claimId]);
  });

  it("다른 tenant의 case는 목록에 나타나지 않는다", async () => {
    await createCase();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/verification-cases`,
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });

    // 권한 오류가 아니라 빈 목록이다. tenant B에게 projectA는 존재하지 않는다.
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("배정 범위는 사후에 바꿀 수 없다", async () => {
    const created = await createCase();

    // 범위를 고칠 수 있으면 "서명이 덮은 근거"가 나중에 달라진다. 권한으로
    // 막는 것이 아니라 mpc_app에 UPDATE·DELETE를 주지 않는다(0011).
    await expect(
      fx.appSql`
        DELETE FROM core.verification_case_claims WHERE case_id = ${created.id}
      `,
    ).rejects.toThrow(/접근 권한|permission denied/i);
  });

  describe("case 상태 전이", () => {
    function transition(caseId: string, version: unknown, body: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: `/api/v1/verification-cases/${caseId}/transitions`,
        headers: {
          authorization: `Bearer ${stewardToken}`,
          "idempotency-key": idempotencyKey(),
          ...(version === undefined ? {} : { "if-match": String(version) }),
        },
        payload: body,
      });
    }

    it("보완 요청을 이유와 함께 기록한다", async () => {
      const created = await createCase();

      const response = await transition(created.id, '"1"', {
        toState: "changes_requested",
        reason: "등록부 조회의 기준일이 없다",
      });

      // assigned → in_review → changes_requested 순서다. assigned에서 바로
      // changes_requested로 갈 수 없다.
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("INVALID_STATE_TRANSITION");
      // 다음에 무엇을 할 수 있는지 알려준다. 막기만 하면 사용자는 추측한다.
      expect(response.json().details.allowedTransitions).toContain("in_review");
    });

    it("허용된 전이는 이력과 함께 기록된다", async () => {
      const created = await createCase();

      const toReview = await transition(created.id, '"1"', {
        toState: "in_review",
        reason: "검토를 시작한다",
      });
      expect(toReview.statusCode).toBe(200);
      expect(toReview.json().version).toBe(2);

      const changes = await transition(created.id, '"2"', {
        toState: "changes_requested",
        reason: "등록부 조회의 기준일이 없다",
      });
      expect(changes.statusCode).toBe(200);

      const list = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/verification-cases`,
        headers: { authorization: `Bearer ${stewardToken}` },
      });
      const found = (list.json().items as { id: string; transitions: unknown[] }[]).find(
        (item) => item.id === created.id,
      );

      // 지나온 경로를 감추지 않는다. 되돌아가도 이력은 남는다.
      expect(found?.transitions).toHaveLength(2);
      expect((found!.transitions[1] as { reason: string }).reason).toContain("기준일");
    });

    it("이유 없이 상태를 바꿀 수 없다", async () => {
      const created = await createCase();
      const response = await transition(created.id, '"1"', { toState: "in_review", reason: "" });
      expect(response.statusCode).toBe(400);
    });

    it("If-Match 없이는 거절한다", async () => {
      const created = await createCase();
      const response = await transition(created.id, undefined, {
        toState: "in_review",
        reason: "검토 시작",
      });
      expect(response.statusCode).toBe(428);
    });

    it("낡은 버전으로 보내면 412다", async () => {
      const created = await createCase();
      await transition(created.id, '"1"', { toState: "in_review", reason: "시작" });

      const stale = await transition(created.id, '"1"', {
        toState: "changes_requested",
        reason: "보완",
      });
      expect(stale.statusCode).toBe(412);
    });
  });

  describe("attestation 이의 제기", () => {
    async function signOne() {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();
      const signatureRequest = (await requestSignature(draft.id)).json();
      const signature = await signTypedData(signatureRequest.typedData);
      await submitSignature(draft.id, {
        signatureRequestId: signatureRequest.signatureRequestId,
        signature,
      });
      return draft.id as string;
    }

    function dispute(attestationId: string, body: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: `/api/v1/attestations/${attestationId}/disputes`,
        headers: {
          authorization: `Bearer ${stewardToken}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: body,
      });
    }

    it("이의를 제기해도 서명 본문은 그대로다", async () => {
      const attestationId = await signOne();

      const [before] = await fx.sql<{ payload_hash: string; signature: string }[]>`
        SELECT payload_hash, signature FROM core.verification_attestations
        WHERE id = ${attestationId}
      `;

      const response = await dispute(attestationId, {
        reasonCode: "EVIDENCE_QUESTIONED",
        detail: "등록부 조회의 기준일이 불명확하다",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("disputed");

      const [after] = await fx.sql<{ payload_hash: string; signature: string; state: string }[]>`
        SELECT payload_hash, signature, state FROM core.verification_attestations
        WHERE id = ${attestationId}
      `;

      // 서명을 삭제하면 "누가 무엇을 언제 판단했는가"를 잃는다. 상태만 바뀐다.
      expect(after!.payload_hash).toBe(before!.payload_hash);
      expect(after!.signature).toBe(before!.signature);
      expect(after!.state).toBe("disputed");
    });

    it("이의 내용이 기록으로 남는다", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, {
        reasonCode: "SCOPE_MISMATCH",
        detail: "검토 범위와 claim이 어긋난다",
      });

      const rows = await fx.sql<{ reason_code: string; detail: string }[]>`
        SELECT reason_code, detail FROM core.attestation_disputes
        WHERE attestation_id = ${attestationId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason_code).toBe("SCOPE_MISMATCH");
    });

    it("사유 없는 이의는 거절한다", async () => {
      const attestationId = await signOne();
      const response = await dispute(attestationId, { reasonCode: "X", detail: "" });
      expect(response.statusCode).toBe(400);
    });

    function resolve(disputeId: string, body: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: `/api/v1/disputes/${disputeId}/resolution`,
        headers: {
          authorization: `Bearer ${stewardToken}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: body,
      });
    }

    async function disputeOf(attestationId: string) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/attestations/${attestationId}/disputes`,
        headers: { authorization: `Bearer ${stewardToken}` },
      });
      return response.json().items as { id: string; resolvedAt: string | null }[];
    }

    it("기각하면 검토가 다시 유효해진다", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "확인 요청" });
      const [raised] = await disputeOf(attestationId);

      const response = await resolve(raised!.id, {
        outcome: "dismissed",
        resolution: "확인 결과 문제없다",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().attestationState).toBe("active");
    });

    it("인정해도 검토를 유효로 되돌리지 않는다", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "근거가 틀렸다" });
      const [raised] = await disputeOf(attestationId);

      const response = await resolve(raised!.id, {
        outcome: "upheld",
        resolution: "지적이 맞다",
      });

      // 틀렸다고 확인된 검토를 유효로 표시할 수 없다. supersede·revoke는 별도
      // 결정이다.
      expect(response.json().attestationState).toBe("disputed");
    });

    it("남은 이의가 있으면 기각해도 disputed로 남는다", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "A", detail: "첫 번째" });
      await dispute(attestationId, { reasonCode: "B", detail: "두 번째" });
      const raised = await disputeOf(attestationId);

      const response = await resolve(raised[0]!.id, {
        outcome: "dismissed",
        resolution: "이건 문제없다",
      });
      expect(response.json().attestationState).toBe("disputed");
      expect(response.json().unresolvedDisputes).toBe(1);
    });

    it("해소돼도 이의 기록은 남는다", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "확인 요청" });
      const [raised] = await disputeOf(attestationId);
      await resolve(raised!.id, { outcome: "dismissed", resolution: "문제없다" });

      const after = await disputeOf(attestationId);
      // 지우면 "한 번 문제가 제기됐다"는 사실이 사라진다.
      expect(after).toHaveLength(1);
      expect(after[0]!.resolvedAt).not.toBeNull();
    });

    it("근거 없이 해소할 수 없다", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "확인 요청" });
      const [raised] = await disputeOf(attestationId);

      const response = await resolve(raised!.id, { outcome: "dismissed", resolution: "" });
      expect(response.statusCode).toBe(400);
    });

    it("이미 해소된 이의를 다시 해소할 수 없다", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "확인 요청" });
      const [raised] = await disputeOf(attestationId);
      await resolve(raised!.id, { outcome: "dismissed", resolution: "문제없다" });

      const again = await resolve(raised!.id, { outcome: "upheld", resolution: "번복" });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("DISPUTE_ALREADY_RESOLVED");
    });

    it("서명 전 초안에는 이의를 제기할 수 없다", async () => {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();

      // draft → disputed는 상태기계에 없다. 서명되지 않은 것에 이의는 성립하지 않는다.
      const response = await dispute(draft.id, { reasonCode: "X", detail: "아직 서명 전" });
      expect(response.statusCode).toBe(409);
    });
  });

  it("AC-01: limitations 없이 초안을 만들 수 없다", async () => {
    const created = await createCase();
    const response = await draftAttestation(created.id, created.assignmentId, {
      limitations: "",
    });
    expect(response.statusCode).toBe(400);
  });

  it("AC-01: 공백만 있는 limitations도 거절한다", async () => {
    const created = await createCase();
    const response = await draftAttestation(created.id, created.assignmentId, {
      limitations: "   ",
    });
    expect([400, 422]).toContain(response.statusCode);
  });

  it("정상 서명 흐름이 관통한다", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    expect(draft.state).toBe("draft");

    const signatureRequest = (await requestSignature(draft.id)).json();
    expect(signatureRequest.humanReadablePayload).toContain("검토의 범위와 한계");
    expect(signatureRequest.humanReadablePayload).toContain("보증하지 않습니다");

    const signature = await signTypedData(signatureRequest.typedData);
    const submitted = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().state).toBe("signed");
    expect(submitted.json().signerWalletAddress).toBe(reviewerAccount.address.toLowerCase());
  });

  it("서명 요청은 한 번만 쓸 수 있다", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData);

    const first = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });
    expect(first.statusCode).toBe(200);

    const replay = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe("SIGNATURE_REQUEST_UNUSABLE");
  });

  it("다른 사람의 서명을 거절한다", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData, outsiderAccount);

    const response = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("SIGNATURE_SIGNER_MISMATCH");
  });

  it("evidence가 바뀌면 서명 요청이 무효가 된다", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();

    // 요청 이후 근거를 바꾼다.
    await fx.sql`
      UPDATE core.verification_cases
      SET evidence_snapshot_hash = ${"0x" + "ff".repeat(32)}
      WHERE id = ${created.id}
    `;

    const signature = await signTypedData(signatureRequest.typedData);
    const response = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("EVIDENCE_SNAPSHOT_CHANGED");
  });

  it("서명 후 본문을 수정할 수 없다", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData);
    await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    await expect(
      fx.sql`
        UPDATE core.verification_attestations SET limitations = '수정됨' WHERE id = ${draft.id}
      `,
    ).rejects.toThrow(/수정할 수 없다/);
  });

  it("서명된 attestation에 다시 서명 요청을 만들 수 없다", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData);
    await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    const again = await requestSignature(draft.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("ATTESTATION_ALREADY_SIGNED");
  });

  it("미해결 이해상충이 있으면 초안을 만들 수 없다", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectId: fx.projectA,
        schemaId: fx.schemaA,
        claimIds: [claimId],
        reviewerSubjectId: fx.reviewerSubjectA,
        credentialId: fx.credentialA,
        conflictStatus: "unresolved",
      },
    });
    const created = response.json();

    const draft = await draftAttestation(created.id, created.assignmentId);
    expect(draft.statusCode).toBe(403);
  });

  it("검토자가 아니면 초안을 만들 수 없다", async () => {
    const created = await createCase();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/verification-cases/${created.id}/attestations`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        assignmentId: created.assignmentId,
        attestationType: "professional_signoff",
        claimScope: [claimId],
        limitations: "범위 제한",
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("남의 배정으로는 초안을 만들 수 없다", async () => {
    /**
     * 역할 검사로는 막히지 않는 경로다 — 같은 tenant의 검토자는 모두 같은
     * 역할을 갖는다. 배정 주체를 대조하지 않으면 남의 이름으로 findings가 남는다.
     */
    const created = await createCase();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/verification-cases/${created.id}/attestations`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        assignmentId: created.assignmentId,
        attestationType: "professional_signoff",
        claimScope: [claimId],
        findings: [{ note: "남의 배정" }],
        citations: [{ source: "registry-extract" }],
        limitations: "범위 제한",
      },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe("ASSIGNMENT_NOT_OWNED");
  });

  it("서명이 audit과 outbox를 남긴다", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData);
    await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    const audits = await fx.sql<{ command: string }[]>`
      SELECT command FROM audit.events WHERE resource_id = ${draft.id} ORDER BY id
    `;
    expect(audits.map((row) => row.command)).toContain("verification.case.signed");

    const events = await fx.sql<{ event_type: string }[]>`
      SELECT event_type FROM core.outbox WHERE aggregate_id = ${draft.id}
    `;
    expect(events.map((row) => row.event_type)).toContain("verification_attestation.signed");
  });
});
