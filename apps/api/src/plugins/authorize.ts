import {
  ACTION_POLICIES,
  authorize,
  TENANT_WIDE_ROLES,
  type AuthorizationContext,
  type ProjectScope,
  type ResourceContext,
} from "@mpc/api-contract";
import { badRequest, forbidden } from "../errors.js";
import type { Session } from "./session.js";

/** 세션 밖에서 조회해야 하는 사실. 라우트가 자기 리소스에 맞게 채운다. */
export interface ActorFacts {
  readonly sensitivityClearance: readonly string[];
  readonly hasRequiredCredential: boolean;
  readonly hasRequiredAssignment: boolean;
  readonly conflictStatus: "none" | "disclosed_resolved" | "unresolved";
}

/**
 * assurance level별 민감도 clearance — 02 §2.2, 06 §6.7.
 *
 * 이전에는 라우트마다 `["public","restricted"]`를 상수로 넘겼다. 그러면 세션이
 * 무엇이든 clearance가 같아지고, 결정식의 `sensitivity_clearance_sufficient`가
 * 판정에 관여하지 않는다.
 *
 * `confidential` 이상은 여기서 열지 않는다. 그 등급의 저장 경로 자체가 아직
 * 없고(OD-18, `admitToStorage`), 읽기만 먼저 열면 저장되지 않는 것을 읽을 수
 * 있다고 말하는 것이 된다.
 */
const CLEARANCE_BY_ASSURANCE: Readonly<Record<Session["assuranceLevel"], readonly string[]>> = {
  wallet_only: ["public"],
  identity_bound: ["public", "restricted"],
  high_assurance: ["public", "restricted"],
};

/**
 * 세션만으로 판정할 수 있는 사실.
 *
 * credential·assignment·이해상충은 리소스마다 다르므로 여기서 채우지 않는다.
 * **기본값을 "충족"이 아니라 "요구되지 않음"으로 둔다** — 리소스가
 * `requiresCredential`을 켜면 라우트가 실제 조회 결과를 넘겨야 하고, 넘기지
 * 않으면 통과가 아니라 거절이 된다.
 */
export function sessionFacts(session: Session, overrides: Partial<ActorFacts> = {}): ActorFacts {
  return {
    sensitivityClearance: CLEARANCE_BY_ASSURANCE[session.assuranceLevel],
    hasRequiredCredential: false,
    hasRequiredAssignment: false,
    conflictStatus: "none",
    ...overrides,
  };
}

/** 역할 바인딩 하나. 조직 수준(project_id NULL)이면 그 조직의 전 프로젝트다. */
type Binding = Session["roleBindings"][number];

/**
 * 바인딩이 닿는 프로젝트.
 *
 * 이전에는 조직 수준 바인딩을 모두 `"all"`로 바꿨다. 주석은 "그 조직의 전
 * 프로젝트"였지만 조직을 비교하는 곳이 없어서, 같은 tenant 안의 B사 steward가
 * A사 프로젝트에 업로드할 수 있었다.
 */
function scopeOf(session: Session, binding: Binding): ProjectScope {
  if (binding.projectId !== null) return [binding.projectId];
  if (TENANT_WIDE_ROLES.includes(binding.role)) return "all";
  if (binding.organizationId === null) return [];
  return session.organizationProjectIds?.[binding.organizationId] ?? [];
}

/** 이 action을 허용받는 역할의 바인딩. */
function usableBindings(session: Session, action: string): readonly Binding[] {
  const policy = ACTION_POLICIES[action];
  if (!policy) return [];
  return session.roleBindings.filter((binding) => policy.allowedRoles.includes(binding.role));
}

/** 세션이 이 action의 역할을 하나라도 가졌는가. 목록에 결정 대상을 실을지 정할 때 쓴다. */
export function holdsActionRole(session: Session, action: string): boolean {
  return usableBindings(session, action).length > 0;
}

/**
 * 이 조직의 이름으로 행위할 수 있는가 — 프로젝트 생성의 소유 조직 검사.
 *
 * tenant 운영 역할은 온보딩으로 다른 조직 소유 프로젝트를 등록할 수 있다.
 * 당사자 역할은 자기 조직의 것만 만든다. 그렇지 않으면 B사가 A사 이름으로
 * 프로젝트를 만들어 그 프로젝트의 당사자처럼 보이게 된다.
 */
export function canActForOrganization(
  session: Session,
  action: string,
  organizationId: string,
): boolean {
  return usableBindings(session, action).some(
    (binding) =>
      TENANT_WIDE_ROLES.includes(binding.role) || binding.organizationId === organizationId,
  );
}

export function bindingToAuthorizationContext(
  session: Session,
  binding: Binding,
  facts: ActorFacts,
): AuthorizationContext {
  return {
    role: binding.role,
    assuranceLevel: session.assuranceLevel,
    actorTenantId: session.tenantId ?? "",
    actorProjectIds: scopeOf(session, binding),
    sensitivityClearance: facts.sensitivityClearance,
    hasRequiredCredential: facts.hasRequiredCredential,
    hasRequiredAssignment: facts.hasRequiredAssignment,
    conflictStatus: facts.conflictStatus,
  };
}

