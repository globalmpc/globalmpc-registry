# MPC dApp

BNB Chain anchor와 사용자 대면 Explorer·Workspace.
A BNB Chain anchor with a user-facing Explorer and Workspace.

광산 자산의 기록을 등록·검토·게시하고, **게시된 것만** Merkle root로 묶어 체인에
고정한다. 공개 Explorer에서 누구나 증명을 다시 계산해 확인할 수 있다.

Records for mining assets are registered, reviewed, and published; only what is
published is folded into a Merkle root and anchored on-chain. Anyone can recompute
the proof from the public Explorer.

`design-system/`은 문서가 아니라 **런타임 의존**이다 — 웹이
`link:../../design-system`으로 참조하고 `apps/web/src/app/globals.css`가 그 CSS를
import한다. 위치를 옮기면 빌드가 깨진다.

`design-system/` is a **runtime dependency**, not documentation: the web app
references it through `link:../../design-system` and imports its CSS.

주석이 쓰는 `spec 05 §5.3`·`OD-17` 같은 표기는 [`docs/spec-sections.md`](docs/spec-sections.md)에
정리돼 있다.

## 지금 있는 것

**계약 패키지**

| 패키지 | 내용 | 테스트 |
|---|---|---|
| `packages/canonical` | JCS 제한 프로파일, leaf 인코딩, Merkle, 골든 벡터 | 88 |
| `packages/domain` | 12개 source result, grade 산출, 상태기계 12종, 불변조건 | 213 |
| `packages/policy` | readiness rule schema, 결정적 평가 엔진 | 44 |
| `packages/db` | 스키마·RLS·append-only guard·composite FK·마이그레이션 checksum | 40 |
| `packages/api-contract` | Zod 계약 → OpenAPI 3.1, SIWE, authorization | 43 |
| `packages/ui` | 상태 표시 매핑, R-04 금지어 lint, 3깊이 일관성 | 37 |
| `packages/config` | 시크릿 참조 해석(`file:`·`env:`), 값 노출 없는 감사 지문 | 14 |
| `packages/storage` | 객체 저장 — 키 규칙, quarantine 상태기계, memory·S3 구현 | 17 |

**앱**

| 앱 | 내용 | 테스트 |
|---|---|---|
| `apps/api` | Fastify 5. SIWE 세션, 업로드·증빙·검토·준비도·Registry·anchor·감사·거버넌스·Authority·출처조회 81개 route | 674 |
| `apps/web` | Next.js 16. Data Room·Verification·준비도·Gate·게시·Anchor·감사·거버넌스·Authority·Explorer. 실지갑 서명 | 단위 20 · E2E 88 |
| `apps/worker` | outbox 발행, anchor 제출·확정·reorg, 일일 가스 상한(O1), Safe 제안·실행 추적, ClamAV 검사 | 92 |

**컨트랙트**

`contracts/` — `RegistryAnchorV1` + deferred 인터페이스 10종, Foundry 테스트 29개(fuzz·invariant 포함).

합계: vitest 1282 + Playwright 88 + Foundry 29 + route 81. (2026-09-14 실측)

## 실행

```bash
pnpm install

# 단위·통합 테스트 (DATABASE_URL 없으면 DB 테스트가 skip된다)
DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm test

# 타입체크 (패키지·앱 전부. 웹은 next typegen을 거쳐 이어서 검사한다)
pnpm typecheck

# OpenAPI 재생성 후 드리프트 확인
pnpm check:openapi

# 브라우저 E2E (API·웹을 자동 기동)
# DB는 E2E 전용을 쓴다. compose가 만들지 않으므로 처음 한 번만 직접 만든다.
createdb -h localhost -p 55432 -U postgres mpc_e2e
pnpm --filter @mpc/web test:e2e

# 컨트랙트
cd contracts && forge test

# 컨테이너로 전체 스택 (Postgres·MinIO·ClamAV·anvil·API·worker 2종·web)
docker compose up --build

# 체인 확정까지 포함한 E2E (anvil·anchor worker 필요)
E2E_CHAIN=1 pnpm --filter @mpc/web exec playwright test anchor-chain
```

### 골든 경로

R1에서 다음 구간이 코드로 관통한다.

