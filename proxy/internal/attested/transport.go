// Copyright (c) Privasys. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0.

package attested

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	rc "enclave-os-mini/clients/go/ratls"
)

// RATLSTransport is an http.RoundTripper that carries each request over a
// freshly attested RA-TLS connection to the target enclave, instead of a
// gateway-terminated TLS leg.
//
// Why: the enclave gateways refuse plaintext app traffic on the terminated
// leg (403 sealed-transport-required) so user data can never transit the
// gateway in the clear — which is exactly what the agent loop's MCP calls
// are (tool arguments and results). RA-TLS terminates at the peer enclave
// itself (the gateway splices it through untouched, same hostname), passes
// that gate, AND attests the tool enclave before any data is sent — the
// enclave-to-enclave transport the platform's governance model expects.
//
// Per CONNECTION: dial with a fresh ClientHello challenge, verify the
// peer's quote binds it (challenge-response report data) plus the
// dependency gate and digest pins, then hand the verified *tls.Conn to a
// pooled http.Transport. Requests multiplexed over that connection inherit
// its handshake-bound attestation — the same verify-once-per-channel
// argument the sealed relay's pooled gateway legs use. Pooling matters:
// the old per-request shape re-ran the full handshake, quote verification,
// AND a manager-minted client certificate on every tool call, which
// dominated tool latency. On a declared-dependency change the DepSet's
// OnChange hook evicts idle connections, so a revoked build cannot keep
// serving over a stale verified channel. Non-HTTPS URLs (local dev against
// plain-HTTP MCP servers) fall through to the standard transport.
//
type RATLSTransport struct {
	// Timeout bounds connect + attestation verification per request.
	Timeout time.Duration
	// Plain serves non-HTTPS requests (local dev). Defaults to
	// http.DefaultTransport.
	Plain http.RoundTripper
	// ExpectedDigests optionally pins the workload the peer must be
	// running, keyed by lowercase hostname: after the attestation
	// verifies, the peer leaf's workload code hash (OID
	// 1.3.6.1.4.1.65230.4.2) must equal the pinned bare-hex digest or the
	// request is refused. This is what makes a granted tool's
	// expected_digest an enforced promise, not just UI copy: a tool
	// enclave that was redeployed with different code since the user
	// admitted it fails closed. Hosts without an entry are not pinned.
	ExpectedDigests map[string]string

	// Deps is the runtime-declared attested dependency set (OID 6.1). When
	// it is enabled, EVERY tool dial must match a declared entry — measured
	// identity + required OIDs — so what this enclave advertises on its own
	// leaf is exactly what it will talk to. The per-host digest pin above
	// still applies on top (a grant admits a specific build), giving one
	// verifier with two pin sources. Nil / disabled keeps the pre-6.1
	// behaviour: digest pins only.
	Deps *DepSet

	// getClientCert presents THIS enclave's attested client certificate when
	// a tool enclave asks for one (ingress mutual RA-TLS on the callee).
	// Built once and reused: the callback mints a fresh certificate per
	// connection, bound to that handshake's channel binder. Nil off platform
	// (no manager to mint from), which leaves the dial server-auth only —
	// exactly today's behaviour, so a tool that does not require a client
	// certificate is unaffected.
	//
	// This is what lets a callee identify the CALLER by attestation instead
	// of a shared secret: the minted certificate carries this workload's app
	// id (OID 3.6) and code hash (OID 3.2), which the callee's enclave-os
	// verifies and republishes as X-Privasys-Peer-*.
	getClientCert func(*tls.CertificateRequestInfo) (*tls.Certificate, error)
	// clientEvidence proves the presented identity on a connection when the
	// callee requires it (RA-TLS v2 mutual leg). Nil off platform.
	clientEvidence rc.ClientEvidenceSource

	// pool multiplexes requests over verified connections (built lazily;
	// dialVerified is the only way a connection enters it).
	pool     *http.Transport
	poolOnce sync.Once
}

// CloseIdleConnections evicts pooled verified connections. Wired to the
// DepSet's OnChange hook: a dependency-set change must re-verify peers on
// the next dial rather than ride an existing channel.
func (t *RATLSTransport) CloseIdleConnections() {
	if t.pool != nil {
		t.pool.CloseIdleConnections()
	}
}

// NewRATLSTransport returns a RoundTripper with sane defaults.
func NewRATLSTransport() *RATLSTransport {
	t := &RATLSTransport{Timeout: 15 * time.Second}
	if mgrURL := os.Getenv("PRIVASYS_MANAGER_URL"); mgrURL != "" {
		// The manager mints the identity (no evidence in it) and quotes it per
		// connection; both are fetched lazily, so off-platform dials stay
		// server-auth only.
		id := rc.NewEgressIdentity(mgrURL, os.Getenv("PRIVASYS_CONTAINER_TOKEN"))
		t.getClientCert = id.GetClientCertificate
		t.clientEvidence = id.ClientEvidence
	}
	return t
}

