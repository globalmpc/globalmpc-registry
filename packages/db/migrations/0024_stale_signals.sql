-- 전파의 마지막 구간 — AC-21, spec 10 §175.
--
-- 0023이 `connection → claim → attestation`까지 이었다. 남은 것은
-- `attestation → assessment → Registry version`인데, **앞 구간과 같은 방법을 쓸 수
-- 없다.**
--
--   - `compliance_assessments`는 append-only다(`assessment_no_update`).
--   - `registry_entry_versions`는 게시 뒤 내용이 불변이다
--     (`registry_version_immutable_after_publish`).
--
-- 둘 다 의도된 제약이다. 평가 결과와 공개 기록은 나중에 고쳐 쓸 수 없어야 한다.
-- 그래서 **상태를 바꾸는 대신 신호를 남긴다.**
--
-- **자동으로 revoke하지 않는 이유:** 공개된 Registry 기록을 내리는 것은 세상이
-- 보는 것을 바꾸는 행위다. 연동 하나가 끊겼다고 공개 기록이 자동으로 사라지면,
-- 출처 장애가 곧 기록 삭제가 된다. 판정은 사람이 한다(`registry.revoke`).

CREATE TYPE core.stale_signal_target AS ENUM (
  'compliance_assessment',
  'registry_entry_version'
);

CREATE TYPE core.stale_signal_resolution AS ENUM (
  -- 아직 사람이 보지 않았다.
  'open',
  -- 새 version으로 정정했다.
  'superseded',
  -- 공개 기록을 내렸다.
  'revoked',
  -- 확인했고 영향 없다고 판정했다. 이유가 함께 남는다.
  'dismissed'
);

/**
 * 근거가 흔들렸다는 신호 — AC-21.
 *
 * 대상 자체를 바꾸지 않고 **"이 산출물이 딛고 있던 근거가 흔들렸다"는 사실**만
 * 기록한다. append-only이며, 처리 결과는 같은 행의 resolution으로 닫는다.
 *
 * 신호가 열려 있다는 것은 **재검토가 필요하다**는 뜻이지 그 기록이 틀렸다는
 * 뜻이 아니다. 그 구분이 없으면 출처 장애가 곧 기록 부정이 된다.
 */
CREATE TABLE core.evidence_stale_signals (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  project_id    UUID REFERENCES core.projects(id),
  target_type   core.stale_signal_target NOT NULL,
  target_id     UUID NOT NULL,
  /** 어디서 시작됐는가. 사슬을 거슬러 올라갈 수 있어야 한다. */
  origin_attestation_id UUID,
  origin_claim_id       UUID,
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  resolution    core.stale_signal_resolution NOT NULL DEFAULT 'open',
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES core.subjects(id),
  /** 왜 그렇게 판정했는가. `dismissed`에 특히 필요하다. */
  resolution_note TEXT,

  -- 같은 대상에 같은 원인으로 신호가 겹치지 않게 한다. 열린 신호가 쌓이면
  -- 무엇을 봐야 하는지 알 수 없다.
  UNIQUE (target_type, target_id, origin_attestation_id),

  CONSTRAINT stale_signal_resolution_needs_note CHECK (
    resolution = 'open'
    OR (resolved_at IS NOT NULL
        AND resolution_note IS NOT NULL
        AND length(btrim(resolution_note)) > 0)
  )
);

CREATE INDEX evidence_stale_signals_open_idx
  ON core.evidence_stale_signals (tenant_id, project_id)
  WHERE resolution = 'open';

ALTER TABLE core.evidence_stale_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.evidence_stale_signals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.evidence_stale_signals
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- 신호는 지워지지 않는다. 닫을 수만 있다.
GRANT SELECT, INSERT, UPDATE ON core.evidence_stale_signals TO mpc_app;

CREATE OR REPLACE FUNCTION core.reject_stale_signal_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '근거 신호는 삭제할 수 없다. resolution으로 닫는다';
END
$$;

