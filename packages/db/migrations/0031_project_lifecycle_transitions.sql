-- project lifecycle 전이 이력 — spec 04 §4.3.
--
-- `core.projects.lifecycle_state`는 `draft`로 들어온 뒤 Registry 게시가
-- `registered`로 한 번 옮기는 것이 전부였다. 나머지 전이 — suspension, 복귀,
-- offering, closure — 는 **경로 자체가 없었다.** 12 §12.4가 R2 데모로 적은
-- `evidence revoke → … → suspended → reinstatement`가 배포본에서 실행되지 않았다.
--
-- **왜 이력 표가 따로 필요한가:** 현재 상태만으로는 "정족수 미달로 끝났다"와
-- "취소됐다"가 구분되지 않는 것(0017의 governance_transitions)과 같은 문제다.
-- `suspended`에서 돌아온 프로젝트와 한 번도 멈춘 적 없는 프로젝트는 현재 상태가
-- 같다. 그 둘을 구분하지 못하면 감사가 성립하지 않는다.

CREATE TABLE core.project_lifecycle_transitions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  project_id       UUID NOT NULL,
  from_state       core.at_lifecycle_state NOT NULL,
  to_state         core.at_lifecycle_state NOT NULL,
  -- 이유 없는 전이는 나중에 판단할 근거가 없다. governance_transitions와 같다.
  reason           TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_subject_id UUID REFERENCES core.subjects(id),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

CREATE INDEX project_lifecycle_transitions_project_idx
  ON core.project_lifecycle_transitions (project_id, occurred_at);

ALTER TABLE core.project_lifecycle_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_lifecycle_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY project_lifecycle_transitions_tenant ON core.project_lifecycle_transitions FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.project_lifecycle_transitions TO mpc_app;

/**
 * 누가 멈췄는가 — lifecycle 결정의 강제 지점.
 *
 * suspension은 급한 일이라 **1인**이 한다. 2인을 요구하면 두 번째 사람을
 * 기다리는 동안 문제가 있는 프로젝트가 계속 돈다(지갑 비활성과 같은 논리).
 *
 * 대신 **복귀는 멈춘 사람이 할 수 없다.** 같은 사람이 멈추고 되돌리면 1인이
 * 프로젝트 상태를 자유롭게 오가는 것이 되고, suspension은 통제가 아니라
 * 개인의 재량이 된다. 이 컬럼이 그 판정의 근거다.
 */
ALTER TABLE core.projects
  ADD COLUMN suspended_by_subject_id UUID REFERENCES core.subjects(id);

/**
 * 이력은 **route가 명시적으로 남긴다.** 트리거로 하지 않는다.
 *
 * 트리거가 더 안전해 보이지만, 이 이력에 필요한 두 값 — 누가, 왜 — 은 세션에
 * 있고 트리거는 그것을 모른다. 세션 GUC로 밀어 넣으면 값이 어디서 왔는지가
 * 흐려지고, 설정을 잊은 경로가 "시스템이 옮겼다"로 조용히 기록된다.
 *
 * 전이를 쓰는 곳은 둘뿐이다 — Registry 게시(`draft→registered`)와 lifecycle
 * 전이 route. 둘 다 이 표에 명시적으로 쓴다.
 */
