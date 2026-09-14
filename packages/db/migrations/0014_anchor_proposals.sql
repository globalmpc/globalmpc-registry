-- Safe multisig 제안 — spec 08 §8.9, 컨트랙트 ANCHOR_SUBMITTER_ROLE
--
-- `RegistryAnchorV1`의 `ANCHOR_SUBMITTER_ROLE`은 Safe multisig가 보유한다.
-- EOA 단독 submitter를 두지 않는 것이 "MPC 자신도 확정된 공개 이력을 단독으로
-- 조용히 교체할 수 없다"의 근거다.
--
-- 그런데 worker는 EOA로만 제출할 수 있다. 그래서 두 경로로 나눈다.
--
-- - 로컬·testnet: worker가 EOA로 직접 제출한다(개발 편의).
-- - 그 외: worker가 **제안만 만들고 실행하지 않는다.** 서명 수집과 실행은
--   Safe 쪽에서 사람이 한다.
--
-- 제안이 만들어졌다는 것은 제출됐다는 뜻이 아니다. 두 상태를 구분하지 않으면
-- "올렸다"고 믿는 사이 아무것도 체인에 없는 상태가 된다.

CREATE TABLE chain.anchor_proposals (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  transaction_id  UUID NOT NULL REFERENCES chain.transactions(id),
  chain_id        INTEGER NOT NULL,
  safe_address    TEXT NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  -- 실행될 calldata. Safe에서 서명할 대상이며 여기서 만든 것과 달라지면 안 된다.
  calldata        TEXT NOT NULL CHECK (calldata ~ '^0x[0-9a-f]+$'),
  -- 제안 내용의 해시. Safe UI에서 본 것과 대조하는 데 쓴다.
  calldata_hash   TEXT NOT NULL CHECK (calldata_hash ~ '^0x[0-9a-f]{64}$'),
  state           TEXT NOT NULL DEFAULT 'proposed'
                    CHECK (state IN ('proposed', 'executed', 'rejected', 'expired')),
  -- 외부 Safe 서비스의 식별자. 우리가 만들지 않으므로 nullable이다.
  safe_tx_hash    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

-- 같은 트랜잭션에 **활성** 제안은 하나뿐이다. 둘이면 서명자들이 어느 것을
-- 실행해야 할지 모르고, 둘 다 실행되면 같은 root가 두 번 올라간다.
-- 해소된(executed·rejected·expired) 제안은 여러 개 남을 수 있다 — 이력이다.
CREATE UNIQUE INDEX anchor_proposals_one_active_idx
  ON chain.anchor_proposals (transaction_id) WHERE state = 'proposed';

CREATE INDEX anchor_proposals_pending_idx
  ON chain.anchor_proposals (chain_id, state) WHERE state = 'proposed';

ALTER TABLE chain.anchor_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.anchor_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chain.anchor_proposals
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON chain.anchor_proposals TO mpc_app;
GRANT SELECT, INSERT, UPDATE ON chain.anchor_proposals TO mpc_worker;

-- transaction_state에 'proposed'를 추가한다. created(아직 아무것도 안 함)와
-- submitted(체인에 보냈다) 사이의 상태다. 이것 없이 created에 머물면 "왜 안
-- 올라가나"를 알 수 없고, submitted로 표시하면 있지도 않은 트랜잭션을 기다린다.
ALTER TYPE chain.transaction_state ADD VALUE IF NOT EXISTS 'proposed' AFTER 'created';
