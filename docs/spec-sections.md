# 명세 절 번호와 식별자 표기

코드 주석이 `spec 05 §5.3`이나 `OD-17`처럼 짧은 식별자로 근거를 가리킨다. 그
표기가 무엇을 뜻하는지 여기에 모아 둔다.

**명세 본문은 이 저장소에 없다.** 여기 있는 것은 번호와 제목의 대응이며, 각
주석은 그 자리에서 필요한 내용을 함께 적는다 — 주석을 읽는 데 명세가 필요하지
않도록 쓴다.

## `spec NN §N.N` — 명세 문서 번호

| 번호 | 문서 |
|---|---|
| 01 | Product scope |
| 02 | Roles and permissions |
| 03 | User journeys |
| 04 | Domain and state model |
| 05 | Data and registry model |
| 06 | System architecture |
| 07 | API and events |
| 08 | Smart contracts |
| 09 | Governance |
| 10 | Security, privacy, compliance |
| 11 | UX and information architecture |
| 12 | Delivery roadmap |
| 13 | Testing and acceptance |

## 식별자

| 표기 | 뜻 |
|---|---|
| `OD-nn` | **Open decision** — 아직 확정되지 않은 결정. 값이 정해지지 않아 코드가 **거절하는 동작**의 근거다. 사용자 화면(`/legal`·`/asset-registry`)이 이 번호를 그대로 보여 준다 |
| `AC-nn` | **Acceptance criterion** — 인수 기준. 코드·테스트 대응은 [`acceptance-code-map.md`](acceptance-code-map.md) |
| `REQ-DAPP-nnn` | 요구사항 번호 |
| `ADR-Tnn` | 기술 결정 기록(Architecture Decision Record) |
| `D-nn` | 설계 원칙 번호 |
| `R-04` | 금지 표현 규칙. 정본 목록은 `packages/ui/src/prohibited-language.ts` |
| `R0`~`R7` | 릴리스 단계 |

`OD-nn`이 코드에 남아 있는 것은 미완성의 표시가 아니라 **의도된 거절의 근거**다.
예를 들어 `OD-17`(데이터 관할)과 `OD-18`(암호화 키 소유권)이 해소되지 않았기
때문에 업로드가 `confidential`·`pii` 등급을 422로 거절한다. 결정이 서기 전까지
그 경로를 만들지 않는 것이 이 저장소의 방식이다.