CREATE TRIGGER evidence_stale_signals_no_delete
  BEFORE DELETE ON core.evidence_stale_signals
  FOR EACH ROW EXECUTE FUNCTION core.reject_stale_signal_delete();

/**
 * 닫힌 신호를 다시 열거나 원인을 바꿀 수 없다.
 *
 * 판정을 되돌릴 수 있으면 "언제 무엇을 알았고 어떻게 판단했나"가 사라진다.
 * 다시 봐야 하면 새 신호가 생긴다.
 */
CREATE OR REPLACE FUNCTION core.protect_stale_signal() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolution <> 'open' THEN
    RAISE EXCEPTION '이미 닫힌 신호는 바꿀 수 없다 (현재: %)', OLD.resolution;
  END IF;

  IF NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
     OR NEW.origin_attestation_id IS DISTINCT FROM OLD.origin_attestation_id
  THEN
    RAISE EXCEPTION '신호의 원인과 시점은 바꿀 수 없다';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER evidence_stale_signals_protect
  BEFORE UPDATE ON core.evidence_stale_signals
  FOR EACH ROW EXECUTE FUNCTION core.protect_stale_signal();

/**
 * attestation → assessment · Registry version 전파.
 *
 * attestation이 `stale_candidate`가 되면 그 프로젝트의 **활성 평가**와
 * **공개된 Registry version**에 신호를 남긴다.
 *
 * 왜 프로젝트 단위인가: `compliance_assessments`는 attestation을 직접 가리키지
 * 않는다(`requirement_results`는 JSON이고 링크가 아니다). 정확한 사슬이 없으므로
 * **넓게 잡는다** — 관련 없는 것에 신호가 붙는 편이, 관련 있는 것을 놓치는 것보다
 * 낫다. 사람이 `dismissed`로 닫으면 그 판단도 기록에 남는다.
 */
CREATE OR REPLACE FUNCTION core.propagate_attestation_to_signals() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target_project UUID;
BEGIN
  IF NEW.state <> 'stale_candidate' OR OLD.state = 'stale_candidate' THEN
    RETURN NEW;
  END IF;

  SELECT c.project_id INTO target_project
  FROM core.verification_cases c WHERE c.id = NEW.case_id;

  IF target_project IS NULL THEN
    RETURN NEW;
  END IF;

  -- 가장 최근 평가에만 신호를 단다. 과거 평가는 그 시점의 판정이며 지금 다시
  -- 볼 대상이 아니다.
  INSERT INTO core.evidence_stale_signals (
    id, tenant_id, project_id, target_type, target_id,
    origin_attestation_id, reason
  )
  SELECT gen_random_uuid(), NEW.tenant_id, target_project,
         'compliance_assessment', a.id, NEW.id,
         coalesce(NEW.stale_reason, '근거 attestation이 재검토 대상이 됐다')
  FROM core.compliance_assessments a
  WHERE a.project_id = target_project
  ORDER BY a.generated_at DESC
  LIMIT 1
  ON CONFLICT DO NOTHING;

  -- 공개된 Registry version. **자동으로 내리지 않는다** — 신호만 남기고
  -- supersede·revoke는 `registry.revoke` 권한을 가진 사람이 판정한다.
  INSERT INTO core.evidence_stale_signals (
    id, tenant_id, project_id, target_type, target_id,
    origin_attestation_id, reason
  )
  SELECT gen_random_uuid(), NEW.tenant_id, target_project,
         'registry_entry_version', v.id, NEW.id,
         coalesce(NEW.stale_reason, '근거 attestation이 재검토 대상이 됐다')
  FROM core.registry_entry_versions v
  JOIN core.registry_entries e ON e.id = v.entry_id
  WHERE e.tenant_id = NEW.tenant_id
    AND e.subject_id = target_project
    AND v.status = 'published'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$$;

CREATE TRIGGER attestations_propagate_to_signals
  AFTER UPDATE ON core.verification_attestations
  FOR EACH ROW EXECUTE FUNCTION core.propagate_attestation_to_signals();
