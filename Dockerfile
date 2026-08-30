# Attested Harness — measured app image (WS3).
#
# Three stages: the egress proxy on the Privasys Go fork (-tags ratls, the
# ClientHello challenge extension), the vendored dsh tree at the pin, and a
# node runtime that runs both under one entrypoint. The dsh source is
# vendored AT IMAGE BUILD from the public repo at the pinned commit — the
# composition (app/profile.cordis.yml) plus this file IS the measured
# identity of the harness (D-decisions: extend, don't fork).

# ---- egress proxy (attestation authority; never Node) ---------------------
FROM golang:1.22-bookworm AS proxy-builder
ARG GO_RATLS_VERSION=privasys-v0.5.1-go1.26.5
ARG RA_TLS_CLIENTS_REF=312969f1949d4bdf8048a853f1ab9cfc06622426
RUN curl -sL "https://github.com/Privasys/go/releases/download/${GO_RATLS_VERSION}/go-ratls-${GO_RATLS_VERSION}-linux-amd64.tar.gz" \
      -o /tmp/go-ratls.tar.gz \
 && tar -C /usr/local -xzf /tmp/go-ratls.tar.gz && rm /tmp/go-ratls.tar.gz \
 && git clone https://github.com/Privasys/ra-tls-clients /build/attested-harness/ra-tls-clients \
 && git -C /build/attested-harness/ra-tls-clients checkout "${RA_TLS_CLIENTS_REF}"
ENV GOROOT=/usr/local/go-ratls
ENV PATH=/usr/local/go-ratls/bin:${PATH}
COPY proxy /build/attested-harness/proxy
WORKDIR /build/attested-harness/proxy
RUN CGO_ENABLED=0 go build -tags ratls -trimpath -ldflags="-s -w" \
      -o /egress-proxy ./cmd/egress-proxy

# ---- dsh at the pin -------------------------------------------------------
FROM node:22-bookworm AS dsh-builder
ARG DSH_PIN=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
RUN corepack enable \
 && git clone https://github.com/deepseek-ai/deepseek-harness /dsh \
 && git -C /dsh checkout "${DSH_PIN}"
WORKDIR /dsh
RUN pnpm install --frozen-lockfile
# Apply the Privasys web overlay (D8 extend-don't-fork patch queue): the sealed
# transport carrier (privasys-api-client.ts), the gated boot (apps/web main.ts),
# the auth + attestation shell and its assets, and the removal of the WebSocket
# 426 fence so the event downlinks ride SSE. apply-overlay.mjs asserts every
# anchor and FAILS the build if upstream moved one — the signal to rebase, never
# a silent skip. No package.json is touched, so the frozen lockfile still holds.
COPY web /build/web
RUN node /build/web/apply-overlay.mjs /dsh
# Build the frontend dist (dsh-web-app refuses to load without it) and
# materialize the web profile so its plugin node_modules are baked into the
# image — an enclave has no egress for a boot-time install, and the profile
# is deterministic from the pin, so it belongs in the measured identity.
ENV DSH_HOME=/dsh-home
# Rebrand the dsh client chrome: the document/app title (read at vite build
# time) and the brand-slot occupants (Brand.tsx overlay) carry Privasys, not
# DeepSeek. DSH_CLIENT_BUILD_PROFILE=official keeps the brand slots filled (now
# with our overridden Privasys mark/name).
ENV DSH_CLIENT_TITLE="Attested Harness"
ENV DSH_CLIENT_BUILD_PROFILE=official
# Build the frontend, then load the web profile once so dsh's
# healProfilesModuleFallback links profiles/node_modules to the CLI's
# workspace packages (no network — plain symlinks). Both /dsh and /dsh-home
# are baked into the runtime image, so the links stay valid there.
RUN pnpm run build \
 && (pnpm dsh --profile web --dump-config >/dev/null 2>&1 || true) \
 && (pnpm dsh --profile headless --dump-config >/dev/null 2>&1 || true) \
 && test -e /dsh-home/profiles/node_modules/@deepseek-ai/dsh-web-app \
 && test -e /dsh-home/profiles/node_modules/@deepseek-ai/dsh-headless \
 && rm -rf /dsh/.git

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim
# corepack prepare pins pnpm INSIDE the image: an enclave has no free
# egress for a boot-time registry fetch.
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate \
 && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=dsh-builder /dsh /dsh
COPY --from=dsh-builder /dsh-home /dsh-home
COPY --from=proxy-builder /egress-proxy /usr/local/bin/egress-proxy
COPY app/profile.cordis.yml /app/profile.cordis.yml
COPY app/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
# The measured web profile (plugins + frontend) is baked at /dsh-home. Only
# sessions/settings persist, on the encrypted volume — the overlay points
# session persistence at /data (see profile.cordis.yml).
ENV DSH_HOME=/dsh-home
# Fixed attested topology — the harness always calls Confidential AI and the
# platform tool apps; the 6.1 DepSet + allowed_callers enforce the actual
# attestation regardless of hostname, so these belong in the measured image
# (override at deploy for a different fleet). Model auth on-platform is the
# attested client cert, not a bearer (see the proxy's onPlatform path).
# The app's stable public host (name.domain), used for dsh's --trusted-host and
# the ingress Director's Host pinning so dsh's /api DNS-rebinding fence accepts
# the browser's sealed same-origin requests. Stable across enclaves for this app.
ENV HARNESS_PUBLIC_HOST=attested-harness.apps-test.privasys.org
ENV HARNESS_MODEL_HOST=confidential-ai.apps.privasys.org
ENV HARNESS_TOOL_HOSTS=web_search=web-search-brave.apps.privasys.org,web_reader=web-browser-lightpanda.apps.privasys.org,drive=privasys-drive.apps.privasys.org
# Public browser-UI shell: these prefixes are the forked dsh SPA + Privasys
# auth/attestation shell (HTML/JS/CSS — public measured code, no user data).
# The enclave session-relay serves them in the CLEAR on the gateway-terminated
# leg so the page can load before a sealed session exists; the data plane
# (/api, /privasys/attestation over sealed) stays sealed. This label is
# measured (it rides the image config), so a verifier sees exactly which paths
# are served unsealed. enclave-os requires tdx runtime with the static-unsealed
# exemption (manager.go isStaticUnsealedPath).
LABEL org.privasys.static-unsealed-prefixes="/,/assets/,/privasys/,/plugins/,/favicon.svg,/manifest.webmanifest"
# Link the GHCR package to this repo so its Actions inherit write access
# (avoids a personal access token — the package is published by CI).
LABEL org.opencontainers.image.source="https://github.com/Privasys/attested-harness"
WORKDIR /dsh
ENTRYPOINT ["/app/entrypoint.sh"]
