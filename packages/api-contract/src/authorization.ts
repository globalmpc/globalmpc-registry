import { satisfiesAssurance, ROLE_MINIMUM_ASSURANCE, type AssuranceLevel } from "./auth.js";

/**
 * Authorization 결정 — spec 02 §2.1의 접근 결정식을 코드로 옮긴다.
 *
 *   allow = role_action_allowed
 *        AND tenant_scope_matches
 *        AND project_scope_matches
 *        AND sensitivity_clearance_sufficient
 *        AND credential_or_assignment_valid_if_required
 *        AND resource_state_allows_action
 *        AND no_conflict_or_separation_violation
 *
 * 7개 조건을 순서대로 평가하고 **최초 실패 이유를 보존**한다. §11.7이
 * "Permission: 필요한 role과 access request 경로"를 요구하므로 거절 이유가
 * UI까지 전달돼야 한다. 단순 boolean을 반환하면 사용자는 무엇을 해야 할지 모른다.
 */

export type DenyReason =
  | "ROLE_ACTION_NOT_ALLOWED"
  | "ASSURANCE_LEVEL_INSUFFICIENT"
  | "TENANT_SCOPE_MISMATCH"
  | "PROJECT_SCOPE_MISMATCH"
  | "SENSITIVITY_CLEARANCE_INSUFFICIENT"
  | "CREDENTIAL_OR_ASSIGNMENT_INVALID"
  | "RESOURCE_STATE_FORBIDS_ACTION"
  | "CONFLICT_OR_SEPARATION_VIOLATION";

/**
 * 이 역할 바인딩이 닿는 프로젝트.
 *
 * `"all"`은 tenant 전체다 — `TENANT_WIDE_ROLES`의 조직 수준 바인딩만 여기에
 * 해당한다. 배열은 닿는 프로젝트 목록이다. 프로젝트 수준 바인딩은 그 프로젝트,
 * 프로젝트 당사자 역할의 조직 수준 바인딩은 **그 조직이 소유한 프로젝트**다.
 *
 * 둘을 하나의 배열로 합치지 않는다. 빈 배열이 "제한 없음"과 "아무 프로젝트도
 * 없음" 둘 다로 읽히면, 바인딩을 잘못 만든 계정이 전체 접근으로 떨어진다.
 */
export type ProjectScope = "all" | readonly string[];

/**
 * 조직 수준 바인딩이 tenant 전체에 닿는 역할 — 02 §2.2.
 *
 * 이 역할들은 프로젝트를 소유하는 쪽이 아니다. 운영(`mpc_operator` 등)은 tenant를
 * 돌리고, 검토자·gate 승인자·ERSP는 **다른 회사의 프로젝트**를 맡으며(§2.4 규칙 2),
 * 투표·공개 조회는 소유와 무관하다. 이들의 개별 행위는 assignment·credential·
 * 민감도 조건이 따로 막는다.
 *
 * **여기 없는 역할은 소유 조직으로 좁혀진다.** 새 역할을 추가하고 이 목록을 잊으면
 * 넓어지는 것이 아니라 좁아진다 — 조용한 과잉 허용보다 눈에 띄는 403이 낫다.
 * 현재 좁혀지는 역할: project_admin, data_steward, project_sponsor_operator,
 * spv_representative, issuer_officer, project_proposer, execution_recorder.
 */
export const TENANT_WIDE_ROLES: readonly string[] = [
  "public_reader",
  "mpc_operator",
  "security_operator",
  "auditor",
  "scan_service",
  "treasury_signer",
  "gate_approver",
  "protocol_proposer",
  "protocol_voter",
  "project_voter",
  "external_regulated_service_provider",
  "reviewer_cp_qp",
  "reviewer_lab",
  "reviewer_legal",
  "reviewer_assurance",
];

/**
 * 거절이 가리키는 화면.
 *
 * **여기 있는 경로에는 실제 화면이 있어야 한다.** 없으면 "권한을 요청하라"는
 * 안내를 따라간 사용자가 404를 만난다 — 막힌 것보다 나쁘다. 막힌 것은 이유를
 * 알지만 404는 자기가 뭘 잘못했는지도 알 수 없다.
 *
 * 경로를 늘리면 `apps/web/src/app/w/…`에 화면을 함께 만들고,
 * `apps/web/e2e/access-request-paths.spec.ts`가 그 셋을 실제로 연다.
 */