```
SIWE 로그인 → 프로젝트 등록 → Source Receipt → Claim(grade 자동 산출)
→ Verification Case(evidence snapshot 고정) → EIP-712 서명
→ Readiness 평가 → Gate Decision → Registry 게시 → Merkle batch
→ 체인 제출 → 확정 깊이 충족 → 무인증 Explorer 조회 → inclusion proof
```

`included`가 참이 되는 것은 **확정 이후**다. batch 생성 시점에는 `created`이고,
블록에 들어간 `included` 상태에서도 아직 거짓이다(06 §6.8).

각 단계는 `apps/api/test/`의 통합 테스트가 검증하고, `apps/web/e2e/golden-path.spec.ts`가
같은 흐름을 브라우저에서 한 시나리오로 관통한다 — 단계마다 역할이 바뀌는 것까지 포함한다.

### 로컬 스택 띄우기

```bash
# 1) PostgreSQL
initdb -D ./.pgdata -U postgres --auth=trust
pg_ctl -D ./.pgdata -o "-p 5432 -c unix_socket_directories=/tmp" start
createdb -h localhost -U postgres mpc_dev
DATABASE_URL="postgres://postgres@localhost:5432/mpc_dev" pnpm --filter @mpc/db migrate

# 2) 앱 role
psql "postgres://postgres@localhost:5432/mpc_dev" -c \
  "CREATE ROLE mpc_app_login LOGIN PASSWORD 'app' IN ROLE mpc_app;
   GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login;"

# 3) 데모 계정 키를 만든다. 저장소에는 없다(`apps/web/src/lib/session.tsx`).
#    seed와 웹이 **같은 값**을 봐야 한다 — 다르면 화면의 계정과 역할이 붙은
#    주소가 어긋나고, 로그인은 되는데 아무 권한이 없는 상태가 된다.
export MPC_DEMO_KEYS=$(node -e 'const c=require("node:crypto");
const labels=["Operator A","Operator B","Operator C","Reader A","Steward A",
  "Approver A","Reviewer A","Proposer A","Voter A","Scan Service"];
console.log(JSON.stringify(Object.fromEntries(
  labels.map((l)=>[l,"0x"+c.randomBytes(32).toString("hex")]))))')

# 4) 데모 계정 seed
DATABASE_URL="postgres://postgres@localhost:5432/mpc_dev" \
E2E_DEMO_ACCOUNT_KEYS="$MPC_DEMO_KEYS" \
  pnpm --filter @mpc/web seed:e2e

# 5) API
DATABASE_URL="postgres://mpc_app_login:app@localhost:5432/mpc_dev" \
PORT=3001 SIWE_DOMAIN=localhost:3000 SIWE_URI=http://localhost:3000 \
CHAIN_ID=97 SESSION_SECRET="local-dev-session-secret-32chars-min" \
  pnpm --filter @mpc/api start

# 6) 웹
#    3)에서 만든 값을 그대로 준다. 값이 없으면 로그인 화면에 지갑 연결만
#    남는다 — 배포 빌드에 데모 키가 실리지 않게 하는 것이 기본값이다.
NEXT_PUBLIC_DEMO_ACCOUNT_KEYS="$MPC_DEMO_KEYS" pnpm --filter @mpc/web dev

# 7) 로컬 체인과 anchor worker (선택)
#    EOA 제출은 로컬(31337)·BNB testnet(97)에서만 열린다. 그 외 체인에서는
#    ANCHOR_SAFE_ADDRESS를 주면 제안만 만들고, 없으면 아무것도 하지 않는다.
anvil --port 8545 --chain-id 97 --block-time 1 &

cd contracts
ANCHOR_DEPLOYER_KEY=<로컬 전용 키> \
  forge script script/DeployRegistryAnchor.s.sol:DeployRegistryAnchor \
  --rpc-url http://localhost:8545 --broadcast

# worker는 tenant를 가로질러 동작하므로 전용 role로 붙는다(0012).
psql "postgres://postgres@localhost:5432/mpc_dev" -c \
  "CREATE ROLE mpc_worker_login LOGIN PASSWORD 'worker' IN ROLE mpc_worker;
   GRANT USAGE ON SCHEMA core, chain, audit TO mpc_worker_login;
   ALTER ROLE mpc_worker_login BYPASSRLS;"

DATABASE_URL="postgres://mpc_worker_login:worker@localhost:5432/mpc_dev" \
CHAIN_RPC_URL=http://localhost:8545 CHAIN_ID=97 \
ANCHOR_CONTRACT_ADDRESS=<배포된 주소> \
ANCHOR_SIGNER_PRIVATE_KEY=<로컬 전용 키> ANCHOR_CONFIRMATIONS=2 \
  pnpm --filter @mpc/worker start:anchor
```

