#!/bin/bash
set -euo pipefail

# Attested Harness entrypoint: the egress proxy (loopback; ALL attested
# egress) plus the dsh web app (bound to the CONTAINER IP: the enclave
# ingress proxies to it — dsh refuses 0.0.0.0 by design, and loopback would
# be unreachable; the platform injects PORT).
#
# Env (platform-injected): PORT, PRIVASYS_MANAGER_URL, PRIVASYS_CONTAINER_NAME,
# PRIVASYS_CONTAINER_TOKEN, PRIVASYS_IMAGE_DIGEST.
# Env (app config): HARNESS_MODEL_HOST, HARNESS_TOOL_HOSTS,
# HARNESS_PUBLIC_HOST (the app hostname for the browser-trust fence),
# PRIVASYS_BEARER (dev-only model auth until the sealed-ingress identity
# lands in runtime-privasys).

if [[ -z "${PORT:-}" ]]; then
  echo "[harness] ERROR: PORT is required" >&2
  exit 1
fi

mkdir -p "${DSH_HOME:-/data/dsh}"

EGRESS_PROXY_LISTEN=127.0.0.1:9411 /usr/local/bin/egress-proxy &
PROXY_PID=$!
for i in $(seq 1 50); do
  curl -sf --max-time 2 http://127.0.0.1:9411/healthz >/dev/null 2>&1 && break
  kill -0 "$PROXY_PID" 2>/dev/null || { echo "[harness] egress-proxy died at startup" >&2; exit 1; }
  sleep 0.2
done

# The model leg rides the proxy; the stock adapter reads these.
export DEEPSEEK_BASE_URL=http://127.0.0.1:9411/model/v1
export DEEPSEEK_API_KEY="${PRIVASYS_BEARER:-unset}"

BIND_IP=$(hostname -i | awk '{print $1}')
TRUST=()
if [[ -n "${HARNESS_PUBLIC_HOST:-}" ]]; then
  TRUST=(--trusted-host "${HARNESS_PUBLIC_HOST}")
fi

echo "[harness] dsh web on ${BIND_IP}:${PORT} (proxy pid ${PROXY_PID}, trusted-host ${HARNESS_PUBLIC_HOST:-none})"
# `--profile web --patch` (not the `web` alias, which rejects parent flags):
# resolveBoot allows a --patch overlay on any profile, including web.
exec pnpm dsh --profile web --patch /app/profile.cordis.yml \
  -- --no-open --host "${BIND_IP}" --port "${PORT}" "${TRUST[@]}"