export const ACCESS_REQUEST_PATHS = {
  /** 신원 확인 수준 부족. */
  assurance: "/w/identity/upgrade",
  /** 역할 부족 — 프로젝트 범위 밖. */
  role: "/w/access-requests",
  /** 역할·범위 부족 — 특정 프로젝트. */
  project: (projectId: string): string => `/w/projects/${projectId}/access-requests`,
} as const;

export interface AuthorizationContext {
  readonly role: string;
  readonly assuranceLevel: AssuranceLevel;
  readonly actorTenantId: string;
  readonly actorProjectIds: ProjectScope;
  readonly sensitivityClearance: readonly string[];
  readonly hasRequiredCredential: boolean;
  readonly hasRequiredAssignment: boolean;
  readonly conflictStatus: "none" | "disclosed_resolved" | "unresolved";
}

export interface ResourceContext {
  readonly tenantId: string;
  readonly projectId: string | null;
  readonly sensitivity: string;
  readonly state: string;
  /** 이 action이 허용되는 resource state 목록. */
  readonly statesAllowingAction: readonly string[];
  readonly requiresCredential: boolean;
  readonly requiresAssignment: boolean;
  /** 이 action이 이해상충 분리 규칙의 대상인가(02 §2.4). */
  readonly separationSensitive: boolean;
}

export interface ActionPolicy {
  readonly action: string;
  readonly allowedRoles: readonly string[];
}

export type AuthorizationDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: DenyReason;
      readonly requiredRoles?: readonly string[];
      readonly requiredAssurance?: AssuranceLevel;
      readonly accessRequestPath?: string;
    };

export function authorize(
  policy: ActionPolicy,
  actor: AuthorizationContext,
  resource: ResourceContext,
): AuthorizationDecision {
  if (!policy.allowedRoles.includes(actor.role)) {
    return {
      allow: false,
      reason: "ROLE_ACTION_NOT_ALLOWED",
      requiredRoles: policy.allowedRoles,
      accessRequestPath: resource.projectId
        ? ACCESS_REQUEST_PATHS.project(resource.projectId)
        : ACCESS_REQUEST_PATHS.role,
    };
  }

  const requiredAssurance = ROLE_MINIMUM_ASSURANCE[actor.role] ?? "high_assurance";
  if (!satisfiesAssurance(actor.assuranceLevel, requiredAssurance)) {
    return {
      allow: false,
      reason: "ASSURANCE_LEVEL_INSUFFICIENT",
      requiredAssurance,
      accessRequestPath: ACCESS_REQUEST_PATHS.assurance,
    };
  }

  if (actor.actorTenantId !== resource.tenantId) {
    return { allow: false, reason: "TENANT_SCOPE_MISMATCH" };
  }

  if (
    resource.projectId !== null &&
    actor.actorProjectIds !== "all" &&
    !actor.actorProjectIds.includes(resource.projectId)
  ) {
    return {
      allow: false,
      reason: "PROJECT_SCOPE_MISMATCH",
      accessRequestPath: ACCESS_REQUEST_PATHS.project(resource.projectId),
    };
  }

  if (!actor.sensitivityClearance.includes(resource.sensitivity)) {
    return { allow: false, reason: "SENSITIVITY_CLEARANCE_INSUFFICIENT" };
  }

  if (resource.requiresCredential && !actor.hasRequiredCredential) {
    return { allow: false, reason: "CREDENTIAL_OR_ASSIGNMENT_INVALID" };
  }

  if (resource.requiresAssignment && !actor.hasRequiredAssignment) {
    return { allow: false, reason: "CREDENTIAL_OR_ASSIGNMENT_INVALID" };
  }

  if (!resource.statesAllowingAction.includes(resource.state)) {
    return { allow: false, reason: "RESOURCE_STATE_FORBIDS_ACTION" };
  }

  if (resource.separationSensitive && actor.conflictStatus === "unresolved") {
    return { allow: false, reason: "CONFLICT_OR_SEPARATION_VIOLATION" };
  }

  return { allow: true };
}

