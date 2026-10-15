# syntax=docker/dockerfile:1.7
# The tools a Mac would otherwise need from Homebrew: SOPS and age for the secrets files, jq and
# openssl for the scripts, and Node with marked for the plan's HTML pages. Built on the same Debian
# base as every other image here, so its layers are shared and the host needs only Docker.
FROM node:22-bookworm-slim
ARG TARGETARCH
# SOPS from its own release (Debian's is older than `sops set --value-stdin`), checked against the
# release's checksums.
ARG SOPS_VERSION=3.13.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq age openssl \
 && cd /tmp && base="https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}" \
 && curl -fsSLO "${base}/sops-v${SOPS_VERSION}.linux.${TARGETARCH}" \
 && curl -fsSLO "${base}/sops-v${SOPS_VERSION}.checksums.txt" \
 && grep " sops-v${SOPS_VERSION}.linux.${TARGETARCH}\$" "sops-v${SOPS_VERSION}.checksums.txt" | sha256sum -c - \
 && install -m 0755 "sops-v${SOPS_VERSION}.linux.${TARGETARCH}" /usr/local/bin/sops \
 && rm -f /tmp/sops-* \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/render && cd /opt/render \
 && npm install --no-audit --no-fund --omit=dev marked@14.1.4 && npm cache clean --force
# The renderer is a CommonJS script in the repository; it finds marked here.
ENV NODE_PATH=/opt/render/node_modules \
    GB_IN_TOOLS=1
WORKDIR /work
