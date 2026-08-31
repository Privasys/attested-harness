# Dev composition

`privasys.cordis.yml` is a patch overlay that points a stock dsh profile's
model leg at the attested egress proxy, for running the harness pieces on a
workstation (no enclave): stock dsh headless agent → egress proxy
(fork build, per-request attestation + dependency-set gate) → Confidential
AI.

Run it (WSL, dsh checkout at the pin, fork toolchain at ~/go-ratls):

```sh
cd harness/proxy && ~/go-ratls/bin/go build -tags ratls -o ~/bin/egress-proxy ./cmd/egress-proxy
EGRESS_PROXY_LISTEN=127.0.0.1:9412 HARNESS_MODEL_HOST=<cai-host> ~/bin/egress-proxy &
cd ~/dsh && DEEPSEEK_API_KEY=<platform bearer> DEEPSEEK_BASE_URL=http://127.0.0.1:9412/model/v1 \
  pnpm dsh --profile headless --patch <this file> "your task"
```

Notes discovered en route:
- The stock `llm-deepseek` adapter works against Confidential AI verbatim
  (OpenAI wire), so the deployed composition configures it rather than
  shipping a custom adapter.
- The composed headless profile pins its model in `agent-default-model`
  (bundle layer), NOT in an agent-spine entry — patch that row.
- The adapter's default maxTokens (256000) exceeds the fleet's
  max_model_len; the catalogue entry must set maxTokens explicitly.
- WSL kills backgrounded processes when their launching session exits and
  clears /tmp on VM restart: keep the proxy binary in ~/bin and start it in
  the same session as the harness during dev.
