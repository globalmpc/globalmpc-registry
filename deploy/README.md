# 배포 구성

이 디렉터리는 `docker-compose.yml`이 로컬 스택을 띄우는 데 필요한 것을 담는다.
운영 환경의 값(호스트·도메인·자격증명·실제 상한)은 저장소에 들어가지 않는다.

| 경로 | 내용 |
|---|---|
| `clamav/` | 검사 worker가 쓰는 ClamAV 이미지. 공식 이미지가 amd64 전용이라 직접 만든다 |
| `sql/login-roles.sql` | RLS를 적용받는 접속 role. superuser로 앱을 돌리지 않기 위한 것이다 |
| `local-secrets/` | **로컬 전용 공개 기본값.** 이유는 같은 디렉터리의 `README.md` |
| `observability/*.yml` | Prometheus 스크레이프 설정과 알림 규칙 |

## 시크릿 주입

값이 아니라 **참조**를 환경변수에 넣는다(`file:/run/secrets/...` · `env:NAME`).
프로세스 환경과 `docker inspect`에 비밀이 남지 않고, 로컬과 배포가 같은 코드
경로(`packages/config`)로 읽는다. 실제 배포에서는 Docker secret·Kubernetes
projected volume·secret manager가 같은 자리에 파일을 놓는다.

## anchor 지갑의 손실 상한

anchor signer의 가스 지갑은 이 시스템에서 **자금이 나가는 유일한 경로**다.
상한은 두 개여야 성립한다.

| 상한 | 무엇을 막나 | 어디에 있나 |
|---|---|---|
| 충전 상한 | 지갑에 들어 있는 총액. 키가 새면 이만큼만 잃는다 | 재무·운영 절차. 코드가 강제하지 못한다 |
| 소진 상한 | 하루에 태우는 총액. worker가 스스로 지갑을 비우지 못한다 | `ANCHOR_DAILY_SPEND_CAP_WEI` |

충전 상한만 두면 하루 만에 다 태우고, 소진 상한만 두면 지갑에 넣어 둔 잔액
전체가 노출된다.

### 값을 정하는 법

```
예상 소진(wei) = 하루 제출 건수 × 건당 gas × ANCHOR_FEE_CAP_GWEI × 1e9
일일 소진 상한 = 예상 소진 × 1.5
충전 상한      = 일일 소진 상한 (하루치만 넣어 둔다)
```

- **건당 gas** — `forge test --gas-report`의 `submitRoot` max에 트랜잭션 기본
  비용(21,000)과 calldata 여유를 더한다.
- **하루 제출 건수** — 운영 환경의 사실이다. 저장소가 정하지 않는다. batch는
  게시를 모아 한 번에 올리므로 제출 건수는 게시 건수보다 **적다**.
- **가스 가격 상한** — `ANCHOR_FEE_CAP_GWEI`(기본 100). 이 값을 넘으면 worker가
  제출하지 않으므로 최악의 경우가 그대로 이 값이다. 둘 중 하나만 고치면 상한이
  의도한 배수에서 벗어난다.

`ANCHOR_DAILY_SPEND_CAP_WEI`에 **wei 단위 정수**로 넣는다. `0.05`나 `1e17` 같은
표기는 거절한다. **기본값이 없다** — 비우고 기동하면 anchor worker가 거절한다.
기본값이 있으면 아무도 상한을 정하지 않은 채 배포된다.

곱셈은 `apps/worker/test/anchor-config.test.ts`가 다시 검산한다.

### 이 상한이 세지 않는 것

- **아직 영수증이 오지 않은 제출.** 실제 비용은 블록에 들어가야 알 수 있다. 그
  구간의 노출은 `ANCHOR_FEE_CAP_GWEI × ANCHOR_MAX_ATTEMPTS`가 막는다.
- **reorg로 뒤집힌 시도에서 태운 가스.** 같은 행에 마지막 영수증만 남는다.
- **multisig 제안 경로.** 제안은 이 지갑의 가스를 쓰지 않는다. 실행하는 것은
  multisig owner이며, 그쪽 손실 상한은 소유자 구성과 threshold다.

세지 않는 것이 있으므로 **충전 상한이 최종 방어선**이다.

하루 경계는 **UTC 자정**이다. 서버 timezone을 따르면 배포 위치가 바뀔 때 상한이
열리는 시각이 조용히 이동한다.

## 관측

```sh
docker compose --profile observability up -d
```

Prometheus는 `:9090`, Alertmanager는 `:9093`이다. **둘 다 포트를 밖으로 열지 않는
것이 기본이다** — `/metrics`에 인증이 없으므로(대신 식별 정보를 담지 않는다)
경계는 네트워크가 만든다. 알림 수신처는 저장소에 두지 않는다. 넣으면 그것이
시크릿이 되고, 지운 뒤에도 커밋에 남는다.

설정은 배포와 같은 이미지의 공식 `amtool`로 검사한다 —
`scripts/ops/check-alertmanager.sh`.