/**
 * 워크스페이스 자료를 읽을 수 있는 역할 — 02 §2.1·§2.3.
 *
 * **`public_reader`가 없다.** wallet 서명만으로 부여되는 것은 public read와
 * governance 참여뿐이며(02 §2.9), 워크스페이스의 증빙·검토·준비도는 public이
 * 아니다. tenant에 wallet이 묶여 있다는 사실은 역할이 아니다 — 그것을 읽기
 * 권한으로 취급하면 RLS의 tenant 경계가 곧 인가가 된다.
 */
const WORKSPACE_READERS = [
  "mpc_operator",
  "security_operator",
  "auditor",
  "project_admin",
  "project_sponsor_operator",
  "spv_representative",
  "data_steward",
  "gate_approver",
  "issuer_officer",
  "execution_recorder",
  "external_regulated_service_provider",
  "reviewer_cp_qp",
  "reviewer_lab",
  "reviewer_legal",
  "reviewer_assurance",
] as const;

/** 거버넌스는 보유에서 나오므로 투표자·제안자까지 읽을 수 있다(04 §4.5). */
const GOVERNANCE_READERS = [
  ...WORKSPACE_READERS,
  "protocol_voter",
  "project_voter",
  "protocol_proposer",
  "project_proposer",
] as const;

/**
 * action별 허용 역할 — 02 §2.3 권한표.
 *
 * `readiness.override`가 없는 것이 의도다. 어떤 역할도 readiness 결과를
 * 수정할 수 없으므로 action 자체가 존재하지 않는다(REQ-DAPP-017).
 */
