# The Runner: the shared Node image plus Debian's Chromium (kept current by Debian's security
# updates; full Chromium, run in its modern headless mode, because the identity extension needs it)
# and the fonts the banks' pages are drawn with.
ARG BASE=generic-bank/node:dev
FROM ${BASE}
USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 # Debian's package ships Debian's own Google API keys for Chrome's Google services, which the
 # Runner never uses: an image we ship carries no keys, so they go.
 && rm -f /etc/chromium.d/apikeys
USER node
