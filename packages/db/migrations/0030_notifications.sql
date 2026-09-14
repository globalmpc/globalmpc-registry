-- 알림 — spec 12 §12.4 R2 범위.
--
-- **없던 것을 만든다.** 검토 요청·gap 발생·stale·revoke가 일어나도 당사자가 아는
-- 경로는 화면을 다시 여는 것뿐이었다. 그것은 "무엇이 바뀌었나"에 답하지 않는다 —
-- 사람이 화면마다 이전 상태를 기억하고 있어야 한다.
--
-- **트리거로 만드는 이유.** route마다 알림 생성을 끼우면 새 route가 생길 때마다
-- 빠뜨릴 수 있고, 빠뜨린 것은 "알림이 안 온다"로만 드러난다. 사건이 만들어지는
-- 자리(테이블)에 붙이면 어느 경로로 들어와도 같이 생긴다.
--
-- **발신 수단은 여기서 정하지 않는다.** 메일·webhook·푸시 중 무엇으로 내보낼지는
-- 결정된 바 없다. 이 표는 그 결정과 무관하게 필요한 것 — **무엇이
-- 누구에게 갈 알림인가** — 를 담고, 앱 안에서 읽는 경로를 먼저 연다.

CREATE TYPE core.notification_kind AS ENUM (
  'review_assigned',
  'readiness_gap',
  'evidence_stale',
  'registry_revoked'
);

CREATE TABLE core.notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  kind          core.notification_kind NOT NULL,
  /**
   * 개인에게 가는가, 역할에게 가는가.
   *
   * 검토 배정은 배정된 사람에게 간다. stale 신호나 철회는 **아무에게도 배정되지
   * 않은 사건**이라 개인이 없다 — 그것을 특정인에게 보내면 그 사람이 자리를 비운
   * 동안 아무도 모른다. 역할로 보내고 그 역할을 가진 누구든 읽는다.
   */
  subject_id    UUID REFERENCES core.subjects(id),
  audience_role TEXT,
  project_id    UUID,
  summary       TEXT NOT NULL CHECK (length(btrim(summary)) > 0),
  /** 이 알림이 가리키는 화면. 알림만 있고 갈 곳이 없으면 다시 찾아야 한다. */
  link          TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_has_audience CHECK (
    (subject_id IS NOT NULL AND audience_role IS NULL)
    OR (subject_id IS NULL AND audience_role IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

CREATE INDEX notifications_subject_idx
  ON core.notifications (tenant_id, subject_id, occurred_at DESC)
  WHERE subject_id IS NOT NULL;
CREATE INDEX notifications_role_idx
  ON core.notifications (tenant_id, audience_role, occurred_at DESC)
  WHERE audience_role IS NOT NULL;

/**
 * 읽음은 **주체별**이다.
 *
 * 역할로 간 알림은 여러 사람이 본다. 알림 행에 `read_at`을 두면 한 사람이 읽는
 * 순간 나머지에게서 사라지고, 그 사람이 처리하지 않으면 아무도 다시 보지 않는다.
 */
CREATE TABLE core.notification_reads (
  notification_id UUID NOT NULL REFERENCES core.notifications(id),
  subject_id      UUID NOT NULL REFERENCES core.subjects(id),
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, subject_id)
);

ALTER TABLE core.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE core.notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.notification_reads FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_tenant ON core.notifications FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY notification_reads_tenant ON core.notification_reads FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.notifications TO mpc_app;
GRANT SELECT, INSERT ON core.notification_reads TO mpc_app;

-- ---------------------------------------------------------------------------
-- 사건 → 알림
-- ---------------------------------------------------------------------------
--
-- 트리거는 `SECURITY DEFINER`가 아니다. 사건을 만든 트랜잭션의 tenant 안에서
-- 돌기 때문에 RLS를 그대로 만족한다 — 알림이 다른 tenant로 새지 않는다.

/** 검토 배정 → 배정된 사람에게. */
CREATE FUNCTION core.notify_review_assigned() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target_project UUID;
BEGIN
  SELECT c.project_id INTO target_project
  FROM core.verification_cases c WHERE c.id = NEW.case_id;

  INSERT INTO core.notifications (tenant_id, kind, subject_id, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'review_assigned', NEW.subject_id, target_project,
    '검토가 배정됐다',
    '/w/projects/' || target_project || '/verification'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER assignments_notify
  AFTER INSERT ON core.assignments
  FOR EACH ROW EXECUTE FUNCTION core.notify_review_assigned();

/**
 * readiness gap → data_steward 역할에게.
 *
 * gap은 특정인의 일이 아니다. 증빙을 채울 사람이 채운다.
 */
CREATE FUNCTION core.notify_readiness_gap() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'gap' THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'readiness_gap', 'data_steward', NEW.project_id,
    '준비도 평가에서 gap이 나왔다',
    '/w/projects/' || NEW.project_id || '/readiness'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER compliance_assessments_notify
  AFTER INSERT ON core.compliance_assessments
  FOR EACH ROW EXECUTE FUNCTION core.notify_readiness_gap();

/** stale 신호 → data_steward 역할에게. 아무에게도 배정되지 않은 사건이다. */
CREATE FUNCTION core.notify_evidence_stale() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'evidence_stale', 'data_steward', NEW.project_id,
    '근거가 흔들렸다: ' || NEW.reason,
    '/w/work'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_stale_signals_notify
  AFTER INSERT ON core.evidence_stale_signals
  FOR EACH ROW EXECUTE FUNCTION core.notify_evidence_stale();

/**
 * 공개 기록 철회 → mpc_operator 역할에게.
 *
 * 철회는 공개된 것을 내리는 일이라 알림이 늦으면 그 사이 인용이 계속된다.
 */
CREATE FUNCTION core.notify_registry_revoked() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target_key TEXT;
  target_project UUID;
BEGIN
  IF NEW.status <> 'revoked' OR OLD.status = 'revoked' THEN
    RETURN NEW;
  END IF;

  SELECT e.public_key, p.id INTO target_key, target_project
  FROM core.registry_entries e
  LEFT JOIN core.projects p ON p.id = e.subject_id
  WHERE e.id = NEW.entry_id;

  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'registry_revoked', 'mpc_operator', target_project,
    '공개 기록이 철회됐다: ' || coalesce(target_key, '(키 없음)'),
    '/w/registries'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER registry_entry_versions_notify_revoked
  AFTER UPDATE ON core.registry_entry_versions
  FOR EACH ROW EXECUTE FUNCTION core.notify_registry_revoked();
