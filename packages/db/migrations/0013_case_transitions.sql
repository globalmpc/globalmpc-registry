-- 검토 case 상태 이력과 attestation 이의 제기 — spec 04 §4.2·§4.4
--
-- 지금까지 case의 state는 현재 값만 있었다. 그것으로는 두 가지를 알 수 없다.
--
-- 1. **왜 이 상태가 됐는가** — `changes_requested`가 무엇을 보완하라는 것인지
--    적을 자리가 없으면 검토자는 다시 물어봐야 한다.
-- 2. **어떤 경로로 왔는가** — 반려 후 재배정된 case와 처음부터 진행된 case가
--    현재 상태만으로는 같아 보인다.
--
-- 이력은 지우지 않는다. 상태가 되돌아가도 지나온 경로는 남는다.

CREATE TABLE core.verification_case_transitions (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  case_id       UUID NOT NULL,
  from_state    core.verification_case_state NOT NULL,
  to_state      core.verification_case_state NOT NULL,
  -- 이유 없는 상태 변경을 저장하지 않는다. API 검증과 별개로 DB가 거절한다.
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_subject_id UUID,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES core.verification_cases (tenant_id, id)
);

CREATE INDEX verification_case_transitions_case_idx
  ON core.verification_case_transitions (case_id, occurred_at DESC);

/**
 * attestation 이의 제기.
 *
 * **서명을 지우지 않는다.** 서명 당시의 판단은 그대로 남고 이의라는 새 사실이
 * 추가된다. 서명을 삭제하면 "누가 무엇을 언제 판단했는가"를 잃는다 —
 * 잘못된 검토를 감추는 것과 구분되지 않는다.
 */
CREATE TABLE core.attestation_disputes (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  attestation_id UUID NOT NULL,
  reason_code   TEXT NOT NULL,
  detail        TEXT NOT NULL CHECK (length(btrim(detail)) > 0),
  raised_by_subject_id UUID,
  raised_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 해소돼도 이의 기록 자체는 남는다. resolved_at이 채워질 뿐이다.
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,
  FOREIGN KEY (tenant_id, attestation_id)
    REFERENCES core.verification_attestations (tenant_id, id)
);

CREATE INDEX attestation_disputes_attestation_idx
  ON core.attestation_disputes (attestation_id, raised_at DESC);

ALTER TABLE core.verification_case_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.verification_case_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE core.attestation_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.attestation_disputes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.verification_case_transitions
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

CREATE POLICY tenant_isolation ON core.attestation_disputes
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- 상태 이력은 append-only다. UPDATE·DELETE 권한을 주지 않는 것이 통제다.
GRANT SELECT, INSERT ON core.verification_case_transitions TO mpc_app;
-- 이의는 해소 표시를 위해 UPDATE가 필요하다. 삭제는 어떤 경우에도 없다.
GRANT SELECT, INSERT, UPDATE ON core.attestation_disputes TO mpc_app;

-- case의 version을 상태 전이마다 올린다. If-Match가 이 값을 본다.
-- 트리거로 고정하면 애플리케이션이 잊어도 버전이 어긋나지 않는다.
CREATE OR REPLACE FUNCTION core.bump_case_version() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER verification_cases_version_bump
  BEFORE UPDATE ON core.verification_cases
  FOR EACH ROW EXECUTE FUNCTION core.bump_case_version();

-- 이의가 제기된 attestation은 서명 본문을 바꿀 수 없다. 0003의 immutability
-- 트리거가 이미 서명 후 수정을 막지만, state 전이는 허용해야 하므로 여기서
-- 다시 확인한다: disputed로 갔다가 되돌아와도 payload_hash는 그대로다.
