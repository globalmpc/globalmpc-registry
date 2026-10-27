# MPC dApp — API and web image; workers use docker/Dockerfile.workers
#
# **The build context is the repository root.**
#
#   docker build -f docker/Dockerfile -t mpc-dapp .
#
# API and web share this image. Worker images are built independently from the same
# repository and lockfile, with only their production dependency closure.
#
# **No secrets go into the build.** Image layers persist even after deletion. Every secret is
# injected at runtime via `file:`/`env:` references (packages/config).

# --- Dependencies ---------------------------------------------------------------
# The base is pinned by digest, in both stages. A tag can be repointed; a digest cannot, so the
# same commit always builds on the same bytes. Update the tag and digest together, and keep the
# two stages identical (`docker buildx imagetools inspect node:<tag>` — the index digest).
#
# Alpine (musl) keeps the base small. The lockfile already carries the `*-musl` optional
# binaries (Next SWC, sharp, rollup, esbuild); a new native dependency must ship one too.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS deps

WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# The pnpm version is pinned by packageManager in package.json. If corepack fetched the latest,
# behavior would differ from local and show up only in this image.
RUN corepack enable pnpm && corepack prepare pnpm@10.33.0 --activate

# Copy the whole source tree, then install.
#
# Copying only manifests caches the dependency layer well, but **the list must be edited for
# every new package, and an omission only shows up at runtime.**
#
# `design-system/` is included too. The web app references it via `link:../../design-system`,
# so manifests alone do not resolve CSS imports — the files must actually be present.
#
# The pnpm store is a cache mount, so reinstalling is fast. What is lost is layer caching;
# what is gained is not having to maintain the list.
COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- Web build ------------------------------------------------------------------
FROM deps AS web-build

# deps already holds the full source. Copying again would overwrite node_modules.
# Workspace TS packages are used as-is, so the build runs in webpack mode — `--webpack`
# lives in the build script of `apps/web/package.json`.
RUN pnpm --filter @mpc/web build

# --- Runtime --------------------------------------------------------------------
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime

WORKDIR /repo
ENV NODE_ENV=production
# The runtime starts every process with `node` directly (see CMD and Compose), so no package
# manager ships: npm, npx, yarn and corepack (with the pnpm it would fetch) are removed. Each
# is extra code and CVE surface, and `pnpm` as PID 1's child only adds a process between the
# signal and the server.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

# Do not run as root. On container escape, host privileges would follow.
RUN addgroup -S -g 10001 mpc \
 && adduser -S -D -H -u 10001 -G mpc -h /repo -s /sbin/nologin mpc

# Bring over the whole tree.
#
# A pnpm workspace creates `node_modules` symlinks in each package. Copying only the root
# `node_modules` leaves `packages/db` unable to find `postgres` — the links are missing.
# Moving it in pieces means a missing link only shows up at runtime.
#
# In exchange, devDependencies ship in the image. Size is traded for correctness; to shrink
# it, a production tree would need to be built separately with `pnpm deploy`.
COPY --from=web-build /repo /repo

USER mpc

# The process is chosen at run time, each from its package directory:
#   api     — /repo/apps/api:    node --import tsx src/main.ts
#   web     — /repo/apps/web:    node node_modules/next/dist/bin/next start --port 3000
#   migrate — /repo/packages/db: node --import tsx src/cli.ts
WORKDIR /repo/apps/api
CMD ["node", "--import", "tsx", "src/main.ts"]
