# syntax=docker/dockerfile:1.7
# The tools a Mac would otherwise need from Homebrew: SOPS and age for the secrets files, and jq and
# openssl for the scripts. Built on the same Debian base as every other image here, so its layers
# are shared and the host needs only Docker.
FROM node:26-bookworm-slim
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
ENV GB_IN_TOOLS=1
WORKDIR /work
