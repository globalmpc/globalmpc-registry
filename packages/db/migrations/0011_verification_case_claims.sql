-- Verification case의 검토 범위를 보존한다 — 04 §4.2·§4.4
--
-- 지금까지 case 생성 시 claim 목록은 evidence snapshot 해시에만 들어갔다.
-- 해시는 **바뀌었는지**를 판정할 뿐 **무엇이었는지**를 복원하지 못한다.
--
-- 그래서 두 가지가 불가능했다.
--
-- 1. 배정을 만든 사람과 서명하는 사람이 다른데(02 §2.4), 검토자가 자기 case의
--    검토 범위를 조회할 수 없었다.
-- 2. 서명 이후 감사에서 "이 서명이 덮은 근거가 무엇이었나"를 DB만으로 답할 수
--    없었다. attestation의 claim_scope는 검토자가 다시 입력한 값이라 case가
--    배정한 범위와 같다는 보장이 없다.
--
-- 범위는 배정 시점에 확정되고 이후 바뀌지 않는다. 바꾸려면 새 case를 만든다.

CREATE TABLE core.verification_case_claims (
  tenant_id  UUID NOT NULL REFERENCES core.tenants(id),
  case_id    UUID NOT NULL,
  claim_id   UUID NOT NULL,
  PRIMARY KEY (case_id, claim_id),
  -- tenant_id를 FK에 포함한다. FK 검사는 RLS를 우회하므로 (tenant_id, id) 복합
  -- 참조가 아니면 다른 tenant의 행을 참조할 수 있다(0006과 같은 이유).
  FOREIGN KEY (tenant_id, case_id) REFERENCES core.verification_cases (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES core.claims (tenant_id, id)
);

CREATE INDEX verification_case_claims_case_idx
  ON core.verification_case_claims (case_id);

ALTER TABLE core.verification_case_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.verification_case_claims FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.verification_case_claims
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.verification_case_claims TO mpc_app;

-- 배정 범위는 사후에 바꿀 수 없다. UPDATE·DELETE 권한을 주지 않는 것이 통제다.
