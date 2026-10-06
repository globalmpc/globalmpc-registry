# MPC dApp — shared image for API, worker, and web
#
# **The build context is the repository root.**
#
#   docker build -t mpc-dapp .
#
# One image holds all three processes; the run command picks one. Split images could drift
# for the same commit, and in a monorepo you would have to track which ones to rebuild when a
# shared package changes.
#
# **No secrets go into the build.** Image layers persist even after deletion. Every secret is
# injected at runtime via `file:`/`env:` references (packages/config).

# --- Dependencies ---------------------------------------------------------------
# The base is pinned by digest, in both stages. A tag can be repointed; a digest cannot, so the
# same commit always builds on the same bytes. Update the tag and digest together, and keep the
# two stages identical (`docker buildx imagetools inspect node:<tag>` — the index digest).
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS deps

WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# The pnpm version is pinned by packageManager in package.json. If corepack fetched the latest,
# behavior would differ from local and show up only in this image.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

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
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

WORKDIR /repo
# Pin COREPACK_HOME to a shared path. The default is `$HOME/.cache`, so build (root) and
# run (mpc) look in different places — then it tries to re-download at run time, and the
# non-root user cannot create that directory.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production COREPACK_HOME=/opt/corepack
# Prepare pnpm **at build time**. Leaving it to download at run time makes container
# startup depend on the network.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
 && chmod -R a+rX /opt/corepack

# Do not run as root. On container escape, host privileges would follow.
RUN groupadd --system --gid 10001 mpc \
 && useradd --system --uid 10001 --gid mpc --home /repo mpc

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

# The process is chosen at run time:
#   api    — pnpm --filter @mpc/api start
#   worker — pnpm --filter @mpc/worker start:anchor
#   web    — pnpm --filter @mpc/web exec next start
CMD ["pnpm", "--filter", "@mpc/api", "start"]
