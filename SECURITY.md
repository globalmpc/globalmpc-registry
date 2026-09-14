# Security Policy / 보안 정책

## 취약점 신고 / Reporting a vulnerability

**공개 이슈·PR·토론에 올리지 않는다.** GitHub 저장소의 **Security → Report a vulnerability**
(private vulnerability reporting)로 비공개 신고한다.

**Do not open a public issue, pull request, or discussion.** Report privately through
**Security → Report a vulnerability** (GitHub private vulnerability reporting) on this repository.

신고에 담을 것 / Please include:

- 영향받는 구성요소와 커밋 / affected component and commit
- 재현 절차(최소 입력) / reproduction steps (minimal input)
- 예상 영향 / expected impact

접수 뒤 진행 상황은 해당 advisory 안에서 알린다. 수정이 배포되기 전까지 내용을 공개하지 않기를 요청한다.
We will follow up inside the advisory. Please keep details private until a fix is released.

## 범위 / Scope

| 대상 / In scope | 경로 / Path |
|---|---|
| 스마트컨트랙트 / Smart contracts | `contracts/src/` |
| API · Web · Worker | `apps/` |
| 공용 패키지 / Shared packages | `packages/` |
| 배포 설정 / Deployment configuration | `Dockerfile`, `docker-compose.yml`, `deploy/` |

범위 밖 / Out of scope:

- `contracts/lib/` — vendored 외부 라이브러리(OpenZeppelin, forge-std). 원 저장소에 신고한다.
  Vendored third-party code; report upstream.
- `deploy/local-secrets/` — 공개된 로컬 전용 기본값(anvil 기본 계정 키, MinIO 기본 자격증명)이다.
  Publicly known local-only defaults (anvil default account key, MinIO default credentials).

## 지원 버전 / Supported versions

`main` 브랜치의 최신 커밋만 지원한다. / Only the latest commit on `main` is supported.
