#!/bin/bash
set -euo pipefail

# Attested Harness entrypoint. The Go proxy owns BOTH network edges:
#   - egress on loopback :9411  (dsh plugins -> attested peers: CAI, tools)
#   - ingress on $PORT          (platform -> dsh web)
# Fronting $PORT lets the platform health check pass from second one while
# dsh (heavy, ~40s boot) comes up on an internal loopback port behind it —
# the confidential-ai pattern (Go front on $PORT, backend behind).
#
# Env (platform-injected): PORT, PRIVASYS_MANAGER_URL, PRIVASYS_CONTAINER_NAME,
# PRIVASYS_CONTAINER_TOKEN, PRIVASYS_IMAGE_DIGEST.
# Env (image-baked topology): HARNESS_MODEL_HOST, HARNESS_TOOL_HOSTS.
# Env (optional): HARNESS_PUBLIC_HOST (browser-trust fence authority),
# PRIVASYS_BEARER (dev-only model auth; on-platform uses the attested cert).

if [[ -z "${PORT:-}" ]]; then
  echo "[harness] ERROR: PORT is required" >&2
  exit 1
fi

mkdir -p "${DSH_HOME:-/dsh-home}"

DSH_PORT=3080
EGRESS_PROXY_LISTEN=127.0.0.1:9411 \
INGRESS_LISTEN="0.0.0.0:${PORT}" \
DSH_UPSTREAM="http://127.0.0.1:${DSH_PORT}" \
  /usr/local/bin/egress-proxy &
PROXY_PID=$!
for i in $(seq 1 50); do
  curl -sf --max-time 2 http://127.0.0.1:9411/healthz >/dev/null 2>&1 && break
  kill -0 "$PROXY_PID" 2>/dev/null || { echo "[harness] egress-proxy died at startup" >&2; exit 1; }
  sleep 0.2
done

# The model leg rides the proxy; the stock adapter reads these.
export DEEPSEEK_BASE_URL=http://127.0.0.1:9411/model/v1
export DEEPSEEK_API_KEY="${PRIVASYS_BEARER:-unset}"

# Boot smoke: one headless agent turn through the proxy to Confidential AI,
# proving the model leg works IN THE ENCLAVE (on-platform: attested client
# cert, no bearer). Bounded and non-fatal — logs PASS/FAIL and never blocks
# the web server. Skipped when HARNESS_SKIP_BOOT_SMOKE is set.
if [[ -z "${HARNESS_SKIP_BOOT_SMOKE:-}" ]]; then
  echo "[harness] boot smoke: headless model turn -> ${HARNESS_MODEL_HOST}"
  SMOKE=$(timeout 240 node /dsh/apps/cli/lib/bin.js --profile headless \
    --patch /app/profile.cordis.yml \
    "Reply with exactly: ONPLATFORM MODEL OK. Do not use any tools." 2>&1 | tail -3 || true)
  if grep -q "ONPLATFORM MODEL OK" <<<"$SMOKE"; then
    echo "[harness] boot smoke PASS: on-platform model leg attested + serving"
  else
    echo "[harness] boot smoke FAIL (non-fatal): ${SMOKE}"
  fi
fi

TRUST=()
if [[ -n "${HARNESS_PUBLIC_HOST:-}" ]]; then
  TRUST=(--trusted-host "${HARNESS_PUBLIC_HOST}")
fi

# Run the COMPILED dsh (lib/bin.js), NOT `pnpm dsh` (which is
# `node --import tsx/esm src/bin.ts` — on-the-fly TS transpile of the whole
# tree, minutes-slow under the enclave's constrained CPU and the cause of the
# boot never finishing before the health check). dsh binds the internal
# loopback port (overlay webserver row 127.0.0.1:$DSH_PORT); the proxy fronts
# $PORT. `--profile web --patch` (the `web` alias rejects parent flags).
# Sessions default their workspace to the process cwd. Running from /dsh (the
# WORKDIR) made every session a workspace INSIDE the dsh checkout — dsh's own
# AGENTS.md got injected as workspace instructions and users worked in the
# harness source tree. Work belongs on the ENCRYPTED VOLUME: a persistent
# workspace directory that survives redeploys.
mkdir -p /data/workspace
# The deployment-owned skill root (presets pin skill discovery to it,
# includeDefaultRoots:false — see app/profile notes + the preset overlay).
mkdir -p /data/skills
cd /data/workspace

echo "[harness] dsh web (compiled) on 127.0.0.1:${DSH_PORT}, proxy fronts 0.0.0.0:${PORT} (pid ${PROXY_PID}, trusted-host ${HARNESS_PUBLIC_HOST:-none})"
exec node /dsh/apps/cli/lib/bin.js --profile web --patch /app/profile.cordis.yml \
  -- --no-open "${TRUST[@]}"
