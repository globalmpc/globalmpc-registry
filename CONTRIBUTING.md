# 기여 / Contributing

## 먼저 알아 둘 것 / Before you start

이 저장소는 **발행 전 단계의 금융 상품을 서술하는 코드**다. 잘못된 문장 하나가
나쁜 문장이 아니라 컴플라이언스 문제가 된다. 그래서 화면 문구·API 메시지에
금지 표현 검사(`pnpm check:copy`)가 CI 게이트로 걸려 있다.

This repository describes a **pre-issuance financial product**. A wrong sentence is
a compliance problem, not just bad prose — prohibited-language linting runs as a CI
gate over UI copy and API messages.

제품 명세 본문은 공개하지 않는다. 주석이 쓰는 `spec 05 §5.3`·`OD-17` 같은 표기는
[`docs/spec-sections.md`](docs/spec-sections.md)가 설명한다. **주석을 읽는 데
명세가 필요하지 않도록** 쓰는 것이 이 저장소의 규칙이다.

The specification documents themselves are not published. Identifier notation is
explained in [`docs/spec-sections.md`](docs/spec-sections.md); comments are written
so that you never need the specification to read them.

## 우회하지 않는 것 / Invariants

`README.md`의 "이 저장소가 강제하는 것"은 문서가 아니라 **테스트·DB 제약·컨트랙트
invariant**로 고정돼 있다. 그것을 푸는 변경은 받지 않는다. 풀어야 한다고 판단되면
먼저 이슈로 근거를 말한다.

Those guarantees are held by tests, database constraints, and contract invariants.
Changes that unwind them are not accepted — open an issue with the reasoning first.

특히:

- 준비도 결과를 고치는 경로를 만들지 않는다
- 확정된 anchor root를 바꾸는 경로를 만들지 않는다
- 거래·수탁·주문 경로를 만들지 않는다 — 권한 뒤에 숨기는 것도 같다
- 미확정 결정(`OD-nn`)이 막는 것을 임의의 기본값으로 열지 않는다
- canonical serialization·Merkle 규격을 바꾸면 이미 anchor된 root를 재현할 수 없다.
  바꿔야 한다면 `serializationVersion`을 올린다

## 개발 / Development

```sh
pnpm install --frozen-lockfile
docker compose up -d                       # Postgres · MinIO · anvil

DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm test
pnpm check                                 # PR 전에 이것이 통과해야 한다
```

`pnpm check`는 타입체크 · 테스트 · OpenAPI 드리프트 · 금지어 · 브랜드 자산 ·
README 수치 · compose 볼륨 경로를 본다. 컨트랙트는 `cd contracts && forge test`.

**DATABASE_URL 없이 돌린 초록은 초록이 아니다.** tenant 격리와 append-only 보장을
검증하는 테스트가 조용히 skip된다.

A green run without `DATABASE_URL` is not green: tenant-isolation and append-only
tests are silently skipped.

## Pull request

- 하나의 PR은 하나를 한다. 정리와 기능 변경을 섞지 않는다
- 동작을 바꿨으면 **그 동작이 틀렸을 때 실패하는 테스트**를 함께 낸다
- 테스트 수를 바꿨으면 `pnpm check:counts --write`로 README를 맞춘다
- 주석에는 "무엇"이 아니라 **왜**를 적는다. 코드가 이미 무엇인지 말한다
- 커밋 메시지는 무엇을 왜 바꿨는지 본문에 적는다

## 보안 / Security

취약점은 이슈·PR·토론에 올리지 않는다. [`SECURITY.md`](SECURITY.md)의 비공개
경로로 신고한다.

Do not report vulnerabilities in issues, pull requests, or discussions — use the
private process in [`SECURITY.md`](SECURITY.md).

## 라이선스 / License

기여물은 [Apache License 2.0](LICENSE)으로 배포된다. MPC 이름과 로고는 그
라이선스에 포함되지 않는다([`TRADEMARK.md`](TRADEMARK.md)).

Contributions are released under the [Apache License 2.0](LICENSE). The MPC name
and logos are not covered — see [`TRADEMARK.md`](TRADEMARK.md).
