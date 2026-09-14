# MPC dApp — API·worker·web 공용 이미지
#
# **빌드 컨텍스트는 저장소 루트다.**
#
#   docker build -t mpc-dapp .
#
# 하나의 이미지에 세 프로세스를 담고 실행 시 명령으로 고른다. 이미지를 나누면
# 같은 커밋의 세 이미지가 어긋날 수 있고, monorepo에서 공유 패키지가 바뀌었을 때
# 어느 것을 다시 만들어야 하는지 추적해야 한다.
#
# **빌드에 시크릿을 넣지 않는다.** 이미지 레이어는 지워도 남는다. 모든 비밀은
# 런타임에 `file:`·`env:` 참조로 주입한다(packages/config).

# --- 의존성 --------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# pnpm 버전은 package.json의 packageManager가 고정한다. corepack이 최신을 받아오면
# 로컬과 다른 동작을 하고 그것이 이 이미지에서만 나타난다.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# 소스를 통째로 복사한 뒤 설치한다.
#
# manifest만 골라 복사하면 의존성 레이어가 잘 캐시되지만, **패키지를 새로 만들
# 때마다 이 목록을 고쳐야 하고 빠뜨리면 런타임에야 드러난다.**
#
# `design-system/`도 이 안에 있다. 웹이 `link:../../design-system`으로 참조하므로
# manifest만으로는 CSS import가 해결되지 않고 파일이 실제로 있어야 한다.
#
# pnpm store를 캐시 마운트로 두므로 재설치 자체는 빠르다. 잃는 것은 레이어
# 캐시이고 얻는 것은 목록을 유지하지 않아도 된다는 것이다.
COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- 웹 빌드 -------------------------------------------------------------------
FROM deps AS web-build

# deps가 이미 전체 소스를 갖고 있다. 다시 복사하면 node_modules를 덮어쓴다.
# workspace TS 패키지를 그대로 쓰므로 webpack 모드로 빌드한다 — `--webpack`은
# `apps/web/package.json`의 build 스크립트가 갖는다.
RUN pnpm --filter @mpc/web build

# --- 런타임 --------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /repo
# COREPACK_HOME을 공유 경로로 고정한다. 기본값은 `$HOME/.cache`라서 빌드(root)와
# 실행(mpc)이 서로 다른 곳을 본다 — 그러면 실행 시 다시 받아오려 하고, 비루트
# 사용자는 그 디렉터리를 만들지 못한다.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production COREPACK_HOME=/opt/corepack
# pnpm을 **빌드 시점에** 준비한다. 실행 시 받아오게 두면 컨테이너 기동이
# 네트워크에 의존한다.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
 && chmod -R a+rX /opt/corepack

# root로 돌리지 않는다. 컨테이너 탈출 시 호스트 권한이 그대로 따라간다.
RUN groupadd --system --gid 10001 mpc \
 && useradd --system --uid 10001 --gid mpc --home /repo mpc

# 트리를 통째로 가져온다.
#
# pnpm workspace는 패키지마다 `node_modules` 심볼릭 링크를 만든다. 루트
# `node_modules`만 복사하면 `packages/db`가 `postgres`를 찾지 못한다 — 링크가
# 없기 때문이다. 조각으로 옮기면 어느 링크가 빠졌는지 런타임에야 드러난다.
#
# 대신 이미지에 devDependency가 함께 들어간다. 크기와 정확성을 맞바꾼 것이며,
# 줄이려면 `pnpm deploy`로 프로덕션 트리를 따로 만들어야 한다.
COPY --from=web-build /repo /repo

USER mpc

# 프로세스는 실행 시 고른다:
#   api    — pnpm --filter @mpc/api start
#   worker — pnpm --filter @mpc/worker start:anchor
#   web    — pnpm --filter @mpc/web exec next start
CMD ["pnpm", "--filter", "@mpc/api", "start"]
