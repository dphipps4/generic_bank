# syntax=docker/dockerfile:1.7
# One image for every Node service. Each compose service runs a different entry point.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/drivers/package.json packages/drivers/
COPY packages/evidence/package.json packages/evidence/
COPY packages/oauth/package.json packages/oauth/
COPY packages/runs/package.json packages/runs/
COPY packages/screen/package.json packages/screen/
COPY apps/api/package.json apps/api/
COPY apps/bank/package.json apps/bank/
COPY apps/console/package.json apps/console/
COPY apps/factory/package.json apps/factory/
COPY apps/memory/package.json apps/memory/
COPY apps/runner/package.json apps/runner/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN npx prisma generate --schema packages/db/prisma/schema.prisma && npx tsc -b

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production ADMIN_JS_SKIP_BUNDLE=true
USER node
