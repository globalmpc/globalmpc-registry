# 인수 기준 → 코드·테스트 매핑

제품 명세의 인수 기준(AC)과 요구사항(REQ-DAPP)을 실제 파일에 연결한다.
Definition of Done의 "traceability의 Code/Test 열 연결"이 이 문서다.
식별자 표기는 [`spec-sections.md`](spec-sections.md).

**"미착수"는 해당 release에서 다룬다는 뜻이다.** 지금 범위는 계약 산출물이므로
apps 구현이 필요한 항목은 여기서 닫지 않는다.

## 도메인 인수 기준

| AC | 내용 | 구현 | 테스트 |
|---|---|---|---|
| AC-01 | limitations 없는 서명 차단 | `packages/domain/src/attestation.ts`<br>`packages/db/migrations/0001_schema.sql` (CHECK)<br>`packages/api-contract/src/resources.ts` | `domain/test/attestation.test.ts`<br>`db/test/schema.test.ts`<br>`api-contract/test/contract.test.ts` |
| AC-02 | 필수 gap이 go 차단 | `packages/domain/src/readiness.ts` | `domain/test/readiness.test.ts`<br>`policy/test/engine.test.ts` |
| AC-03 | all ok가 자동 go 아님 | `packages/domain/src/readiness.ts`<br>`packages/domain/src/machines.ts` | `domain/test/readiness.test.ts` |
| AC-04 | revocation 전파 | `packages/db/migrations/0001_schema.sql` (lineage_edges) | `db/test/schema.test.ts` (recursive CTE) |
| AC-05 | cross-governance 차단 | `packages/domain/src/governance.ts`<br>`contracts/src/interfaces/IDeferredContracts.sol` | `domain/test/governance.test.ts` |
| AC-06 | 온체인 성공 ≠ 오프체인 집행 | `packages/domain/src/machines.ts` (proposalMachine) | `domain/test/machines.test.ts` |
| AC-07 | whitelist 격리 | `contracts/src/interfaces/IDeferredContracts.sol` | R6 착수 시 |
| AC-08 | Reference pending | `packages/db` project_facts | apps 착수 시 |
| AC-09 | integrity disclaimer | `packages/api-contract/src/resources.ts` | `api-contract/test/contract.test.ts` |
| AC-10 | supply·vesting invariant | `contracts/src/interfaces/IDeferredContracts.sol` (인터페이스만) | 별도 release |
| AC-11 | 평가 결정성 | `packages/canonical/src/jcs.ts`<br>`packages/policy/src/engine.ts` | `canonical/test/determinism.property.test.ts`<br>`policy/test/engine.test.ts` |
| AC-12 | credential 만료 | `packages/domain/src/attestation.ts` | `domain/test/attestation.test.ts` |
| AC-13 | source license | `packages/domain/src/disclosure.ts` | `domain/test/disclosure.test.ts` |
| AC-14 | government take 의미 분리 | `packages/db` claims.claim_type | apps 착수 시 |
| AC-15 | authority scope 밖 차단 | `packages/domain/src/attestation.ts` | `domain/test/attestation.test.ts` |
| AC-16 | signature valid ≠ authority accepted | `packages/domain/src/attestation.ts` | `domain/test/attestation.test.ts` |
| AC-17 | 서명 당시 credential 상태 보존 | `packages/domain/src/attestation.ts`<br>`packages/db` credential_status_snapshot | `domain/test/attestation.test.ts`<br>`db/test/schema.test.ts` |
| AC-18 | no record ≠ unavailable ≠ N/A | `packages/domain/src/source-result.ts`<br>`packages/ui/src/status-display.ts` | `domain/test/source-result.test.ts`<br>`ui/test/ui-contract.test.ts` |
| AC-19 | schema drift | `packages/domain/src/source-result.ts`<br>`packages/domain/src/machines.ts` | `domain/test/source-result.test.ts`<br>`domain/test/machines.test.ts` |
| AC-20 | raw/normalized 불일치 | `packages/db` artifacts.kind | apps 착수 시 |
| AC-21 | 변경 전파 | `packages/db` lineage_edges | `db/test/schema.test.ts` |
| AC-22 | public/private/onchain 분리 | `packages/domain/src/disclosure.ts`<br>`packages/api-contract/src/resources.ts`<br>`packages/canonical/src/leaf.ts` | `domain/test/disclosure.test.ts`<br>`api-contract/test/contract.test.ts` |
| AC-23 | inclusion proof 한계 | `packages/api-contract/src/resources.ts`<br>`packages/canonical/src/merkle.ts` | `api-contract/test/contract.test.ts`<br>`canonical/test/merkle.test.ts` |
| AC-24 | Mongolia manual 운영 | `packages/domain/src/source-result.ts` (collection method) | R5 착수 시 |
| AC-25 | jurisdiction portability | `packages/policy/src/rule-schema.ts` (jurisdictionProfile) | R7 착수 시 |
| AC-26 | 3깊이 일관성 | `packages/ui/src/record-depth.ts`<br>`apps/web/src/app/explorer/page.tsx` | `ui/test/ui-contract.test.ts`<br>`web/e2e/golden-path.spec.ts` |
| AC-27 | key·credential 복구 | `packages/db` wallet_identities | apps 착수 시 |
| AC-28 | DID·ZK 비의존 | 전체 — DID·ZK 의존성 없음 | 의존성 스캔 (CI 추가 예정) |
| AC-29 | evidence channel parity | `packages/domain/src/source-result.ts` (COLLECTION_METHODS) | `domain/test/source-result.test.ts` |
| AC-30 | 중대정보 blackout | `packages/domain/src/disclosure.ts`<br>`packages/db` disclosure_restrictions | `domain/test/disclosure.test.ts` |
| AC-31 | R-04 금지어 lint | `packages/ui/src/prohibited-language.ts` | `ui/test/ui-contract.test.ts` |
| AC-32 | 자연인 식별자 차단 | `packages/domain/src/disclosure.ts` | `domain/test/disclosure.test.ts` |
| AC-33 | ERSP status ≠ legal effect | `packages/api-contract/src/common.ts` (legalEffect) | `api-contract/test/contract.test.ts` |
| AC-34 | not_evaluable 차단 | `packages/domain/src/readiness.ts`<br>`packages/policy/src/engine.ts` | `domain/test/readiness.test.ts`<br>`policy/test/engine.test.ts` |

