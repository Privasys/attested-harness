// Copyright (c) Privasys. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0.

package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
)

// Reproducibility capture for the /model leg.
//
// Confidential AI emits its reproducibility block only to callers that opt in
// (X-Privasys-Reproducibility), because stock OpenAI clients reject unknown
// trailing SSE frames. dsh's SSE translator skips frames without `choices`,
// so the proxy opts in ON BEHALF of the harness and the frame passes through
// to the plugins untouched — a dsh-side renderer can surface it later, while
// the proxy already records the audit line: every model call's seed, model,
// and dependency fold, captured on the attested leg itself (D2: the trust
// artifact is handled by the measured Go side, never left to Node to
// request or drop).

// injectReproOptIn opts the upstream request into the reproducibility
// extension unless the caller already chose.
func injectReproOptIn(req *http.Request) {
	if req.Header.Get("X-Privasys-Reproducibility") == "" {
		req.Header.Set("X-Privasys-Reproducibility", "1")
	}
}

// reproFields is the subset of the reproducibility block worth an audit line.
type reproFields struct {
	RequestID      string `json:"request_id"`
	Model          string `json:"model"`
	Seed           *int64 `json:"seed"`
	VLLMVersion    string `json:"vllm_version"`
	CachedTokens   *int64 `json:"cached_tokens"`
	DependencyFold string `json:"dependency_fold"`
}

func logRepro(where string, raw json.RawMessage) {
	var f reproFields
	if err := json.Unmarshal(raw, &f); err != nil {
		return
	}
	seed := int64(-1)
	if f.Seed != nil {
		seed = *f.Seed
	}
	cached := int64(-1)
	if f.CachedTokens != nil {
		cached = *f.CachedTokens
	}
	log.Printf("[egress-proxy repro] %s request_id=%s model=%s seed=%d vllm=%s cached_tokens=%d",
		where, f.RequestID, f.Model, seed, f.VLLMVersion, cached)
}

// reproScanBody wraps an SSE response body: it streams every byte through
// unchanged while watching for the trailing `data: {"reproducibility":...}`
// frame and logging it when seen. Line-oriented (SSE frames are lines); a
// line longer than the scanner buffer passes through unscanned rather than
// failing the stream.
type reproScanBody struct {
	rc     io.ReadCloser
	br     *bufio.Reader
	buf    []byte // current line remainder being served to the caller
	logged bool
}

func newReproScanBody(rc io.ReadCloser) *reproScanBody {
	return &reproScanBody{rc: rc, br: bufio.NewReaderSize(rc, 64<<10)}
}

func (b *reproScanBody) Read(p []byte) (int, error) {
	if len(b.buf) == 0 {
		line, err := b.br.ReadBytes('\n')
		if len(line) > 0 {
			b.scan(line)
			b.buf = line
		}
		if len(b.buf) == 0 {
			return 0, err
		}
	}
	n := copy(p, b.buf)
	b.buf = b.buf[n:]
	return n, nil
}

func (b *reproScanBody) scan(line []byte) {
	if b.logged {
		return
	}
	s := strings.TrimSpace(string(line))
	if !strings.HasPrefix(s, "data:") {
		return
	}
	payload := strings.TrimSpace(strings.TrimPrefix(s, "data:"))
	if !strings.Contains(payload, `"reproducibility"`) {
		return
	}
	var frame struct {
		Reproducibility json.RawMessage `json:"reproducibility"`
	}
	if err := json.Unmarshal([]byte(payload), &frame); err != nil || frame.Reproducibility == nil {
		return
	}
	logRepro("stream", frame.Reproducibility)
	b.logged = true
}

func (b *reproScanBody) Close() error { return b.rc.Close() }
