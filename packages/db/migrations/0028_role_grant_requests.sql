-- 역할 부여의 2인 원칙 — spec 02 §2.8.
--
-- **왜 필요한가:** 역할을 부여하는 유일한 경로가 `apps/api/src/bootstrap.ts`의
-- CLI였다. 즉 배포된 시스템에 사람을 추가하려면 매번 서버에 들어가야 했고, 그
-- 경로는 RLS를 우회하는 superuser 연결로 돈다.
--
-- 이것을 화면·API로 올리면 **역할을 부여하는 역할**이 새로 생긴다. 그 역할 하나가
-- 자기 자신에게 무엇이든 줄 수 있으면 나머지 권한 체계가 의미를 잃는다.
--
-- 02 §2.8은 "운영자 단독 accepted 전환"을 금지하고, 이 저장소는 이미 "등록한
-- 사람은 그 기관을 승인할 수 없다"를 코드로 강제한다. **역할 부여에 같은 규칙을
-- 적용한다** — 제안과 승인을 다른 사람이 한다.
--
-- 최초 1인은 이 표로 만들 수 없다(승인할 사람이 없다). `bootstrap` CLI가 그
-- 자리를 계속 갖는다 — 배포마다 한 번 도는 seed이지 상시 경로가 아니다.

CREATE TYPE core.role_grant_state AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

CREATE TABLE core.role_grant_requests (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants(id),
  -- 누구에게 줄 것인가.
  subject_id              UUID NOT NULL REFERENCES core.subjects(id),
  organization_id         UUID REFERENCES core.organizations(id),
  -- 프로젝트 범위 바인딩이면 채운다. 조직 수준이면 NULL이다.
  project_id              UUID,
  role                    TEXT NOT NULL CHECK (length(btrim(role)) > 0),
  -- 이유 없는 권한 부여는 나중에 판단할 근거가 없다. 제안·결정 양쪽에 요구한다.
  reason                  TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                   core.role_grant_state NOT NULL DEFAULT 'pending',
  decided_by_subject_id   UUID REFERENCES core.subjects(id),
  decided_at              TIMESTAMPTZ,
  decision_reason         TEXT,
  -- 부여가 실제로 만들어진 binding. 승인 이후에만 채워진다.
  role_binding_id         UUID REFERENCES core.role_bindings(id),
  version                 INTEGER NOT NULL DEFAULT 1,

  /**
   * 2인 원칙 — DB가 강제한다.
   *
   * 애플리케이션에서만 막으면 route가 하나 늘 때마다 다시 확인해야 한다. 여기에
   * 두면 어떤 경로로 들어와도 같은 사람이 제안하고 승인할 수 없다.
   */
  CONSTRAINT role_grant_two_person CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> requested_by_subject_id
  ),
  CONSTRAINT role_grant_decision_shape CHECK (
    (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL)
    OR (state = 'withdrawn' AND decided_at IS NOT NULL)
    OR (state IN ('approved', 'rejected') AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT role_grant_binding_shape CHECK (
    role_binding_id IS NULL OR state = 'approved'
  ),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

CREATE INDEX role_grant_requests_pending_idx
  ON core.role_grant_requests (tenant_id, state, requested_at DESC);

/**
 * 같은 대상에 대한 pending 제안은 하나만 둔다.
 *
 * 둘이 열려 있으면 승인자가 어느 것을 승인했는지가 이력에서 흐려지고, 둘 다
 * 승인되면 같은 binding이 두 번 만들어진다.
 */
CREATE UNIQUE INDEX role_grant_requests_one_pending_idx
  ON core.role_grant_requests (tenant_id, subject_id, role, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state = 'pending';

ALTER TABLE core.role_grant_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.role_grant_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY role_grant_requests_tenant ON core.role_grant_requests FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.role_grant_requests TO mpc_app;

/**
 * 지갑 비활성 이력 — AC-27.
 *
 * `wallet_identities.disabled_at`은 컬럼만 있고 그것을 설정하는 경로가 없었다.
 * 즉 **분실한 키를 끊는 방법 자체가 없었다.**
 *
 * 끊는 것만으로는 부족하다. 왜 끊었는지가 남지 않으면 나중에 그 계정의 과거
 * 서명을 어떻게 읽어야 할지 판단할 수 없다 — 분실과 퇴사와 침해는 다르다.
 */
CREATE TABLE core.wallet_disable_events (
  id                    UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES core.tenants(id),
  wallet_identity_id    UUID NOT NULL REFERENCES core.wallet_identities(id),
  reason_code           TEXT NOT NULL
                          CHECK (reason_code IN ('key_lost', 'key_compromised', 'rotation', 'offboarding')),
  detail                TEXT NOT NULL CHECK (length(btrim(detail)) > 0),
  disabled_by_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  disabled_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX wallet_disable_events_wallet_idx
  ON core.wallet_disable_events (wallet_identity_id, disabled_at DESC);

ALTER TABLE core.wallet_disable_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.wallet_disable_events FORCE ROW LEVEL SECURITY;

CREATE POLICY wallet_disable_events_tenant ON core.wallet_disable_events FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.wallet_disable_events TO mpc_app;