/**
 * 이 action으로 닿을 수 있는 프로젝트 — 목록 조회용.
 *
 * 단건 조회는 `assertAuthorized`가 막으면 되지만 목록은 그렇지 않다. 걸러내지
 * 않으면 범위 밖 프로젝트의 이름과 ID가 목록에 실려 나간다. 403을 받지 않았다는
 * 이유로 유출이 아닌 것이 되지 않는다.
 *
 * `"all"`은 tenant 운영 역할의 조직 수준 바인딩이 하나라도 있다는 뜻이다.
 */
export function visibleProjectScope(session: Session, action: string): ProjectScope {
  const scopes = usableBindings(session, action).map((binding) => scopeOf(session, binding));

  if (scopes.some((scope) => scope === "all")) return "all";
  return [...new Set(scopes.flatMap((scope) => scope as readonly string[]))];
}

/**
 * 리소스 컨텍스트의 기본값.
 *
 * 라우트마다 7개 필드를 손으로 적으면 하나를 빠뜨렸을 때 그 라우트만 조용히
 * 다르게 판정된다. 기본값은 전부 **가장 좁은 쪽**이다 — credential·assignment는
 * 요구하지 않음이 아니라, 요구하면 라우트가 명시해야 한다는 뜻이다.
 */
const RESOURCE_DEFAULTS = {
  sensitivity: "restricted",
  state: "active",
  statesAllowingAction: ["active"],
  requiresCredential: false,
  requiresAssignment: false,
  separationSensitive: false,
} as const;

/** tenant 전체에 걸리는 리소스. 프로젝트 경계가 없는 운영 action에만 쓴다. */
export function tenantResource(
  tenantId: string,
  overrides: Partial<Omit<ResourceContext, "tenantId" | "projectId">> = {},
): ResourceContext {
  return { ...RESOURCE_DEFAULTS, ...overrides, tenantId, projectId: null };
}

/** 프로젝트에 매인 리소스. `projectId`를 넘겨야 project scope가 평가된다. */
export function projectResource(
  tenantId: string,
  projectId: string,
  overrides: Partial<Omit<ResourceContext, "tenantId" | "projectId">> = {},
): ResourceContext {
  return { ...RESOURCE_DEFAULTS, ...overrides, tenantId, projectId };
}

/** 역할이 하나도 없는 세션. wallet이 묶여 있다는 사실은 역할이 아니다. */
const PUBLIC_READER: Binding = {
  role: "public_reader",
  organizationId: null,
  projectId: null,
};

/**
 * 서버가 최종 권한을 판정한다 — 02 §2.1.
 *
 * **역할이 아니라 역할 바인딩 단위로 판정한다.** 조직 수준 바인딩은 그 조직의
 * 프로젝트 전체에, 프로젝트 수준 바인딩은 그 프로젝트에만 닿는다. 역할 이름만
 * 보면 프로젝트 A의 검토자가 프로젝트 B에서도 같은 역할로 통과한다.
 *
 * 하나라도 통과하면 허용한다. 전부 실패하면 **가장 마지막 거절 사유**를
 * 반환한다. 사용자가 무엇을 해야 하는지 알아야 하기 때문이다(§11.7).
 *
 * **통과시킨 바인딩의 역할을 반환한다.** 감사 기록의 `effective_role`이 이 값이어야
 * 한다(02 §2.7). 세션의 첫 바인딩을 대신 쓰면, 두 바인딩을 가진 사람이 두 번째
 * 것으로 통과한 행위가 첫 번째 역할로 기록된다. `core.resolve_role_bindings`에는
 * ORDER BY가 없어 그 "첫 번째"가 실행마다 달라질 수도 있다 — 기록이 틀리기만
 * 하는 것이 아니라 재현되지도 않는다.
 */
export function assertAuthorized(
  session: Session,
  action: string,
  resource: ResourceContext,
  facts: ActorFacts,
): string {
  const policy = ACTION_POLICIES[action];
  if (!policy) {
    throw badRequest("ACTION_UNKNOWN", `알 수 없는 action이다: ${action}`);
  }

  const candidates = session.roleBindings.length > 0 ? session.roleBindings : [PUBLIC_READER];

  let lastDenial: ReturnType<typeof authorize> | null = null;

  for (const binding of candidates) {
    const decision = authorize(
      policy,
      bindingToAuthorizationContext(session, binding, facts),
      resource,
    );
    if (decision.allow) return binding.role;
    lastDenial = decision;
  }

  if (lastDenial && !lastDenial.allow) {
    throw forbidden("AUTHORIZATION_DENIED", "이 작업을 수행할 권한이 없다", {
      reason: lastDenial.reason,
      ...(lastDenial.requiredRoles ? { requiredRoles: lastDenial.requiredRoles } : {}),
      ...(lastDenial.requiredAssurance
        ? { requiredAssurance: lastDenial.requiredAssurance }
        : {}),
      ...(lastDenial.accessRequestPath
        ? { accessRequestPath: lastDenial.accessRequestPath }
        : {}),
    });
  }

  throw forbidden("AUTHORIZATION_DENIED", "이 작업을 수행할 권한이 없다");
}
