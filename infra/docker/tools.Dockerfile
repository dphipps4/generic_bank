# syntax=docker/dockerfile:1.7
# The tools a Mac would otherwise need from Homebrew: SOPS and age for the secrets files, jq and
# openssl for the scripts, and Node with marked for the plan's HTML pages. One small image, pinned
# by minor version, so every machine runs the same tools and the host needs only Docker.
FROM alpine:3.22
ARG TARGETARCH
# SOPS from its own release (Alpine's is older than `sops set --value-stdin`), checked against the
# release's checksums.
ARG SOPS_VERSION=3.13.3
RUN apk add --no-cache curl \
 && cd /tmp && base="https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}" \
 && curl -fsSLO "${base}/sops-v${SOPS_VERSION}.linux.${TARGETARCH}" \
 && curl -fsSLO "${base}/sops-v${SOPS_VERSION}.checksums.txt" \
 && grep " sops-v${SOPS_VERSION}.linux.${TARGETARCH}\$" "sops-v${SOPS_VERSION}.checksums.txt" | sha256sum -c - \
 && install -m 0755 "sops-v${SOPS_VERSION}.linux.${TARGETARCH}" /usr/local/bin/sops \
 && rm -f /tmp/sops-* && apk del curl
RUN apk add --no-cache \
      'bash~5.2' 'jq~1.8' 'openssl~3.5' 'age~1.2' 'nodejs~22' \
 && apk add --no-cache --virtual .npm 'npm~11' \
 && mkdir -p /opt/render && cd /opt/render \
 && npm install --no-audit --no-fund --omit=dev marked@14.1.4 \
 && npm cache clean --force && apk del .npm
# The renderer is a CommonJS script in the repository; it finds marked here.
ENV NODE_PATH=/opt/render/node_modules \
    GB_IN_TOOLS=1
WORKDIR /work
