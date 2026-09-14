# 로컬 전용 시크릿

**이 디렉터리의 값은 전부 공개된 것이다.** anvil 기본 계정 키와 MinIO 기본
자격증명이며, 어떤 실자산도 보유하지 않는다.

여기 있는 이유는 값이 비밀이어서가 아니라 **주입 경로를 배포와 같게 만들기
위해서**다. `docker-compose.yml`은 이 파일들을 `file:` 참조로 마운트하고,
애플리케이션은 `packages/config`의 같은 코드로 읽는다. 로컬만 환경변수 값을
쓰면 "로컬에서는 되는데 배포에서 안 되는" 구간이 생긴다.

실제 배포에서는 이 디렉터리를 쓰지 않는다. Docker secret·Kubernetes projected
volume·secret manager가 같은 경로에 파일을 놓는다.