func (t *RATLSTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" {
		p := t.Plain
		if p == nil {
			p = http.DefaultTransport
		}
		return p.RoundTrip(req)
	}
	t.poolOnce.Do(func() {
		t.pool = &http.Transport{
			DialTLSContext: t.dialVerified,
			// HTTP/1.1 keep-alive over the verified channel. h2 is never
			// negotiated: the RA-TLS dial advertises the splice marker +
			// http/1.1 only (see rc.Connect).
			ForceAttemptHTTP2:   false,
			MaxIdleConns:        16,
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     90 * time.Second,
		}
	})
	return t.pool.RoundTrip(req)
}

// dialVerified performs one attested RA-TLS dial: fresh challenge, quote
// verification bound to THIS handshake, the declared-dependency gate, and
// the per-host workload digest pin — all BEFORE the connection is handed to
// the pool. A connection that returns from here is a verified channel; the
// pool multiplexes requests over it until it idles out or the dependency
// set changes (OnChange evicts idles).
func (t *RATLSTransport) dialVerified(_ context.Context, _ string, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		host, portStr = addr, "443"
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		port = 443
	}

	// Fresh nonce per connection: the peer must bind its quote to THIS
	// handshake (challenge-response report data), so a replayed cert or
	// intercepted session cannot pass verification.
	timeout := t.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	cli, err := rc.Connect(host, port, &rc.Options{
		ServerName: host,
		Timeout:    timeout,
		// Challenge mode (the default): the callee's evidence is bound to this
		// connection's exporter value and a fresh context, so a replayed
		// quote or an intercepted session cannot pass verification.
		// Mutual leg: answer a callee that requires an attested client
		// identity. Nil off platform, leaving the dial server-auth only.
		GetClientCertificate: t.getClientCert,
		ClientEvidence:       t.clientEvidence,
	})
	if err != nil {
		return nil, fmt.Errorf("ratls: connect %s: %w", host, err)
	}

	// Verify the enclave BEFORE the connection can carry any tool data.
	tee := teeOf(cli.Evidence())
	policy := &rc.VerificationPolicy{TEE: tee}
	info, verr := cli.VerifyCertificate(policy)
	if verr != nil {
		cli.Close()
		return nil, fmt.Errorf("ratls: %s attestation failed — refusing to send tool data: %w", host, verr)
	}

	// Declared-dependency gate: the peer must BE one of the dependencies
	// this workload advertises at OID 6.1 (app-id selects the entry, then
	// measurement any-of + required OIDs must all hold). Fails closed, and
	// refuses a peer whose app-id we never declared — so a catalogue or
	// control plane that starts pointing a tool at an unpinned host cannot
	// move our traffic there.
	if t.Deps != nil {
		grantPinned := t.ExpectedDigests[strings.ToLower(host)] != ""
		if derr := t.Deps.VerifyPeer(info, tee, grantPinned); derr != nil {
			cli.Close()
			return nil, fmt.Errorf("ratls: %s failed the declared-dependency gate — refusing to send tool data: %w", host, derr)
		}
	}

	// Per-host workload pinning: the attested leaf must carry the exact
	// workload code hash the caller admitted (OID 3.2).
	if want := t.ExpectedDigests[strings.ToLower(host)]; want != "" {
		got := ""
		for _, ext := range info.CustomOids {
			if ext.OID == rc.OidWorkloadCodeHash {
				got = strings.ToLower(fmt.Sprintf("%x", ext.Value))
				break
			}
		}
		if !strings.EqualFold(got, want) {
			cli.Close()
			return nil, fmt.Errorf(
				"ratls: %s workload digest mismatch — enclave runs %s but the tool was admitted at %s; refusing to send tool data (the app changed since it was added)",
				host, orUnset(got), want)
		}
	}

	return cli.Conn(), nil
}

// orUnset renders an empty digest readably in refusal messages.
func orUnset(v string) string {
	if v == "" {
		return "(no workload digest)"
	}
	return v
}

// teeOf maps the evidence family of a connection to the TEE type the
// verification policy expects ("tdx" and "tdx-gpu" are TDX; anything else SGX).
func teeOf(ev *rc.Evidence) rc.TeeType {
	if ev != nil && strings.HasPrefix(ev.TEE, "tdx") {
		return rc.TeeTypeTDX
	}
	return rc.TeeTypeSGX
}