**체인 id는 스택 전체가 같아야 한다.** API가 기록한 `chain_id`와 worker가 조회하는
체인이 다르면 트랜잭션이 영원히 집히지 않는다.

http://localhost:3000 에서 데모 계정으로 확인할 수 있다(`NEXT_PUBLIC_DEMO_ACCOUNT_KEYS`를
준 실행에서만 보인다). 역할이 나뉘어 있으므로 한
계정으로 전 구간을 돌 수 없다 — Operator A(등록·게시), Steward A(증빙·claim·검토 배정),
Reviewer A(서명), Approver A(gate 결정), Operator B(다른 tenant), Operator C(빈 상태),
Reader A(역할 없음).

## 의존성 버전 고정

`package.json`의 `pnpm.overrides`가 `viem`·`@aws-sdk/*`·`@smithy/*`를 정확한 버전으로
묶는다. 취향이 아니라 **supply-chain 정책** 때문이다.

pnpm이 `minimumReleaseAge`로 최근 배포된 패키지를 거절한다 — 악성 코드가 섞인
릴리스는 대개 며칠 안에 드러나므로, 갓 나온 버전을 자동으로 끌어오지 않는 것이
방어다. 범위 지정(`^2.21.0`)으로 두면 설치 시점에 따라 lockfile에 정책을 통과하지
못하는 버전이 들어가고, 로컬은 캐시로 통과하는데 **clean install(CI·이미지 빌드)만
깨진다.**

의존성을 올릴 때는 배포 시각을 확인한다.

```bash
npm view <package> time --json | jq 'to_entries | last'
```

## 의존 방향

```
canonical ← domain ← policy ← api-contract ← apps/api
                  ↖ db ← apps/worker
                  ↖ ui ← apps/web
```

역방향 의존을 금지한다. `ui`는 `db`를 참조하지 않는다.

## 이 저장소가 강제하는 것

기획 문서의 서술이 아니라 **코드와 제약으로** 고정한 항목이다. 우회하려면 테스트가
깨지거나 DB가 거절한다.

- canonical payload에 JSON number를 쓸 수 없다 → 부동소수점 재현성 문제 원천 차단
- anchor batch의 root는 어떤 권한으로도 바꿀 수 없다 → Foundry invariant 8192회 검증
- `audit.events`는 superuser도 UPDATE/DELETE할 수 없다 → 트리거
- readiness assessment는 UPDATE 자체가 불가능하다 → 트리거 + API에 PATCH 경로 없음
- `limitations`가 빈 attestation은 저장되지 않는다 → DB CHECK 제약
- public projection은 allowlist 밖 필드를 거절한다 → Zod `.strict()`
- 12개 source result는 DB enum이다 → 별칭·병합 불가
- protocol governance는 project disposition을 제안할 수 없다 → 도메인·API·컨트랙트 3중
- **tenant 경계를 넘는 참조를 만들 수 없다** → composite FK. PostgreSQL의 FK 검사는
  RLS를 우회하므로 `(tenant_id, id)` 복합키로 DB가 직접 막는다
- **계약과 구현이 갈라질 수 없다** → `contract-parity` 테스트가 양방향 대조
- **인증은 SIWE 서명뿐이다** → 개발용 wallet 헤더 경로는 R1에서 제거됐다. 토큰은 서명
  검증 후에만 발급되고, DB에는 해시만 저장되며, 로그아웃하면 즉시 무효가 된다
- **batchId 0을 anchor할 수 없다** → `supersededBy == 0`과 의미가 충돌한다. invariant
  fuzzing이 찾아낸 결함이다
- **API secret이 receipt에 저장되지 않는다** → 인증 방식이 enum이라 토큰 값을 넣을 자리가 없다
- **근거 없는 검토를 만들 수 없다** → evidence snapshot이 비면 case 생성이 거절된다
- **서명 후 근거가 바뀌면 서명이 무효다** → snapshot 해시 비교로 substitution을 막는다
- 감염 판정된 업로드는 evidence로 승격되는 경로가 없다 → 상태기계 도달성 검사
- **하루에 태울 가스 총액을 정하지 않으면 anchor worker가 기동하지 않는다** →
  `ANCHOR_DAILY_SPEND_CAP_WEI`에 기본값이 없다(O1)
