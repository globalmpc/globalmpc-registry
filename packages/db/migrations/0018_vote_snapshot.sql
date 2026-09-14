-- 투표 무게 스냅숏 — spec 04 §4.5, OD-06
--
-- 지금까지 투표 무게는 요청 본문으로 들어왔다. 그러면 던지는 사람이 자기 무게를
-- 정한다 — 투표가 아니라 선언이다.
--
-- 무게는 **투표 시작 시점의 온체인 잔고**에서 온다. 시점을 고정하는 이유:
--
--   1. 투표 중에 토큰을 사서 무게를 늘릴 수 없다.
--   2. 같은 토큰을 여러 지갑으로 옮겨 여러 번 던질 수 없다.
--   3. 집계를 언제 다시 해도 같은 결과가 나온다.
--
-- 스냅숏 블록은 제안이 `voting`으로 갈 때 정해지고 이후 바뀌지 않는다.

ALTER TABLE core.governance_proposals
  -- 투표 시작 시점의 블록. 이 높이의 잔고가 무게다.
  ADD COLUMN snapshot_block BIGINT,
  -- 무게를 읽을 토큰 컨트랙트. 없으면 수동 입력으로 떨어진다.
  ADD COLUMN snapshot_token_address TEXT
    CHECK (snapshot_token_address ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN snapshot_chain_id INTEGER;

/**
 * 스냅숏된 무게.
 *
 * 조회 결과를 저장하는 이유: 온체인 조회는 실패할 수 있고 아카이브 노드가
 * 필요하다. 매 집계마다 다시 읽으면 노드 상태에 결과가 좌우된다.
 *
 * **한 번 기록되면 바뀌지 않는다.** 같은 (proposal, wallet)에 두 값이 있으면
 * 어느 것이 맞는지 판정이 필요해진다.
 */
CREATE TABLE core.governance_vote_weights (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  proposal_id   UUID NOT NULL,
  wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  -- decimal string으로 다룬다. 18 decimals를 number로 담으면 정밀도를 잃는다.
  weight        NUMERIC(78, 0) NOT NULL CHECK (weight >= 0),
  block_number  BIGINT NOT NULL,
  read_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, wallet_address),
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES core.governance_proposals (tenant_id, id)
);

CREATE INDEX governance_vote_weights_proposal_idx
  ON core.governance_vote_weights (proposal_id);

ALTER TABLE core.governance_vote_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_vote_weights FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.governance_vote_weights
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- 스냅숏은 append-only다. 무게를 고칠 수 있으면 결과를 고칠 수 있다.
GRANT SELECT, INSERT ON core.governance_vote_weights TO mpc_app;

CREATE TRIGGER governance_vote_weights_no_delete
  BEFORE DELETE ON core.governance_vote_weights
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();

CREATE OR REPLACE FUNCTION core.reject_weight_update() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '스냅숏된 무게는 수정할 수 없다';
END
$$;

CREATE TRIGGER governance_vote_weights_no_update
  BEFORE UPDATE ON core.governance_vote_weights
  FOR EACH ROW EXECUTE FUNCTION core.reject_weight_update();

/**
 * 스냅숏 블록은 한 번만 정해진다.
 *
 * 투표 중에 블록을 옮기면 이미 던진 표의 무게 근거가 사라진다.
 */
CREATE OR REPLACE FUNCTION core.protect_snapshot_block() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.snapshot_block IS NOT NULL
     AND NEW.snapshot_block IS DISTINCT FROM OLD.snapshot_block THEN
    RAISE EXCEPTION '스냅숏 블록은 정해진 뒤 바꿀 수 없다';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER governance_proposals_snapshot_immutable
  BEFORE UPDATE ON core.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION core.protect_snapshot_block();