## 스마트컨트랙트 invariant (§13.5)

| invariant | 상태 | 테스트 |
|---|---|---|
| Registry root overwrite/delete 불가 | 구현 | `contracts/test/RegistryAnchorInvariants.t.sol::invariant_rootNeverChanges` |
| revoked/superseded는 새 event로만 | 구현 | `invariant_revokedBatchesRetainRoot` |
| pause가 root·history를 바꾸지 않음 | 구현 | `RegistryAnchorV1.t.sol::test_pause_blocksSubmissionOnly` |
| privileged call이 root를 못 바꿈 | 구현 | `test_noFunctionCanMutateStoredRoot` |
| 빈 batch 거절 | 구현 | `invariant_noEmptyBatchStored` |
| totalSupply 100억 고정 | 인터페이스만 | 별도 release |
| bucket 합계 = total supply | 인터페이스만 | 별도 release |
| TGE 13.5% | 인터페이스만 | 별도 release |
| cumulative vesting 단조 증가 | 인터페이스만 | 별도 release |
| protocol governor target allowlist | 인터페이스만 | 별도 release |
| AccessRegistry ≠ ComplianceAdapter | 인터페이스만 | 별도 release |

## 보안 인수 기준 (§13.6)

| 항목 | 상태 | 근거 |
|---|---|---|
| cross-tenant query/mutation 0건 | 검증됨 | `db/test/schema.test.ts` — RLS를 app role로 실측 |
| public API·chain event에 PII/secret 0건 | 계약 수준 검증 | `api-contract` `.strict()` projection, `canonical/leaf.ts` |
| audit 삭제 불가 | 검증됨 | `db/test/schema.test.ts` — superuser도 차단 |
| readiness override 불가 | 검증됨 | `db/test/schema.test.ts` + API에 경로 없음 |
| webhook replay 차단 | 미착수 | R2 |
| key rotation 후 구키 차단 | 미착수 | R0 apps |
| RPC split/reorg에서 false confirmed 없음 | 상태기계만 | R3 apps |

## 아직 코드로 닫히지 않은 것

- 골든 경로 E2E (`source → ... → proof`) — apps 구현이 필요하다
- 성능 목표 (§13.7) — OD-32 미해소로 수치가 없다
- 접근성 테스트 (§13.8) — apps/web 착수 시
- AC-28 의존성 스캔 CI — 현재는 의존성이 없다는 사실만 있고 자동 검사가 없다
