-- Governance — spec 04 §4.5, OD-06
--
-- Protocol governance와 Project governance를 **같은 테이블에 두되 space로 분리**한다.
-- 테이블을 나누면 같은 상태기계·같은 정족수 계산을 두 벌 유지해야 하고, 그 둘이
-- 어긋나면 어느 쪽이 맞는지 알 수 없다.
--
-- 분리는 `space`와 `project_id`가 강제한다.
--
--   - protocol 제안은 `project_id`가 NULL이어야 한다.
--   - project 제안은 `project_id`가 있어야 한다.
--
-- **투표가 오프체인 사실을 만들지 않는다**(불변조건 12). 이 스키마에는 투표
-- 결과로 authority·credential·법적 상태를 바꾸는 컬럼이 없다. 결과는
-- `execution_*`로 기록될 뿐이고 실제 집행은 별도 행위다.

CREATE TYPE core.governance_space AS ENUM ('protocol', 'project');

CREATE TYPE core.proposal_state AS ENUM (
  'draft', 'review', 'announced', 'voting',
  'succeeded', 'defeated', 'no_quorum',
  'timelocked', 'recorded', 'execution_pending',
  'executed', 'failed', 'disputed', 'cancelled'
);

CREATE TABLE core.governance_proposals (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  space             core.governance_space NOT NULL,
  -- project space에서만 채운다. 아래 CHECK이 강제한다.
  project_id        UUID,
  proposal_type     TEXT NOT NULL,
  title             TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  -- 무엇을 바꾸자는 것인지. 이유 없는 제안은 판단할 근거가 없다.
  rationale         TEXT NOT NULL CHECK (length(btrim(rationale)) > 0),
  state             core.proposal_state NOT NULL DEFAULT 'draft',
  proposer_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  -- 정족수와 통과 기준은 제안 시점 값을 고정한다. 나중에 바꿔 결과를 뒤집을 수
  -- 없다(§4.5 non-retroactive).
  quorum_numerator  INTEGER NOT NULL CHECK (quorum_numerator > 0),
  quorum_denominator INTEGER NOT NULL CHECK (quorum_denominator > 0),
  threshold_numerator INTEGER NOT NULL CHECK (threshold_numerator > 0),
  threshold_denominator INTEGER NOT NULL CHECK (threshold_denominator > 0),
  voting_opens_at   TIMESTAMPTZ,
  voting_closes_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  version           INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT proposal_space_scope CHECK (
    (space = 'protocol' AND project_id IS NULL)
    OR (space = 'project' AND project_id IS NOT NULL)
  ),
  CONSTRAINT proposal_voting_window CHECK (
    voting_closes_at IS NULL OR voting_opens_at IS NULL
    OR voting_closes_at > voting_opens_at
  ),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

-- tenant를 FK에 포함하려면 부모에 복합 UNIQUE가 있어야 한다. 자식 테이블보다
-- 먼저 만든다(0006과 같은 이유 — FK 검사는 RLS를 우회한다).
ALTER TABLE core.governance_proposals ADD CONSTRAINT governance_proposals_tenant_scope_key
  UNIQUE (tenant_id, id);

CREATE INDEX governance_proposals_space_idx
  ON core.governance_proposals (tenant_id, space, state);

/**
 * 투표.
 *
 * 한 주체는 한 제안에 한 번만 투표한다. 바꾸려면 새로 던지는 것이 아니라
 * 기존 투표를 갱신한다 — 두 표가 남으면 어느 것이 유효한지 판정이 필요해진다.
 *
 * **투표 무게를 여기 저장한다.** 나중에 잔고가 바뀌어도 이미 던진 표의 무게는
 * 그대로다. 그러지 않으면 집계 시점마다 결과가 달라진다.
 */
CREATE TABLE core.governance_votes (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  proposal_id   UUID NOT NULL,
  voter_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  choice        TEXT NOT NULL CHECK (choice IN ('for', 'against', 'abstain')),
  -- decimal string이다. JSON number를 쓰지 않는 것과 같은 이유(ADR-T07).
  weight        NUMERIC(78, 0) NOT NULL CHECK (weight >= 0),
  cast_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, voter_subject_id),
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES core.governance_proposals (tenant_id, id)
);

CREATE INDEX governance_votes_proposal_idx ON core.governance_votes (proposal_id);

/**
 * 상태 전이 이력.
 *
 * 제안이 지나온 경로를 남긴다. 현재 상태만으로는 "정족수 미달로 끝났다"와
 * "취소됐다"가 결과만 같아 보인다.
 */
CREATE TABLE core.governance_transitions (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  proposal_id   UUID NOT NULL,
  from_state    core.proposal_state NOT NULL,
  to_state      core.proposal_state NOT NULL,
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_subject_id UUID,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 집계 결과를 함께 굳힌다. 나중에 표가 바뀌어도 그때의 판정 근거가 남는다.
  tally_snapshot JSONB,
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES core.governance_proposals (tenant_id, id)
);

CREATE INDEX governance_transitions_proposal_idx
  ON core.governance_transitions (proposal_id, occurred_at);

ALTER TABLE core.governance_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE core.governance_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_votes FORCE ROW LEVEL SECURITY;
ALTER TABLE core.governance_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.governance_proposals
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY tenant_isolation ON core.governance_votes
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY tenant_isolation ON core.governance_transitions
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.governance_proposals TO mpc_app;
-- 투표는 갱신할 수 있다(마음을 바꿀 수 있다). 삭제는 없다 — 던진 적이 없는
-- 것과 철회한 것은 다른 사실이다.
GRANT SELECT, INSERT, UPDATE ON core.governance_votes TO mpc_app;
-- 전이 이력은 append-only다.
GRANT SELECT, INSERT ON core.governance_transitions TO mpc_app;

/**
 * 투표 종료 후 표를 바꿀 수 없다.
 *
 * 애플리케이션이 확인하지만 그것만으로는 부족하다 — 집계가 끝난 뒤 표가 하나
 * 바뀌면 이미 기록된 결과와 어긋난다.
 */
CREATE OR REPLACE FUNCTION core.reject_vote_after_close() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  proposal_state core.proposal_state;
BEGIN
  SELECT state INTO proposal_state
  FROM core.governance_proposals WHERE id = NEW.proposal_id;

  IF proposal_state <> 'voting' THEN
    RAISE EXCEPTION '투표 기간이 아니다 (제안 상태: %)', proposal_state;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER governance_votes_only_while_voting
  BEFORE INSERT OR UPDATE ON core.governance_votes
  FOR EACH ROW EXECUTE FUNCTION core.reject_vote_after_close();

CREATE OR REPLACE FUNCTION core.reject_delete_governance() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 는 삭제할 수 없다', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER governance_votes_no_delete
  BEFORE DELETE ON core.governance_votes
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();

CREATE TRIGGER governance_transitions_no_delete
  BEFORE DELETE ON core.governance_transitions
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();

CREATE TRIGGER governance_proposals_no_delete
  BEFORE DELETE ON core.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();
