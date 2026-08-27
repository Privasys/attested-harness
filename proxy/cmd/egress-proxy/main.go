// Copyright (c) Privasys. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0.

// egress-proxy is the attested egress leg of the harness app: a localhost
// listener through which every outbound attested call — Confidential AI
// inference, tool apps — must pass. It terminates plain HTTP from the dsh
// plugins and dials the peer over mutual RA-TLS (challenge extension via the
// Privasys Go fork), enforcing the app's declared dependency set (OID
// 65230.6.1) fail-closed.
//
// Design rule (D2): attestation authority never lives in Node. The dsh-side
// plugins route through this proxy and render its verdicts; they cannot
// weaken them.
//
// Routes:
//
//	GET  /healthz                 liveness + current dependency fold
//	ANY  /model/<path>            -> https://$HARNESS_MODEL_HOST/<path>
//	ANY  /tool/{name}/<path>      -> https://<host from $HARNESS_TOOL_HOSTS>/<path>
//
// Every upstream dial is attested per request (fresh challenge nonce, quote
// verification, declared-dependency gate, mutual client cert when the callee
// asks). A peer that is not in the 6.1 set is refused — the WS1 posture has
// no tool-grant passthrough yet (grantPinned is always false); per-session
// user tools arrive with WS2.
//
// Build: production images use the Privasys Go fork with -tags ratls (the
// ClientHello challenge extension). A stock-toolchain build compiles but
// Connect fails at runtime, so every egress refuses — fail closed, never
// fail open.
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Privasys/attested-harness/proxy/internal/attested"
)

type config struct {
	// listenAddr is the loopback address the dsh plugins call.
	listenAddr string
	// modelHost is the Confidential AI hostname behind /model/*.
	modelHost string
	// toolHosts maps a tool name (the /tool/{name}/ segment) to its
	// hostname. WS1: static from HARNESS_TOOL_HOSTS
	// ("drive=privasys-drive.apps.privasys.org,web_search=...");
	// WS2 replaces this with the fleet tool-spec.
	toolHosts map[string]string
	// onPlatform is true when the enclave manager is reachable
	// (PRIVASYS_MANAGER_URL set): the proxy then has an attested client
	// identity and dials peers with it, so CAI authenticates the harness as
	// an attested APP (X-Privasys-Peer-*) and the dsh-supplied bearer is
	// dropped. Off platform (dev) the bearer is the only credential and is
	// forwarded unchanged.
	onPlatform bool
}

func loadConfig() config {
	c := config{
		listenAddr: envOr("EGRESS_PROXY_LISTEN", "127.0.0.1:9411"),
		modelHost:  os.Getenv("HARNESS_MODEL_HOST"),
		toolHosts:  map[string]string{},
		onPlatform: os.Getenv("PRIVASYS_MANAGER_URL") != "",
	}
	for _, kv := range strings.Split(os.Getenv("HARNESS_TOOL_HOSTS"), ",") {
		if name, host, ok := strings.Cut(strings.TrimSpace(kv), "="); ok && name != "" && host != "" {
			c.toolHosts[name] = host
		}
	}
	return c
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// forward re-issues the inbound request against https://<host><path> over the
// attested client and streams the response back. The upstream transport does
// the whole trust dance; this function only rewrites the target.
func forward(w http.ResponseWriter, r *http.Request, client *http.Client, host, path string, repro bool) {
	if path == "" || path[0] != '/' {
		path = "/" + path
	}
	url := "https://" + host + path
	if r.URL.RawQuery != "" {
		url += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, url, r.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"egress-proxy: build request: %v"}`, err), http.StatusBadGateway)
		return
	}
	req.Header = r.Header.Clone()
	// The plugin-to-proxy hop is loopback: upstream compression only turns
	// the SSE stream into opaque bytes the repro scanner (and any future
	// in-proxy policy) cannot read. Plaintext end-to-end.
	req.Header.Del("Accept-Encoding")
	req.Host = host
	if repro {
		injectReproOptIn(req)
	}
	resp, err := client.Do(req)
	if err != nil {
		// Attestation refusals land here: surface the exact verdict to the
		// plugin so the session log records WHY the leg was refused.
		http.Error(w, fmt.Sprintf(`{"error":"egress-proxy: %v"}`, err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	body := resp.Body
	if repro {
		log.Printf("[egress-proxy] model leg: %s %s -> %d %s", r.Method, path, resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if repro && strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		body = newReproScanBody(resp.Body)
	}
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	// Flush per read so SSE deltas reach the plugin as they arrive instead
	// of buffering into one burst at stream end.
	if f, ok := w.(http.Flusher); ok {
		buf := make([]byte, 32<<10)
		for {
			n, rerr := body.Read(buf)
			if n > 0 {
				w.Write(buf[:n])
				f.Flush()
			}
			if rerr != nil {
				return
			}
		}
	}
	io.Copy(w, body)
}

func main() {
	cfg := loadConfig()

	// The declared dependency set is the proxy's routing authority: refresh
	// it from the enclave manager for the life of the process. Off platform
	// (no PRIVASYS_MANAGER_URL) it stays disabled and only the legacy
	// per-host pins would apply — the WS1 proxy sets none, so every attested
	// dial then relies on quote verification alone (dev only).
	deps := attested.NewDepSet()
	deps.Start(time.Minute)

	transport := attested.NewRATLSTransport()
	transport.Deps = deps
	client := &http.Client{Transport: transport, Timeout: 5 * time.Minute}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"status":"ok","component":"egress-proxy","dependency_fold":%q}`+"\n", deps.Fold())
	})
	mux.HandleFunc("/model/", func(w http.ResponseWriter, r *http.Request) {
		if cfg.modelHost == "" {
			http.Error(w, `{"error":"egress-proxy: HARNESS_MODEL_HOST not configured"}`, http.StatusNotImplemented)
			return
		}
		// On-platform: drop dsh's Authorization bearer so CAI authenticates
		// the harness as an attested app (mutual RA-TLS peer identity), not a
		// token. Off platform the bearer is the only credential — keep it.
		if cfg.onPlatform {
			r.Header.Del("Authorization")
		}
		forward(w, r, client, cfg.modelHost, strings.TrimPrefix(r.URL.Path, "/model"), true)
	})
	mux.HandleFunc("/tool/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/tool/")
		name, path, _ := strings.Cut(rest, "/")
		host := cfg.toolHosts[name]
		if host == "" {
			http.Error(w, fmt.Sprintf(`{"error":"egress-proxy: unknown tool %q"}`, name), http.StatusNotFound)
			return
		}
		// /tool/{name}/mcp speaks MCP (Streamable HTTP) so dsh's stock
		// mcp-client mounts the tool app by configuration alone; any other
		// path forwards verbatim for direct callers.
		if path == "mcp" {
			mcpShim(w, r, client, name, host)
			return
		}
		forward(w, r, client, host, "/"+path, false)
	})
	// Anything else is a routing bug in the caller, never a passthrough.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"egress-proxy: unrouted path; only /model/* and /tool/{name}/* egress"}`, http.StatusNotFound)
	})

	log.Printf("[egress-proxy] listening on %s (model=%s tools=%d on_platform=%v deps_enabled=%v)",
		cfg.listenAddr, cfg.modelHost, len(cfg.toolHosts), cfg.onPlatform, deps.Enabled())
	if err := http.ListenAndServe(cfg.listenAddr, mux); err != nil {
		log.Fatalf("[egress-proxy] listen: %v", err)
	}
}
