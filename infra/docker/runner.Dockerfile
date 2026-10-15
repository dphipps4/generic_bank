# The Runner: the shared Node image plus Debian's headless Chromium (kept current by Debian's
# security updates) and the fonts the banks' pages are drawn with.
ARG BASE=generic-bank/node:dev
FROM ${BASE}
USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends chromium-headless-shell fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
USER node
