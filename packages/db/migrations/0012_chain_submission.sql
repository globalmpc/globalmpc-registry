-- 체인 제출 추적 — spec 06 §6.8, 08 §8.9
--
-- `chain.transactions`에는 지금까지 tx_hash·block_number·state만 있었다. 그것으로는
-- 세 가지를 구분할 수 없다.
--
-- 1. **reorg와 정상 확정** — block_number만 보면 같은 높이의 다른 블록으로 바뀐 것을
--    탐지하지 못한다. 확정으로 표시한 뒤 조용히 사라지는 것이 최악이다.
-- 2. **재시도 가능한 실패와 영구 실패** — 마지막 오류가 남지 않으면 운영자는 왜
--    멈췄는지 모른 채 재시도만 반복한다.
-- 3. **제출 시각과 확정 시각** — 둘이 같으면 지연을 관측할 수 없다.
--
-- 상태는 created → submitted → included → confirmed 로만 전진한다. `included`는
-- 성공이 아니다. 확정 깊이를 채운 `confirmed`만 성공이며, 그 전까지 공개 증명의
-- `included` 필드는 false다.

ALTER TABLE chain.transactions
  -- reorg 판정의 근거. 같은 높이에 다른 hash가 있으면 우리가 본 블록은 사라졌다.
  ADD COLUMN block_hash TEXT CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN submitted_at TIMESTAMPTZ,
  ADD COLUMN confirmed_at TIMESTAMPTZ,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  -- 마지막 실패 사유. 다음 행동을 정하는 데 필요하다.
  ADD COLUMN last_error TEXT,
  ADD COLUMN gas_used BIGINT,
  ADD COLUMN effective_gas_price NUMERIC(78, 0);

-- 확정된 트랜잭션은 block 정보를 반드시 갖는다. 근거 없이 confirmed로 표시하는
-- 경로를 DB가 거절한다 — 애플리케이션 버그가 조용한 거짓 확정이 되지 않게 한다.
ALTER TABLE chain.transactions
  ADD CONSTRAINT transactions_confirmed_requires_block CHECK (
    state <> 'confirmed'
    OR (tx_hash IS NOT NULL AND block_number IS NOT NULL AND block_hash IS NOT NULL)
  );

-- 제출된 트랜잭션은 hash를 갖는다. hash 없는 submitted는 제출 여부를 알 수 없는
-- 상태이며, 그것은 `created`로 남아 있어야 한다.
ALTER TABLE chain.transactions
  ADD CONSTRAINT transactions_submitted_requires_hash CHECK (
    state NOT IN ('submitted', 'included', 'confirmed') OR tx_hash IS NOT NULL
  );

CREATE INDEX transactions_pending_idx
  ON chain.transactions (state, created_at)
  WHERE state IN ('created', 'submitted', 'included');

/**
 * reorg 기록.
 *
 * 확정으로 봤던 블록이 사라진 사건은 지우지 않고 남긴다. 재제출로 결과가 같아지더라도
 * "한 번 뒤집혔다"는 사실 자체가 공개 이력의 신뢰도를 판단하는 근거다.
 */
CREATE TABLE chain.reorg_events (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  transaction_id    UUID NOT NULL REFERENCES chain.transactions(id),
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_block_number BIGINT NOT NULL,
  previous_block_hash   TEXT NOT NULL CHECK (previous_block_hash ~ '^0x[0-9a-f]{64}$'),
  detected_state    TEXT NOT NULL
);

ALTER TABLE chain.reorg_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.reorg_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chain.reorg_events
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON chain.reorg_events TO mpc_app;

-- reorg 관측은 사후에 지울 수 없다. UPDATE·DELETE 권한을 주지 않는 것이 통제다.

-- ---------------------------------------------------------------------------
-- 백그라운드 worker role
--
-- anchor 제출과 outbox 발행은 **여러 tenant의 행을 가로질러** 처리하는 시스템
-- 과정이다. 요청 하나가 한 tenant에 속하는 API와 다르다.
--
-- 지금까지 worker는 superuser 연결로 동작했다. RLS를 우회한다는 점은 같지만
-- superuser는 그 외 모든 것도 할 수 있다 — 스키마 변경, role 생성, 다른 DB 접근.
-- 우회 범위를 필요한 만큼으로 좁힌 전용 role을 둔다.
DO $$
BEGIN
  CREATE ROLE mpc_worker NOLOGIN BYPASSRLS;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA core, chain, audit TO mpc_worker;
-- outbox 발행: 읽고 published_at을 찍는다.
GRANT SELECT, UPDATE ON core.outbox TO mpc_worker;
-- anchor 제출: 트랜잭션 상태를 전진시키고 reorg를 기록한다.
GRANT SELECT, UPDATE ON chain.transactions TO mpc_worker;
GRANT SELECT ON chain.anchor_batches, chain.anchor_batch_leaves TO mpc_worker;
GRANT INSERT ON chain.reorg_events TO mpc_worker;
-- 도메인 데이터에 대한 쓰기 권한은 주지 않는다. worker는 체인 상태만 다룬다.
