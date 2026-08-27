# Attested Harness

An agent harness where the harness, the model, the tools, and the workspace
are all attested. We host [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)
as a confidential Privasys platform app (TDX) and add the attestation
substrate around and beneath it. dsh is MIT-licensed; its license and
third-party notices ship in every image.

## Architecture in one paragraph

dsh composes declaratively at boot (profiles → bundles → config patches), so
the plugin tree is vendored into the measured image and the profile is frozen
through the platform's configure-freeze: the *composition itself* is part of
the attested identity. The agent loop, session log, and web surface are stock
dsh. Every attested concern lives in two thin layers we own: a set of dsh
plugins on documented seams (`bundle/`), and a Go egress proxy (`proxy/`)
that holds **all** attestation authority.

## The load-bearing rule

**Attestation authority never lives in Node.** All outbound attested legs —
model calls to Confidential AI, tool calls to Drive / web-search /
web-browse — go through the egress proxy: a localhost listener that speaks
mutual RA-TLS (challenge extension via the Privasys Go fork) and enforces the
app's declared dependency set (OID 65230.6.1) fail-closed, exactly as the
platform's other confidential apps do. The TypeScript plugins route through
the proxy and render its verdicts; they cannot weaken them. dsh's bulk is
treated as untrusted-for-isolation: it orchestrates, it is never the barrier.

## Layout

| Path | What |
|---|---|
| `proxy/` | Attested egress proxy (Go, fork toolchain). Routes: CAI `/v1/*`, tool apps. Enforcement: manager-served 6.1 set, per-session capability binding. |
| `bundle/plugins/llm-privasys` | `ctx.llm` adapter → CAI through the proxy; surfaces the reproducibility block as session events + a web-UI node renderer. |
| `bundle/plugins/tools-privasys` | `ctx.tools` registrations for the attested tool apps; `tools/post-execute` appends attestation evidence to the session log. |
| `bundle/plugins/approval-wallet` | `ctx.approval` provider → Privasys wallet push approval (operation-bound WebAuthn). |
| `bundle/plugins/runtime-privasys` | Boot glue: platform env, readiness, sealed-ingress identity (`X-Privasys-Sub` → session owner), trust-fence config. |
| `vendor-dsh/` | The dsh vendoring pin + procedure (source is vendored at image build, not committed here). |
| `Dockerfile` | The measured app image: node runtime + built dsh at the pin + bundle + proxy + entrypoint. |

## dsh pin

Current pin: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (release `dsh-0.1.1-rc.2`).
Upgrades are deliberate re-pin commits (rebase our patch queue, re-run the
seam-coverage audit, new measured image version) — never a floating branch.

## Tenancy and isolation (summary)

Multi-user from day one; tenancy is a deployment property (mutualised or
dedicated from one image). Isolation rails live in the auditable layer:
per-user vault-derived keys for session logs/files/credentials, proxy-bound
capabilities (a session's tool grants attach to its sealed-session subject in
the proxy), per-user execution world (Drive-scoped fs, per-session sandbox),
per-session workers. Cross-business mutualisation is gated on the rails
audit; dedicated deployments remain for blast-radius preference.

## Status

WS1 transport LANDED: the egress proxy carries live attested calls (fork
confidential-ai agent transport), WS2 the four plugins, WS3 packaging + dev
E2E, WS4 consent/store/docs, WS5 isolation rails.
