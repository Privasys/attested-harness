# Dev composition

`privasys.cordis.yml` is the patch overlay that points a stock dsh profile's
model leg at the attested egress proxy — the WS2 seed that became the first
full integration (2026-08-27): stock dsh headless agent → egress proxy
(fork build, per-request attestation + 6.1 gate) → production Confidential
AI on m4.

Run it (WSL, dsh checkout at the pin, fork toolchain at ~/go-ratls):

```sh
cd attested-harness/proxy && ~/go-ratls/bin/go build -tags ratls -o ~/bin/egress-proxy ./cmd/egress-proxy
EGRESS_PROXY_LISTEN=127.0.0.1:9412 HARNESS_MODEL_HOST=confidential-ai.apps.privasys.org ~/bin/egress-proxy &
cd ~/dsh && DEEPSEEK_API_KEY=<platform bearer> DEEPSEEK_BASE_URL=http://127.0.0.1:9412/model/v1 \
  pnpm dsh --profile headless --patch <this file> "your task"
```

Notes discovered en route (they shape llm-privasys):
- The stock `llm-deepseek` adapter works against CAI verbatim (OpenAI wire).
  `llm-privasys` therefore stays a thin subclass: the reproducibility
  opt-in header + surfacing the trailing repro frame as session events.
- The composed headless profile pins its model in `agent-default-model`
  (bundle layer), NOT in an agent-spine entry — patch that row.
- The adapter's default maxTokens (256000) exceeds the fleet's
  max_model_len; the catalogue entry must set maxTokens explicitly.
- WSL kills backgrounded processes when their launching session exits and
  clears /tmp on VM restart: keep the proxy binary in ~/bin and start it in
  the same session as the harness during dev.
