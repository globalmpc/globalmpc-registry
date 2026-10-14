# Independent worker image. Build context is the repository root.
# WORKER must be jobs-worker, anchor-worker, or scan-worker.
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS dependencies
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
ARG WORKER
RUN case "$WORKER" in jobs-worker|anchor-worker|scan-worker) ;; *) exit 1 ;; esac
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@mpc/${WORKER}..." --prod
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter "@mpc/${WORKER}" deploy --prod --legacy /worker

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 10001 mpc \
    && useradd --system --uid 10001 --gid mpc --home /app mpc
COPY --from=dependencies /worker /app
USER mpc
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