- **블록 포함을 확정으로 표시할 수 없다** → `included`는 확정 깊이를 채우기 전까지
  `confirmed`가 아니고, DB CHECK가 block 정보 없는 `confirmed`를 거절한다
- **뒤집힌 확정을 지울 수 없다** → `chain.reorg_events`는 append-only이며 재확정돼도
  남는다. worker role에 UPDATE·DELETE 권한이 없다
- **mainnet에서 EOA가 단독으로 anchor할 수 없다** → 허용 체인 목록이 로컬·testnet만
  포함한다. 컨트랙트의 `ANCHOR_SUBMITTER_ROLE`은 Safe multisig의 것이다
- **가스 지갑이 무한 재시도로 비지 않는다** → 요금 상한과 시도 상한을 넘으면 제출을
  멈춘다(O1의 손실 상한)
- **검토 범위를 사후에 바꿀 수 없다** → `verification_case_claims`에 UPDATE·DELETE
  권한이 없다
- **동시 수정이 앞의 판단을 덮지 않는다** → 버전이 올라가는 mutation은 `If-Match`를
  요구하고, 행을 잠근 뒤 버전을 대조한다. 계약의 `requiresIfMatch`와 실제 거절이
  일치하는지 parity 테스트가 양방향으로 확인한다
- **이유 없이 검토 상태를 바꿀 수 없다** → API 스키마와 DB CHECK가 각각 빈 이유를
  거절하고, 지나온 경로는 `verification_case_transitions`에 append-only로 남는다
- **이의를 제기해도 서명이 지워지지 않는다** → 상태만 `disputed`로 바뀌고
  `payload_hash`·`signature`는 그대로다. 서명 삭제는 잘못된 검토를 감추는 것과
  구분되지 않는다
- **감사 화면이 payload를 노출하지 않는다** → 응답에 `detail` 필드가 없다. 읽기에도
  `audit.read` 권한이 필요하다
- **감사 기록의 역할이 추측이 아니다** → `effective_role`에는 그 행위를 **통과시킨**
  바인딩의 역할이 들어간다. `assertAuthorized`가 그것을 반환하고
  `AuditEntry.effectiveRole`이 필수라, 값을 넘기지 않으면 컴파일되지 않는다.
  권한 판정을 지나지 않는 경로는 역할 이름 대신 `assignment_bound`·`deploy_bound`로
  남는다 — 하지 않은 판정을 한 것처럼 적지 않는다
- **세션의 역할 순서가 실행마다 달라지지 않는다** → `resolve_role_bindings`가
  좁은 바인딩부터 정렬해 돌려준다
- **API 응답이 브라우저에서 문서로 해석되지 않는다** → `default-src 'none'`과
  `frame-ancestors 'none'`을 401·404·429까지 포함한 모든 응답에 붙인다
- **업로드가 곧바로 evidence가 되지 않는다** → quarantine 경로로 들어가고 검사를
  통과해야 승격된다. `scanned_infected → promoted` 경로가 상태기계에 없다
- **저장소 키에 파일명이 들어가지 않는다** → 키는 로그·URL·오류 메시지를 타고 흐른다
- **비밀이 프로세스 환경에 남지 않는다** → `file:` 참조로 마운트된 파일을 읽는다.
  시작 로그에는 값이 아니라 scheme과 12자 지문만 남는다
- **production에서 메모리 저장소로 뜨지 않는다** → `loadConfig`가 시작을 막는다
- **저장 리전에 기본값이 없다** → `OBJECT_STORE=s3`는 `OBJECT_REGION`을 요구한다.
  기본값을 두면 아무도 결정하지 않은 채 어딘가에 저장된다(OD-17). 초안 단계의
  값은 `ap-northeast-2`(한국)이며 prod 전에 재검토한다
- **민감 등급 자료를 받지 않는다** → `confidential`·`pii`·`whistleblower`는 422로
  거절된다. 지금 저장소는 provider 관리 키를 쓰고 tenant별 키 분리와 파기 절차가
  없다. 실제 계약서·개인정보는 secured route가 열린 뒤에 올린다(OD-18)
