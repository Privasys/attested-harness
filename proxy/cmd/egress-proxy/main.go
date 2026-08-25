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
// WS1 status: skeleton. The RA-TLS transport and DepSet enforcement are
// extracted from confidential-ai/internal/agent (ratls_transport.go +
// depset.go) in the next commit, which also brings the fork-toolchain build
// (-tags ratls) and the ra-tls-clients sibling module, mirroring the
// confidential-ai build.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

type config struct {
	// listenAddr is the loopback address the dsh plugins call.
	listenAddr string
	// managerURL + containerName + containerToken locate the manager's
	// per-container dependency endpoint (GET .../containers/{name}/dependencies),
	// the same source confidential-ai's DepSet enforces from.
	managerURL     string
	containerName  string
	containerToken string
}

func loadConfig() config {
	c := config{
		listenAddr:     envOr("EGRESS_PROXY_LISTEN", "127.0.0.1:9411"),
		managerURL:     os.Getenv("PRIVASYS_MANAGER_URL"),
		containerName:  os.Getenv("PRIVASYS_CONTAINER_NAME"),
		containerToken: os.Getenv("PRIVASYS_CONTAINER_TOKEN"),
	}
	return c
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	cfg := loadConfig()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, `{"status":"ok","component":"egress-proxy"}`)
	})
	// Route table (WS1): /model/* → CAI, /tool/{name}/* → the named tool
	// app, both over the attested transport with 6.1 enforcement. Until the
	// transport lands, refuse loudly rather than pass through unattested.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w,
			`{"error":"egress-proxy: attested transport not wired yet (WS1); refusing unattested egress"}`,
			http.StatusNotImplemented)
	})

	log.Printf("[egress-proxy] listening on %s (manager=%s container=%s)",
		cfg.listenAddr, cfg.managerURL, cfg.containerName)
	if err := http.ListenAndServe(cfg.listenAddr, mux); err != nil {
		log.Fatalf("[egress-proxy] listen: %v", err)
	}
}
