# syntax=docker/dockerfile:1.7
# One image for every Node service. Each compose service runs a different entry point.
FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/evidence/package.json packages/evidence/
COPY packages/guardrails/package.json packages/guardrails/
COPY packages/oauth/package.json packages/oauth/
COPY packages/runs/package.json packages/runs/
COPY packages/runtime/package.json packages/runtime/
COPY packages/crawler/package.json packages/crawler/
COPY apps/api/package.json apps/api/
COPY apps/bank/package.json apps/bank/
COPY apps/console/package.json apps/console/
COPY apps/factory/package.json apps/factory/
COPY apps/memory/package.json apps/memory/
COPY apps/runner/package.json apps/runner/
# The embedding runtime runs on CPU: no GPU libraries are fetched for it, and only this
# platform's are kept.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin node_modules/onnxruntime-node/bin/napi-v6/win32
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN npx prisma generate --schema packages/db/prisma/schema.prisma && npx tsc -b
# The image ships what runs: the build's tools (TypeScript, the test runner, the linters) go.
RUN npm prune --omit=dev --no-audit --no-fund \
  && npx prisma generate --schema packages/db/prisma/schema.prisma

FROM node:26-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
# Memory's embedding model, and the evidence (frames as files), are kept in volumes mounted
# here; each takes its directory's owner.
RUN mkdir -p /models /data/evidence /data/sessions && chown node:node /models /data/evidence /data/sessions
ENV NODE_ENV=production ADMIN_JS_SKIP_BUNDLE=true
USER node