export const ACTION_POLICIES: Readonly<Record<string, ActionPolicy>> = {
  /**
   * 읽기 action — 02 §2.1.
   *
   * 읽기에도 결정식을 적용한다. 쓰기만 검사하면 tenant 안에서 역할·프로젝트
   * 경계가 조회로 무너진다. RLS는 tenant 경계만 강제한다(0002_rls.sql).
   */
  "project.read": { action: "project.read", allowedRoles: WORKSPACE_READERS },
  "evidence.read": {
    action: "evidence.read",
    // 검사 서비스는 격리된 업로드를 봐야 결과를 보고할 수 있다.
    allowedRoles: [...WORKSPACE_READERS, "scan_service"],
  },
  "verification.read": { action: "verification.read", allowedRoles: WORKSPACE_READERS },
  "readiness.read": { action: "readiness.read", allowedRoles: WORKSPACE_READERS },
  "registry.read": { action: "registry.read", allowedRoles: WORKSPACE_READERS },
  "authority.read": { action: "authority.read", allowedRoles: WORKSPACE_READERS },
  "governance.read": { action: "governance.read", allowedRoles: GOVERNANCE_READERS },

  "project.create": {
    action: "project.create",
    allowedRoles: ["mpc_operator", "project_admin", "project_sponsor_operator"],
  },
  "source.upload": {
    action: "source.upload",
    allowedRoles: [
      "data_steward",
      "project_admin",
      "project_sponsor_operator",
      "spv_representative",
    ],
  },
  /**
   * 검사 결과 기록 — 05 §5.2.
   *
   * `source.upload`를 재사용하지 않는다. 그 권한은 파일을 올리는 사람의 것이고,
   * 검사 결과를 만드는 것은 다른 행위다. 같은 권한으로 두면 **올린 사람이 자기
   * 파일을 통과시킬 수 있고** quarantine이 형식만 남는다.
   *
   * `scan_service`만 갖는다. 사람 역할은 하나도 포함하지 않는다.
   */
  "upload.scan_result": {
    action: "upload.scan_result",
    allowedRoles: ["scan_service"],
  },
  /**
   * Authority 후보 등록·갱신 — 02 §2.8.
   *
   * Trust Registry 운영자의 일이다. 이 권한으로는 `accepted`로 올릴 수 없다 —
   * 상태 전환은 `authority.review`이고 두 권한을 한 사람이 동시에 갖더라도
   * 라우트가 **등록자와 승인자가 같은지**를 따로 본다.
   */
  "authority.register": {
    action: "authority.register",
    allowedRoles: ["mpc_operator"],
  },
  /**
   * Authority 상태 전환 — 02 §2.8.
   *
   * **`mpc_operator`가 없다.** "운영자 단독 `accepted` 전환"이 §2.8이 명시적으로
   * 금지하는 것이고, 운영자를 여기 넣으면 등록과 승인이 같은 권한이 된다.
   *
   * 독립 reviewer와 auditor가 판단한다. 기관을 신뢰하기로 하는 것은 운영
   * 작업이 아니라 검토 결과다.
   */
  "authority.review": {
    action: "authority.review",
    allowedRoles: ["reviewer_legal", "reviewer_assurance", "auditor"],
  },
  /**
   * 연동 구성 — 02 §2.8.
   *
   * Source Connection Admin의 일이며 보안 검토가 따라붙는다. 연동을 켜는 것이
   * 기관 승인이 되지 않게 하는 것은 DB 트리거가 맡는다 — 권한만으로는 막을 수
   * 없다. 두 권한을 다 가진 사람이 있을 수 있기 때문이다.
   */
  "connection.configure": {
    action: "connection.configure",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  /**
   * 공식 출처 조회 — 05 §5.12, OD-42.
   *
   * `source.upload`를 재사용하지 않는다. 그 권한은 **자기가 가진 파일을 올리는**
   * 것이고, 이것은 **기관 자격증명으로 외부에 요청을 보내는** 것이다. 같은
   * 권한으로 두면 파일을 올릴 수 있는 사람이 전부 기관 API 호출자가 된다.
   *
   * 프로젝트 측 역할(`project_admin`·`spv_representative`)을 넣지 않는다.
   * 자기 프로젝트에 대한 등록부 조회를 자기가 실행하면, 언제 조회했는지를
   * 고르는 것으로 결과를 고를 수 있다.
   */
  "source.collect": {
    action: "source.collect",
    allowedRoles: ["data_steward", "mpc_operator"],
  },
  "claim.curate": {
    action: "claim.curate",
    allowedRoles: ["data_steward"],
  },
  /**
   * 이의 제기 — 04 §4.2.
   *
   * `claim.curate`(data_steward 전용)를 재사용하지 않는다. 문제를 발견하는 사람과
   * 근거를 관리하는 사람은 다를 수 있고, 서명한 검토자 본인이 나중에 문제를
   * 알아차리는 경우가 가장 흔하다. 그때 막으면 잘못이 조용히 남는다.
   *
   * 이의는 판정이 아니라 "다시 볼 필요가 있다"는 표시이므로 넓게 연다.
   */
  "attestation.dispute": {
    action: "attestation.dispute",
    allowedRoles: [
      "data_steward",
      "reviewer_cp_qp",
      "reviewer_lab",
      "reviewer_legal",
      "reviewer_assurance",
      "auditor",
      "mpc_operator",
      "project_admin",
    ],
  },
  "attestation.sign": {
    action: "attestation.sign",
    allowedRoles: ["reviewer_cp_qp", "reviewer_lab", "reviewer_legal", "reviewer_assurance"],
  },
  "readiness.recompute": {
    action: "readiness.recompute",
    allowedRoles: ["mpc_operator", "data_steward", "gate_approver"],
  },
  "gate.decide": {
    action: "gate.decide",
    allowedRoles: ["gate_approver"],
  },
  "registry.publish": {
    action: "registry.publish",
    allowedRoles: ["mpc_operator"],
  },
  "registry.revoke": {
    action: "registry.revoke",
    allowedRoles: ["mpc_operator"],
  },
  "anchor.submit": {
    action: "anchor.submit",
    allowedRoles: ["mpc_operator"],
  },
  "disclosure.restrict": {
    action: "disclosure.restrict",
    allowedRoles: ["issuer_officer", "mpc_operator"],
  },
  /**
   * 제안 생성과 상태 전이 — 04 §4.5.
   *
   * `protocol_proposer`·`project_proposer`는 identity_bound가 필요하다. 익명
   * 지갑이 거버넌스 절차를 시작할 수 없다.
   */
  "governance.propose": {
    action: "governance.propose",
    allowedRoles: ["protocol_proposer", "project_proposer", "mpc_operator"],
  },
  /**
   * 투표.
   *
   * `wallet_only`로 충분하다 — 투표권은 보유에서 나오지 신원에서 나오지 않는다.
   * 대신 투표는 오프체인 사실을 만들지 못한다(불변조건 12).
   */
  "governance.vote": {
    action: "governance.vote",
    allowedRoles: ["protocol_voter", "project_voter", "mpc_operator"],
  },
  "audit.read": {
    action: "audit.read",
    allowedRoles: ["auditor", "security_operator", "mpc_operator"],
  },

  /**
   * 플랫폼 관리 — 02 §2.8.
   *
   * 역할 부여를 화면·API로 올리면 **역할을 부여하는 역할**이 새로 생긴다. 그
   * 역할 하나가 자기 자신에게 무엇이든 줄 수 있으면 아래의 표 전체가 의미를
   * 잃는다. 그래서 제안과 승인을 **다른 action으로 나누고**, 같은 사람이 둘 다
   * 하는 것을 DB가 막는다(`role_grant_two_person`).
   *
   * 두 action의 허용 역할이 같은 것은 의도다. 분리해야 하는 것은 역할이 아니라
   * **사람**이다 — 역할로 나누면 승인자 역할을 가진 사람이 하나뿐인 배포에서
   * 그 한 사람이 모든 것을 승인하게 되고, 그것은 2인 원칙이 아니다.
   */
  "admin.read": {
    action: "admin.read",
    allowedRoles: ["mpc_operator", "security_operator", "auditor"],
  },
  "admin.subject.manage": {
    action: "admin.subject.manage",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  /**
   * 지갑 비활성·재바인딩 — AC-27.
   *
   * 분실한 키를 끊는 것은 **급한 일**이다. 2인을 요구하면 침해된 키가 두 번째
   * 사람을 기다리는 동안 살아 있다. 그래서 이쪽은 1인으로 두고, 대신 사유와
   * 실행자를 남긴다(`wallet_disable_events`). 되돌리는 것 — 새 키를 붙이는 것 —
   * 도 같은 action이며 같은 이유로 즉시 가능하다.
   */
  "admin.wallet.manage": {
    action: "admin.wallet.manage",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  "admin.role.propose": {
    action: "admin.role.propose",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  "admin.role.approve": {
    action: "admin.role.approve",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  /**
   * 알림 수신처 관리.
   *
   * 수신 URL은 tenant의 것이지 사람의 것이 아니므로 개인정보가 아니다. 그래도
   * 관리 권한을 따로 두는 이유: 수신처를 바꾸면 **알림이 다른 곳으로 간다.**
   * 조용히 바꿔 두면 원래 받던 쪽은 알림이 끊긴 것을 모른다.
   */
  "admin.notification.manage": {
    action: "admin.notification.manage",
    allowedRoles: ["mpc_operator", "security_operator"],
  },

  /**
   * project lifecycle 전이 — 04 §4.3.
   *
   * **내리는 것과 올리는 것을 나눈다.** suspension은 급한 일이라 1인이 한다 —
   * 2인을 요구하면 두 번째 사람을 기다리는 동안 문제가 있는 프로젝트가 계속
   * 돈다(지갑 비활성과 같은 논리). 반대로 앞으로 나아가는 전이는 급하지 않으며
   * 되돌리기 어렵다.
   *
   * 복귀는 `advance`이면서 추가로 **멈춘 사람이 할 수 없다.** 같은 사람이 멈추고
   * 되돌리면 suspension이 통제가 아니라 개인의 재량이 된다.
   */
  "project.lifecycle.suspend": {
    action: "project.lifecycle.suspend",
    allowedRoles: ["mpc_operator", "security_operator", "issuer_officer"],
  },
  "project.lifecycle.advance": {
    action: "project.lifecycle.advance",
    // gate 판정과 발행 결정을 하는 손이 이 전이를 한다. 운영자 단독으로
    // offering을 열 수 없다.
    allowedRoles: ["issuer_officer", "gate_approver"],
  },
};
