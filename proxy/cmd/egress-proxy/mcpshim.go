// Copyright (c) Privasys. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0.

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// MCP shim: /tool/{name}/mcp serves the Model Context Protocol (Streamable
// HTTP, stateless JSON responses) in front of a platform tool app's
// privasys_http surface (GET /api/v1/mcp/tools + POST /api/v1/mcp/tools/{fn}).
//
// Why here and not a dsh plugin: dsh's stock mcp-client (official MCP SDK)
// then needs only CONFIG to mount an attested tool app — no Node code — and
// the tool catalogue and every call cross the measured Go leg, where the
// declared-dependency gate has already vetted the peer (D2). The caller's
// Authorization header is forwarded verbatim; the shim holds no credentials.

const mcpProtocolVersion = "2025-03-26"

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func rpcResult(w http.ResponseWriter, id json.RawMessage, result any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func rpcError(w http.ResponseWriter, id json.RawMessage, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": msg},
	})
}

// upstreamTool is one entry of the privasys_http catalogue.
type upstreamTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

// mcpShim handles one JSON-RPC message for the tool app at host.
func mcpShim(w http.ResponseWriter, r *http.Request, client *http.Client, toolName, host string) {
	if r.Method == http.MethodGet {
		// No server-initiated stream in the stateless shim.
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if r.Method == http.MethodDelete {
		// Session teardown: nothing to tear down.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		rpcError(w, nil, -32700, "parse error")
		return
	}

	switch req.Method {
	case "initialize":
		rpcResult(w, req.ID, map[string]any{
			"protocolVersion": mcpProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{
				"name":    "privasys-egress-proxy/" + toolName,
				"version": "0.1.0",
			},
		})
	case "notifications/initialized", "notifications/cancelled":
		w.WriteHeader(http.StatusAccepted)
	case "ping":
		rpcResult(w, req.ID, map[string]any{})
	case "tools/list":
		tools, err := fetchCatalogue(r, client, host)
		if err != nil {
			rpcError(w, req.ID, -32000, fmt.Sprintf("catalogue: %v", err))
			return
		}
		out := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			schema := t.InputSchema
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object"}`)
			}
			out = append(out, map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"inputSchema": schema,
			})
		}
		rpcResult(w, req.ID, map[string]any{"tools": out})
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			rpcError(w, req.ID, -32602, "invalid params")
			return
		}
		args := p.Arguments
		if len(args) == 0 {
			args = json.RawMessage(`{}`)
		}
		result, status, err := callTool(r, client, host, p.Name, args)
		if err != nil {
			rpcError(w, req.ID, -32000, fmt.Sprintf("tool call: %v", err))
			return
		}
		// Non-2xx upstreams surface as tool errors the model can read,
		// not protocol errors that abort the loop.
		rpcResult(w, req.ID, map[string]any{
			"content": []map[string]any{{"type": "text", "text": string(result)}},
			"isError": status < 200 || status >= 300,
		})
	default:
		if len(req.ID) == 0 || string(req.ID) == "null" {
			w.WriteHeader(http.StatusAccepted) // unknown notification
			return
		}
		rpcError(w, req.ID, -32601, "method not found: "+req.Method)
	}
}

func fetchCatalogue(r *http.Request, client *http.Client, host string) ([]upstreamTool, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet,
		"https://"+host+"/api/v1/mcp/tools", nil)
	if err != nil {
		return nil, err
	}
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream HTTP %d: %s", resp.StatusCode, truncate(raw, 200))
	}
	var payload struct {
		Tools []upstreamTool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("parse catalogue: %w", err)
	}
	return payload.Tools, nil
}

func callTool(r *http.Request, client *http.Client, host, fn string, args json.RawMessage) (json.RawMessage, int, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		"https://"+host+"/api/v1/mcp/tools/"+fn, bytes.NewReader(args))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return raw, resp.StatusCode, nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
