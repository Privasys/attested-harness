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
 && git -C /dsh checkout "${DSH_PIN}" \
 && rm -rf /dsh/.git
WORKDIR /dsh
RUN pnpm install --frozen-lockfile

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim
# corepack prepare pins pnpm INSIDE the image: an enclave has no free
# egress for a boot-time registry fetch.
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate \
 && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=dsh-builder /dsh /dsh
COPY --from=proxy-builder /egress-proxy /usr/local/bin/egress-proxy
COPY app/profile.cordis.yml /app/profile.cordis.yml
COPY app/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
# dsh home (sessions, settings, profiles) lives on the encrypted app volume
# when the platform mounts one; the entrypoint points DSH_HOME there.
ENV DSH_HOME=/data/dsh
WORKDIR /dsh
ENTRYPOINT ["/app/entrypoint.sh"]