- **production에서 암호화를 끌 수 없다** → `OBJECT_SSE=none`은 로컬 MinIO 전용이다
- **검사 결과를 화면에서 만들 수 없다** → 검사는 별도 worker가 하고 Data Room에는
  그 버튼이 없다. 스캐너 장애는 감염이 아니라 오류로 기록되어 재시도된다
- **올린 사람이 자기 파일을 통과시킬 수 없다** → `upload.scan_result`는
  `scan_service`만 갖는다. `source.upload`를 재사용하지 않는다
- **표를 무시하고 결과를 선언할 수 없다** → 투표 마감은 집계와 일치해야 하고,
  다르면 `TALLY_MISMATCH`로 거절된다. 마감 뒤 표 변경은 DB 트리거가 막는다
- **투표가 오프체인 사실을 만들지 않는다** → 거버넌스 응답이 매번
  `limitations`로 그것을 밝히고, 금지 대상은 제안 자체가 거절된다
- **미확인 연동을 활성으로 표시하지 않는다** → `pending_access`인 출처는 호출되지
  않고 목록에서도 사라지지 않는다. 왜 안 되는지가 함께 보인다
- **접근성 위반이 0이다** → axe로 8개 화면을 검사하고 위반 0을 강제한다
- **언어를 바꿔 경고를 지울 수 없다** → 경계 문구는 `@mpc/ui`가 원본이고 번역만
  갈린다
- **던지는 사람이 자기 투표 무게를 정할 수 없다** → 스냅숏이 있으면 요청 본문의
  값은 무시된다. 스냅숏 블록과 기록된 무게는 트리거가 수정을 거절한다
- **조회 실패를 잔고 0으로 읽지 않는다** → 0은 "토큰이 없다"는 사실이고 실패는
  "모른다"다. 전자로 기록하면 투표권을 조용히 뺏는다
- **404를 출처 장애로 읽지 않는다** → adapter가 12개 결과로 정규화한다.
  "기록 없음"과 "출처 장애"를 섞으면 없는 기록을 계속 재시도한다
- **claim은 자기 근거를 가리킨다** → `source_receipt_id`. 없으면
  `core.claims_without_evidence`가 드러낸다. 자동으로 지우거나 등급을 낮추지 않는다
- **출처가 내려가면 그 근거의 claim과 attestation이 따라 표시된다** → 0023 트리거.
  검토 상태는 바뀌지 않는다 — 검토는 실제로 있었고 달라진 것은 근거다
- **끝난 attestation은 다시 건드리지 않는다** → `revoked`·`superseded`는 전파
  대상이 아니다. 건드리면 "언제 무엇이 유효했나"가 흐려진다
- **공개 기록이 자동으로 내려가지 않는다** → 근거가 흔들리면 신호만 남고, supersede·
  revoke는 `registry.revoke` 권한을 가진 사람이 판정한다. 연동 하나가 끊겼다고 공개
  기록이 사라지면 출처 장애가 곧 기록 삭제가 된다
- **신호를 닫아도 대상은 바뀌지 않는다** → 한 번의 요청으로 두 가지 일이 일어나면
  무엇이 실행됐는지 나중에 알 수 없다. 실제로 내리려면 revoke를 따로 호출한다
- **거래 route가 존재하지 않는다** → `subscriptions`·`orders`·`transfers`·
  `custody`는 404다. flag 뒤에 숨긴 것이 아니라 만들지 않았다(OD-07)
- **호출 대상 없이 `active`가 될 수 없다** → DB CHECK다. endpoint 없는 API 연동은
  연동이 아니라 연동됐다는 표시다
- **등록부로 가는 요청이 평문으로 나갈 수 없다** → endpoint는 https만 허용하고
  URL 안의 자격증명(`user:pass@`)을 거절한다. 리다이렉트도 따라가지 않는다
- **재시도가 출처를 다시 부르지 않는다** → 외부 호출 전에 Idempotency-Key를
  잡는다. 등록부 rate limit은 우리 재시도 횟수를 모른다
- **등록한 사람은 그 기관을 승인할 수 없다** → 권한이 둘 다 있어도 막힌다.
  02 §2.8이 금지하는 "운영자 단독 accepted 전환"이다
- **승인되지 않은 기관의 연동은 활성이 될 수 없다** → DB 트리거다. 연동을 켜는
  것이 기관 승인이 되지 않는다
