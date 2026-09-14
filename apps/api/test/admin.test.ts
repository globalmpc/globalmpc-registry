import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { TestAccount } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 플랫폼 관리 — 역할 부여의 2인 원칙과 key recovery(AC-27).
 *
 * 이 파일이 지키는 것은 셋이다.
 *
 * 1. **bootstrap CLI 없이 사람을 추가할 수 있다.**
 * 2. **한 사람이 역할을 혼자 줄 수 없다** — 제안과 승인이 갈린다(02 §2.8).
 * 3. **분실한 키를 끊고 새 키를 붙일 수 있고, 끊는 즉시 그 키로는 못 들어온다**(AC-27).
 */
/** 서명 가능한 임시 계정. `helpers/db.ts`의 것과 같은 모양이다. */
function newAccount(): TestAccount {
  const account = privateKeyToAccount(generatePrivateKey());
  return { address: account.address.toLowerCase() as `0x${string}`, account };
}

describeDb("플랫폼 관리", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  /** 둘 다 mpc_operator다. 2인 원칙이 역할이 아니라 사람으로 갈리는지 본다. */
  let operatorAToken: string;
  let operatorBToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorAToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);

    // operatorB는 tenant B다. 같은 tenant의 두 번째 admin이 필요하므로
    // tenant A에 하나 더 만든다 — 이 준비 자체가 운영 화면이 없으면 CLI로만
    // 가능했던 일이다.
    const second = newAccount();
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', 'Operator Second')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${second.address},
        97, 'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, 'mpc_operator')
    `;
    operatorBToken = await signIn(app, second);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function post(token: string, url: string, payload: unknown, ifMatch?: string) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        ...(ifMatch ? { "if-match": ifMatch } : {}),
      },
      payload: payload as never,
    });
  }

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  it("bootstrap CLI 없이 주체를 만든다", async () => {
    const response = await post(operatorAToken, "/api/v1/admin/subjects", {
      displayName: `Added by API ${randomUUID().slice(0, 6)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBeTruthy();
    // 지갑이 아직 없다. 역할이 무엇이든 로그인할 수 없는 상태를 화면이 먼저
    // 말해야 한다.
    expect(response.json().locked).toBe(true);
  });

  it("admin 권한이 없으면 거절한다", async () => {
    const response = await post(stewardToken, "/api/v1/admin/subjects", {
      displayName: "steward가 만들 수 없다",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("mpc_operator");
  });

  it("제안한 사람은 그 제안을 승인할 수 없다", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "권한 대상 A" })
    ).json();

    const grant = (
      await post(operatorAToken, "/api/v1/admin/role-grants", {
        subjectId: subject.id,
        role: "data_steward",
        reason: "증빙 등록을 맡는다",
      })
    ).json();
    expect(grant.state).toBe("pending");

    const self = await post(
      operatorAToken,
      `/api/v1/admin/role-grants/${grant.id}/decision`,
      { decision: "approve", reason: "내가 제안했다" },
      `"${grant.version}"`,
    );

    expect(self.statusCode).toBe(422);
    expect(self.json().code).toBe("ROLE_GRANT_SELF_APPROVAL");
  });

  it("다른 사람이 승인하면 역할이 실제로 붙는다", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "권한 대상 B" })
    ).json();

    const grant = (
      await post(operatorAToken, "/api/v1/admin/role-grants", {
        subjectId: subject.id,
        role: "data_steward",
        reason: "증빙 등록을 맡는다",
      })
    ).json();

    const decided = await post(
      operatorBToken,
      `/api/v1/admin/role-grants/${grant.id}/decision`,
      { decision: "approve", reason: "확인했다" },
      `"${grant.version}"`,
    );

    expect(decided.statusCode).toBe(200);
    expect(decided.json().state).toBe("approved");

    const listed = (await get(operatorAToken, "/api/v1/admin/subjects")).json();
    const target = listed.items.find((item: { id: string }) => item.id === subject.id);
    expect(target.roles.map((role: { role: string }) => role.role)).toContain("data_steward");
  });

  it("권한표에 없는 역할은 제안 단계에서 거절한다", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "권한 대상 C" })
    ).json();

    const response = await post(operatorAToken, "/api/v1/admin/role-grants", {
      subjectId: subject.id,
      role: "god_mode",
      reason: "없는 역할",
    });

    // 승인 시점에 실패하면 승인자가 무엇을 잘못했는지 알 수 없다.
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ROLE_UNKNOWN");
  });

  it("같은 대상에 대기 중인 제안을 둘 두지 않는다", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "권한 대상 D" })
    ).json();
    const body = { subjectId: subject.id, role: "auditor", reason: "감사 담당" };

    expect((await post(operatorAToken, "/api/v1/admin/role-grants", body)).statusCode).toBe(200);
    const second = await post(operatorAToken, "/api/v1/admin/role-grants", body);

    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("ROLE_GRANT_ALREADY_PENDING");
  });

  /**
   * AC-27 — key recovery.
   *
   * 이 테스트가 없었고, 그 이전에 **경로 자체가 없었다.** `disabled_at`은 컬럼만
   * 있었다.
   */
  describe("운영자 한 명이 2인 원칙을 우회하지 못한다", () => {
    it("운영 권한을 가진 사람에게는 화면에서 지갑을 붙일 수 없다", async () => {
      // 붙일 수 있으면 운영자 A가 자기 지갑을 운영자 B에게 붙여 B로 로그인하고
      // 자기 제안을 스스로 승인한다.
      const response = await post(
        operatorBToken,
        `/api/v1/admin/subjects/${fx.operatorSubjectA}/wallets`,
        { walletAddress: newAccount().address, chainId: 97, assuranceLevel: "high_assurance" },
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("WALLET_BIND_ADMIN_SUBJECT");
    });

    it("자기 지갑은 끌 수 없다 — 마지막 운영자가 스스로 사라지지 않는다", async () => {
      const subjects = (await get(operatorAToken, "/api/v1/admin/subjects")).json() as {
        items: { id: string; wallets: { id: string; version: number }[] }[];
      };
      const own = subjects.items.find((subject) => subject.id === fx.operatorSubjectA)!.wallets[0]!;

      const response = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${own.id}/disable`,
        { reasonCode: "key_lost", detail: "스스로 끄기 시도" },
        `"${own.version}"`,
      );

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("WALLET_DISABLE_SELF");
    });
  });

  describe("분실 키 복구 (AC-27)", () => {
    it("끊은 키로는 더 이상 로그인할 수 없고 새 키로는 된다", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "키를 잃은 사람" })
      ).json();

      const lost = newAccount();
      const bound = await post(
        operatorAToken,
        `/api/v1/admin/subjects/${subject.id}/wallets`,
        { walletAddress: lost.address, chainId: 97, assuranceLevel: "identity_bound" },
      );
      expect(bound.statusCode).toBe(200);
      expect(bound.json().locked).toBe(false);

      // 잃기 전에는 로그인된다.
      const before = await signIn(app, lost);
      expect(before).toBeTruthy();

      const wallet = bound.json().wallets[0];
      const disabled = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${wallet.id}/disable`,
        { reasonCode: "key_lost", detail: "노트북과 함께 분실했다고 신고" },
        `"${wallet.version}"`,
      );

      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().wallets[0].disabledAt).not.toBeNull();
      // 붙은 지갑이 전부 비활성이면 로그인할 수 없다 — 그것을 응답이 말한다.
      expect(disabled.json().locked).toBe(true);

      /**
       * 끊은 키로는 **그 주체로서** 행동할 수 없다.
       *
       * SIWE 서명 자체는 여전히 유효하므로 토큰은 발급된다 — 서명은 키가 있음을
       * 증명할 뿐 그 키가 누구인지를 우리가 인정하는지는 별개다. 세션 해석이
       * `disabled_at IS NULL`인 지갑만 주체에 잇는다(0005). 따라서 토큰은 나오되
       * tenant도 역할도 붙지 않는다.
       *
       * "로그인이 실패한다"로 검사하면 이 구분을 놓친다.
       */
      const afterDisable = await signIn(app, lost);
      const orphan = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { authorization: `Bearer ${afterDisable}` },
      });
      expect(orphan.json().tenantId).toBeNull();
      expect(orphan.json().roleBindings ?? []).toEqual([]);

      // 그 토큰으로는 워크스페이스에 아무것도 할 수 없다.
      const denied = await app.inject({
        method: "GET",
        url: "/api/v1/admin/subjects",
        headers: { authorization: `Bearer ${afterDisable}` },
      });
      expect([401, 403]).toContain(denied.statusCode);

      // 새 키를 붙이면 다시 들어온다. 끊는 것만 되고 붙는 것이 안 되면 복구가
      // 아니라 계정 폐기다.
      const replacement = newAccount();
      const rebound = await post(
        operatorAToken,
        `/api/v1/admin/subjects/${subject.id}/wallets`,
        { walletAddress: replacement.address, chainId: 97, assuranceLevel: "identity_bound" },
      );
      expect(rebound.statusCode).toBe(200);
      expect(rebound.json().locked).toBe(false);

      const after = await signIn(app, replacement);
      expect(after).toBeTruthy();
    });

    it("끊은 이유가 기록으로 남는다", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "사유 기록 대상" })
      ).json();
      const key = newAccount();
      const bound = (
        await post(operatorAToken, `/api/v1/admin/subjects/${subject.id}/wallets`, {
          walletAddress: key.address,
          chainId: 97,
          assuranceLevel: "wallet_only",
        })
      ).json();

      await post(
        operatorAToken,
        `/api/v1/admin/wallets/${bound.wallets[0].id}/disable`,
        { reasonCode: "key_compromised", detail: "피싱 신고 접수" },
        `"${bound.wallets[0].version}"`,
      );

      // 분실과 침해와 퇴사는 같은 결과를 내지만 과거 서명을 어떻게 읽어야
      // 하는지가 다르다.
      const [event] = await fx.sql<{ reason_code: string; detail: string }[]>`
        SELECT reason_code, detail FROM core.wallet_disable_events
        WHERE wallet_identity_id = ${bound.wallets[0].id}
      `;
      expect(event!.reason_code).toBe("key_compromised");
      expect(event!.detail).toContain("피싱");
    });

    it("이미 비활성된 지갑을 다시 끊지 않는다", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "중복 비활성 대상" })
      ).json();
      const key = newAccount();
      const bound = (
        await post(operatorAToken, `/api/v1/admin/subjects/${subject.id}/wallets`, {
          walletAddress: key.address,
          chainId: 97,
          assuranceLevel: "wallet_only",
        })
      ).json();
      const wallet = bound.wallets[0];

      await post(
        operatorAToken,
        `/api/v1/admin/wallets/${wallet.id}/disable`,
        { reasonCode: "rotation", detail: "정기 교체" },
        `"${wallet.version}"`,
      );
      const again = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${wallet.id}/disable`,
        { reasonCode: "rotation", detail: "정기 교체" },
        `"${wallet.version + 1}"`,
      );

      expect(again.statusCode).toBe(422);
      expect(again.json().code).toBe("WALLET_ALREADY_DISABLED");
    });

    it("이미 다른 주체에 붙은 주소를 옮기지 않는다", async () => {
      const first = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "주소 보유자" })
      ).json();
      const second = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "주소를 노리는 쪽" })
      ).json();
      const key = newAccount();

      await post(operatorAToken, `/api/v1/admin/subjects/${first.id}/wallets`, {
        walletAddress: key.address,
        chainId: 97,
        assuranceLevel: "wallet_only",
      });

      // 옮기면 그 주소의 과거 서명이 다른 사람의 것으로 읽힌다.
      const moved = await post(operatorAToken, `/api/v1/admin/subjects/${second.id}/wallets`, {
        walletAddress: key.address,
        chainId: 97,
        assuranceLevel: "wallet_only",
      });

      expect(moved.statusCode).toBe(409);
      expect(moved.json().code).toBe("WALLET_ALREADY_BOUND");
    });
  });
});
