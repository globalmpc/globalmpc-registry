-- 정족수의 분모 — spec 09 §9.6, 04 §4.5
--
-- 지금까지 정족수는 **던진 표의 합**을 분모로 계산했다. 그러면
-- `참여 × D >= 참여 × N`이 N ≤ D인 한 항상 참이라 정족수가 통과만 한다.
-- `no_quorum`이 구조적으로 나올 수 없고, 한 표만 있어도 마감된다.
--
-- 09 §9.6은 "no quorum은 defeated와 다른 상태"를 요구한다. 참여가 부족한 것과
-- 반대가 많은 것은 다음에 할 일이 다르다 — 전자는 다시 알리는 것이고 후자는
-- 제안을 고치는 것이다.
--
-- 분모는 **투표를 열 때 고정**한다. 토큰이 연결돼 있으면 스냅숏 블록의
-- 총공급이고, 아니면 사람이 넣은 값이다. 어느 쪽인지 감추지 않는다.

ALTER TABLE core.governance_proposals
  -- 투표할 수 있었던 전체 무게. decimal string으로 다룬다(ADR-T07).
  --
  -- 0을 막는다. `참여 × D >= 0 × N`은 항상 참이라 분모를 두고도 정족수가
  -- 통과만 하는 상태로 되돌아간다.
  ADD COLUMN eligible_weight NUMERIC(78, 0) CHECK (eligible_weight > 0),
  -- 분모가 어디서 왔는가. NULL이면 아직 고정되지 않았다.
  ADD COLUMN eligible_weight_source TEXT
    CHECK (eligible_weight_source IN ('onchain_total_supply', 'manual'));

-- 출처가 정해졌으면 값도 있어야 한다. 하나만 있으면 근거를 알 수 없다.
ALTER TABLE core.governance_proposals
  ADD CONSTRAINT eligible_weight_source_requires_value CHECK (
    eligible_weight_source IS NULL OR eligible_weight IS NOT NULL
  );

/**
 * 고정된 분모는 바뀌지 않는다.
 *
 * 분모를 고칠 수 있으면 결과를 고칠 수 있다. 제안 생성 시점의 값은 아직
 * 후보이므로(`eligible_weight_source IS NULL`) 투표를 열기 전까지는 고칠 수 있다.
 */
CREATE OR REPLACE FUNCTION core.protect_eligible_weight() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.eligible_weight_source IS NOT NULL
     AND (NEW.eligible_weight IS DISTINCT FROM OLD.eligible_weight
          OR NEW.eligible_weight_source IS DISTINCT FROM OLD.eligible_weight_source) THEN
    RAISE EXCEPTION '고정된 정족수 기준은 바꿀 수 없다';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER governance_proposals_eligible_weight_immutable
  BEFORE UPDATE ON core.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION core.protect_eligible_weight();