- **약한 채널이 쉬운 채널이 아니다** → 수동 확인은 다른 사람의 두 번째 검토가,
  서명 문서는 서명 검증이, bulk export는 스키마 대조가 있어야 확정된다(AC-29)
- **확정의 근거를 올린 사람이 만들지 못한다** → 서명은 서버가 등록된 공개키로
  검증하고, bulk의 필드는 서버가 파일에서 뽑고, API 수집 확정은 서버가 부른
  경로에서만 나온다. DB 제약이 `verifiedBy`·`documentHash`·검증기 버전을
  요구한다(2026-09-10 실사 A1)
- **200과 유효 JSON은 확인이 아니다** → 연동이 선언한 필드가 있어야 확정이다.
  선언이 없으면 사람이 본다. 응답에는 크기 상한이 있다(A7)
- **검사한 주소로만 연결한다** → 이름을 다시 풀지 않는다. 공개 대역(2000::/3)
  밖의 IPv6는 전부 막는다(A2)
- **확정된 트랜잭션이 대기 중인 것을 굶기지 않는다** → 진행이 필요한 상태를 먼저
  집고, 확정 행은 reorg 감시 주기가 지난 것만 다시 본다

## 아직 없는 것

**API**: 계약(`ROUTES`)의 81개 route가 전부 구현됐다. `plannedRoutes()`가 비어 있다.

**미구현 갭**

- **호출할 실제 출처가 없다** — 등록·승인·연동 구성·조회까지 운영 경로가 다
  있지만 OD-42의 접근 권한이 확인되지 않아 등록할 대상이 없다. `pending_access`인
  연동은 호출되지 않고, 호출 대상 없는 연동은 DB 제약이 `active`를 막는다.
- **민감 자료를 아직 받지 못한다** — OD-18의 초안 결정에 따라 저장 경로가 하나뿐이고
  민감 등급은 거절된다. secured route는 tenant 키 분리·rotation·crypto-shredding을
  함께 정할 때 만든다.
- **거버넌스 토큰이 배포되지 않았다** — 스냅숏 코드는 있고
  `GOVERNANCE_TOKEN_ADDRESS`가 없으면 수동 무게로 떨어진다. 응답의
  `weightSource`가 어느 쪽인지 밝힌다. 아카이브 노드도 필요하다(OD-24).
- **Safe 실행은 사람이 한다** — worker는 제안을 올리고 실행 결과를 되읽지만
  서명 수집과 실행은 Safe owner들이 한다. 그 분리가 설계다.
- **Asset/Offering 거래 기능이 없다** — OD-07이 "구현하거나 숨겨 두지 않는다"고
  정했다. activation gate만 있고, 남은 조건과 담당을 화면이 보여준다.
- **anchor signer 지갑의 충전 상한은 코드가 강제하지 못한다** — 하루 소진 상한은
  `ANCHOR_DAILY_SPEND_CAP_WEI`로 막지만, 지갑에 얼마를 넣어 둘지는 재무·운영
  절차다(`deploy/README.md`).
- **성능 목표가 없다** — `throughput.test.ts`가 측정하고 출력하지만 통과 기준은
  `PERF_MAX_P95_MS`로 주기 전까지 없다. OD-32가 정해지면 CI 환경변수로 넣는다.
- **ClamAV를 E2E에 띄우지 않는다** — 시그니처 DB 다운로드가 테스트 시간을
  지배한다. arm64는 `deploy/clamav/`에서 직접 만든 이미지로 네이티브로 돈다
  (2026-08-28). 예전의 "amd64 전용" 설명은 그 시점에 낡았다.

prod 배포는 OD-17(데이터 관할)·OD-18(키 소유권)이 해소되기 전까지 하지 않는다.

## 라이선스 / License

- 코드 / Code: [Apache License 2.0](LICENSE)
- MPC 이름·로고는 라이선스에서 제외된다 / The MPC name and logos are excluded —
  [`TRADEMARK.md`](TRADEMARK.md)
- vendored 라이브러리는 각자의 라이선스를 따른다 / Vendored libraries keep their own licenses

## 보안 / Security

취약점은 공개 이슈가 아니라 [`SECURITY.md`](SECURITY.md)의 절차로 비공개 신고한다.
Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## 기여 / Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md).
