-- 업로드 추적과 quarantine — 12 §12.2 "encrypted object upload·quarantine".
--
-- 업로드는 즉시 evidence가 되지 않는다. quarantine에 들어가 검사를 통과해야
-- artifact로 승격된다(06 §6.7 "malware quarantine"). 업로드 즉시 evidence가 되면
-- 악성 파일이 전문 검토 대상 자료가 된다.

CREATE TYPE core.upload_state AS ENUM (
  'received',
  'quarantined',
  'scanned_clean',
  'scanned_infected',
  'promoted',
  'rejected'
);

CREATE TABLE core.object_uploads (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  project_id    UUID NOT NULL,
  -- 저장소 키에 파일명·프로젝트명을 넣지 않는다. 키는 로그·URL·에러 메시지를
  -- 타고 흐르며, 문서 제목도 public projection에 누출돼서는 안 된다(§11.9).
  object_key    TEXT NOT NULL,
  content_hash  TEXT NOT NULL CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
  byte_size     BIGINT NOT NULL CHECK (byte_size > 0),
  content_type  TEXT NOT NULL,
  -- 원본 파일명은 별도 컬럼에 두고 restricted로 취급한다. 화면에 보여줄 때도
  -- 공개 projection allowlist를 통과해야 한다.
  original_filename TEXT,
  sensitivity   core.sensitivity NOT NULL,
  state         core.upload_state NOT NULL DEFAULT 'received',
  uploaded_by   UUID,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_at    TIMESTAMPTZ,
  promoted_artifact_id UUID,
  rejection_reason TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, object_key),
  -- 같은 내용을 두 번 올리면 같은 해시가 나온다. tenant·프로젝트 안에서
  -- 중복 업로드를 막아 evidence가 갈라지지 않게 한다.
  UNIQUE (tenant_id, project_id, content_hash),
  CONSTRAINT promoted_requires_artifact CHECK (
    state <> 'promoted' OR promoted_artifact_id IS NOT NULL
  ),
  CONSTRAINT rejected_requires_reason CHECK (
    state <> 'rejected' OR btrim(coalesce(rejection_reason, '')) <> ''
  ),
  CONSTRAINT upload_tenant_scope_key UNIQUE (tenant_id, id)
);

-- tenant 경계를 넘는 참조를 막는다(0006과 같은 규칙).
ALTER TABLE core.object_uploads
  ADD CONSTRAINT object_uploads_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  ADD CONSTRAINT object_uploads_uploader_same_tenant
    FOREIGN KEY (tenant_id, uploaded_by) REFERENCES core.subjects (tenant_id, id),
  ADD CONSTRAINT object_uploads_artifact_same_tenant
    FOREIGN KEY (tenant_id, promoted_artifact_id) REFERENCES core.artifacts (tenant_id, id);

ALTER TABLE core.object_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.object_uploads FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.object_uploads
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.object_uploads TO mpc_app;

CREATE INDEX object_uploads_project_idx ON core.object_uploads (project_id, uploaded_at DESC);
CREATE INDEX object_uploads_quarantine_idx ON core.object_uploads (state)
  WHERE state IN ('received', 'quarantined');

-- 업로드 기록은 지우지 않는다. 잘못된 업로드도 rejected 상태로 남긴다 —
-- 무엇이 올라왔었는지가 감사 대상이다.
CREATE TRIGGER object_upload_no_delete
  BEFORE DELETE ON core.object_uploads
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- content_hash와 object_key는 저장 후 바뀌지 않는다. 바뀌면 저장소의 실제
-- 객체와 DB 기록이 어긋난다.
CREATE OR REPLACE FUNCTION core.protect_upload_identity() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.byte_size  IS DISTINCT FROM OLD.byte_size
     OR NEW.tenant_id  IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
  THEN
    RAISE EXCEPTION '업로드된 객체의 식별 정보는 수정할 수 없다. 새 업로드로 처리한다'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER object_upload_identity_immutable
  BEFORE UPDATE ON core.object_uploads
  FOR EACH ROW EXECUTE FUNCTION core.protect_upload_identity();
