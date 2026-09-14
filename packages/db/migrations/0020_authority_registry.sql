-- Authority Registry 운영 경로 — spec 02 §2.8, 05 §5.11, REQ-DAPP-043.
--
-- 지금까지 authority와 source connection은 seed와 테스트에서만 만들어졌다.
-- 운영 중에 기관을 등록하거나 갱신할 경로가 없어 DB에 직접 INSERT해야 했고,
-- 그러면 **누가 등록했고 누가 승인했는지가 남지 않는다.**
--
-- 02 §2.8이 정한 것: 등록은 Trust Registry 운영자가 하고, `accepted` 전환은
-- 독립 reviewer가 한다. **운영자 단독 전환은 금지다.**

ALTER TABLE core.authorities
  -- 누가 후보로 올렸는가. 승인자와 같으면 안 되므로 저장해야 판정할 수 있다.
  ADD COLUMN registered_by UUID REFERENCES core.subjects(id),
  ADD COLUMN accepted_by   UUID REFERENCES core.subjects(id),
  ADD COLUMN accepted_at   TIMESTAMPTZ,
  -- 왜 이 상태인가. `suspended`·`revoked`는 이유 없이 남을 수 없다.
  ADD COLUMN state_reason  TEXT;

/**
 * 상태에 이유가 따라붙는다.
 *
 * 기관을 정지·취소하면 그것을 근거로 삼은 receipt가 전부 영향을 받는다.
 * 이유 없이 바뀌면 나중에 "왜 못 쓰게 됐나"에 답할 수 없다.
 */
ALTER TABLE core.authorities
  ADD CONSTRAINT authority_negative_state_needs_reason
  CHECK (
    state NOT IN ('suspended', 'revoked', 'superseded')
    OR (state_reason IS NOT NULL AND length(btrim(state_reason)) > 0)
  );

/**
 * authority 이력 — REQ-DAPP-043의 versioning.
 *
 * `version` 컬럼만으로는 동시성만 막는다. Source Receipt는 조회 시점의
 * authority를 근거로 삼는데, 그 시점에 이 기관이 **무엇을 확인해 준다고
 * 했는지**를 나중에 재현할 수 없으면 receipt의 한계 문구가 근거를 잃는다.
 *
 * append-only다. 과거 버전을 고칠 수 있으면 이력이 아니다.
 */
CREATE TABLE core.authority_versions (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  authority_id    UUID NOT NULL,
  version         INTEGER NOT NULL,
  name            TEXT NOT NULL,
  jurisdiction    TEXT NOT NULL,
  proves          TEXT[] NOT NULL,
  does_not_prove  TEXT[] NOT NULL,
  recognized_scope TEXT[] NOT NULL,
  verification_method TEXT NOT NULL,
  public_disclosure_level core.sensitivity NOT NULL,
  valid_from      DATE NOT NULL,
  valid_until     DATE,
  state           core.authority_state NOT NULL,
  state_reason    TEXT,
  -- 무엇이 바뀌었고 왜 바뀌었는가.
  change_reason   TEXT NOT NULL CHECK (length(btrim(change_reason)) > 0),
  changed_by      UUID REFERENCES core.subjects(id),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (authority_id, version),
  FOREIGN KEY (tenant_id, authority_id) REFERENCES core.authorities (tenant_id, id)
);

CREATE INDEX authority_versions_authority_idx
  ON core.authority_versions (authority_id, version DESC);

ALTER TABLE core.authority_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.authority_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.authority_versions
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.authority_versions TO mpc_app;

CREATE OR REPLACE FUNCTION core.reject_authority_version_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authority 이력은 수정하거나 삭제할 수 없다';
END
$$;

CREATE TRIGGER authority_versions_append_only
  BEFORE UPDATE OR DELETE ON core.authority_versions
  FOR EACH ROW EXECUTE FUNCTION core.reject_authority_version_mutation();

/**
 * 승인되지 않은 기관의 연동은 활성이 될 수 없다.
 *
 * 02 §2.8이 금지하는 것: **API 성공을 authority 승인으로 변환**하는 것.
 * 연동이 붙었다는 사실과 그 기관을 신뢰하기로 했다는 판단은 다른 것이고,
 * 이 제약이 없으면 연동을 켜는 것만으로 승인 절차를 건너뛸 수 있다.
 */
CREATE OR REPLACE FUNCTION core.check_connection_authority_accepted() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  authority_state core.authority_state;
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT a.state INTO authority_state
  FROM core.authorities a WHERE a.id = NEW.authority_id;

  IF authority_state IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION '승인되지 않은 기관(%)의 연동은 활성이 될 수 없다', authority_state;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER source_connections_require_accepted_authority
  BEFORE INSERT OR UPDATE ON core.source_connections
  FOR EACH ROW EXECUTE FUNCTION core.check_connection_authority_accepted();

/**
 * 기관이 승인 상태를 벗어나면 그 연동을 내린다 — AC-04·AC-21의 전파.
 *
 * 기관을 정지시켰는데 연동이 계속 `active`면 화면은 계속 "연동됨"으로 보이고
 * 수집은 계속 돈다. 정지의 의미가 사라진다.
 *
 * `degraded`로 내린다 — 연동 설정 자체는 남기고 호출만 막는다. `disabled`는
 * 사람이 명시적으로 끄는 것이고, 여기서 쓰면 둘을 구분할 수 없다.
 */
CREATE OR REPLACE FUNCTION core.propagate_authority_state() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'accepted' AND NEW.state <> 'accepted' THEN
    UPDATE core.source_connections
    SET state = 'degraded'
    WHERE authority_id = NEW.id AND state = 'active';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER authorities_propagate_state
  AFTER UPDATE ON core.authorities
  FOR EACH ROW EXECUTE FUNCTION core.propagate_authority_state();

-- 기존 행에 초기 버전을 남긴다. 이력이 이 마이그레이션부터 시작한다는 사실을
-- 기록으로 남겨야 "왜 v1 이전이 없나"에 답할 수 있다.
INSERT INTO core.authority_versions (
  id, tenant_id, authority_id, version, name, jurisdiction, proves, does_not_prove,
  recognized_scope, verification_method, public_disclosure_level,
  valid_from, valid_until, state, state_reason, change_reason
)
SELECT gen_random_uuid(), a.tenant_id, a.id, a.version, a.name, a.jurisdiction,
       a.proves, a.does_not_prove, a.recognized_scope, a.verification_method,
       a.public_disclosure_level, a.valid_from, a.valid_until, a.state, a.state_reason,
       '이력 도입 시점의 초기 기록 (migration 0020)'
FROM core.authorities a;
