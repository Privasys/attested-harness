// Apply the Privasys attested-harness web overlay onto a vendored dsh tree.
//
// This is the sanctioned patch-queue divergence (D8: extend-don't-fork), rebased
// for dsh v0.1.2-alpha (the @Remote gateway; the legacy APIProxy/AbstractApiClient
// was removed). It:
//   1. copies NEW / replaced files (no rebase conflicts):
//        - apps/web/src/main.ts                    (gated boot)
//        - apps/web/index.html                     (shell script + roots)
//        - apps/web/public/privasys/*              (shell bundle + SDK IIFE)
//        - ui-brand-official Brand.tsx             (Privasys mark/name in the slots)
//        - favicon.svg                             (Privasys logo)
//   2. applies THREE anchored edits (fail the build if an anchor moved under a
//      re-pin — that is the signal to rebase the patch, never a silent skip):
//        (a) gateway mux server: accept binary WebSocket frames. The sealed relay
//            (enclave-os sessionrelay/websocket.go) writes client->app frames as
//            binary; dsh's server otherwise closes them 1003. rawText() already
//            decodes bytes as UTF-8, so we accept both opcodes.
//        (b) connection requestRejection: defer the alpha's browser launch-token
//            401 guard to the attested ingress. On the confidential platform dsh
//            is reachable only via the enclave manager -> in-TCB egress-proxy
//            (trusted Host); the sealed session the manager already terminated IS
//            the auth, and the sealed relay cannot carry dsh's per-process cookie.
//
// The sealed TRANSPORT is injected at runtime by the vanilla shell
// (privasys-shell.js: window.__DSH_TRANSPORT__.fetch + a mux WebSocket adapter),
// so NO dsh transport source is patched (the old privasys-api-client.ts,
// client/index.ts selector, tsconfig entry and 426 fence edits are all gone).
// No package.json is touched, so the frozen lockfile still holds.
//
// Usage: node apply-overlay.mjs <dsh-root>
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dsh = process.argv[2]
if (!dsh) {
  console.error('usage: node apply-overlay.mjs <dsh-root>')
  process.exit(1)
}

function edit(rel, transforms) {
  const path = join(dsh, rel)
  let src = readFileSync(path, 'utf8')
  for (const [label, find, replace] of transforms) {
    if (!src.includes(find)) {
      throw new Error(`overlay anchor MISSING in ${rel}: "${label}". Upstream changed — rebase the patch.`)
    }
    src = src.replace(find, replace)
  }
  writeFileSync(path, src)
  console.log(`[overlay] patched ${rel}`)
}

function put(rel, from) {
  const dest = join(dsh, rel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(here, from), dest)
  console.log(`[overlay] wrote ${rel}`)
}

// --- 1. new / replaced files ------------------------------------------------
put('apps/web/src/main.ts', 'overlay/apps-web/main.ts')
put('apps/web/index.html', 'overlay/apps-web/index.html')
// Shell assets served as static public files by vite (public/ -> dist/).
put('apps/web/public/privasys/privasys-shell.js', 'privasys-shell.js')
put('apps/web/public/privasys/privasys-shell.css', 'privasys-shell.css')
put('apps/web/public/privasys/privasys-auth-client.iife.js', 'vendor/privasys-auth-client.iife.js')
put('apps/web/public/privasys/privasys-logo.mini.svg', 'vendor/privasys-logo.mini.svg')
// Rebrand at the SOURCE: FishLogo/BrandWordmark in ui-primitives carry every
// brand surface (the sidebar mark, the wordmark, and the conversation hero's
// animated fallback, which composes its own svg from FISH_LOGO_PATH) — so the
// stock ui-brand-official Brand.tsx needs no override on the alpha. Its
// index.ts IS overridden: it keeps upstream's brand registrations and adds the
// two Privasys sidebar-foot rows (Attestation "Verified" + User/Sign out) into
// the sidebar.footer.action list slot, next to Settings.
put('packages/client/ui-primitives/src/FishLogo.tsx', 'overlay/brand/FishLogo.tsx')
put('packages/client/ui-primitives/src/BrandWordmark.tsx', 'overlay/brand/BrandWordmark.tsx')
put('packages/client/ui-brand-official/src/client/index.ts', 'overlay/brand/index.ts')
put('packages/client/ui-brand-official/src/client/PrivasysRows.tsx', 'overlay/brand/PrivasysRows.tsx')
put('apps/web/public/favicon.svg', 'vendor/privasys-logo.mini.svg')

// --- 2a. gateway mux server: accept binary frames ---------------------------
edit('packages/api/gateway/src/stream-server.ts', [
  [
    'mux server binary-frame acceptance',
    `      this.socket.on('message', (data, isBinary) => {\n` +
      `        if (isBinary) {\n` +
      `          this.socket.close(1003, 'text messages required')\n` +
      `          return\n` +
      `        }\n` +
      `        try {\n` +
      `          this.receive(rawText(data))\n` +
      `        } catch {\n` +
      `          this.socket.close(1008, 'invalid Remote stream request')\n` +
      `        }\n` +
      `      })`,
    `      this.socket.on('message', (data, _isBinary) => {\n` +
      `        // Privasys: the sealed relay (enclave-os sessionrelay/websocket.go)\n` +
      `        // writes client->app frames as binary; rawText() decodes\n` +
      `        // Buffer/ArrayBuffer as UTF-8, so accept both opcodes instead of\n` +
      `        // rejecting binary.\n` +
      `        try {\n` +
      `          this.receive(rawText(data))\n` +
      `        } catch {\n` +
      `          this.socket.close(1008, 'invalid Remote stream request')\n` +
      `        }\n` +
      `      })`,
  ],
])

// --- 2b. connection: defer the alpha's browser launch-token guard to the
//         attested ingress, for BOTH the /api fence and the index (GET /).
//         On the confidential platform dsh is reachable ONLY via the enclave
//         manager -> in-TCB egress-proxy (loopback), which forces a trusted
//         Host; the sealed CBOR-AES-GCM session the manager already terminated
//         IS the authentication, and the sealed relay cannot carry dsh's
//         per-process launch-token cookie. So a request that clears the
//         trusted-host fence is authenticated. (browserAuth still owns
//         authenticatedUrl + the token/cookie machinery for direct use.)
edit('packages/client/connection/src/rpc-host.ts', [
  [
    'requestRejection launch-token deferral',
    `  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {\n` +
      `    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403\n` +
      `    return this.browserAuth.isAuthenticated(request) ? undefined : 401\n` +
      `  }`,
    `  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {\n` +
      `    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403\n` +
      `    // Privasys: trusted Host == attested ingress == authenticated (see note above).\n` +
      `    return undefined\n` +
      `  }`,
  ],
  [
    'authorizeIndex launch-token deferral',
    `  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {\n` +
      `    return this.browserAuth.authorizeIndex(request, response)\n` +
      `  }`,
    `  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {\n` +
      `    // Privasys: a trusted-host index request came through the measured\n` +
      `    // ingress, so serve the SPA without the launch-token cookie the sealed\n` +
      `    // relay cannot carry (ConnectionIndexRequest extends ConnectionTrustRequest).\n` +
      `    if (isTrustedApiRequest(request, this.trustedHosts)) return true\n` +
      `    return this.browserAuth.authorizeIndex(request, response)\n` +
      `  }`,
  ],
])

// --- 2c. agent presets: drop the built-in web tool row ----------------------
// The profile layer disables the `web` service (the agent's only egress is the
// attested fleet), but each agent preset mounts `tool-web` in its OWN
// composition tree, which profile patches do not reach — the row then waits on
// the missing `web` service forever and the whole preset fails to mount
// ("session create failed: preset ... 1 row(s) did not activate"). Remove the
// row from every preset that carries it (identical block in all three).
const TOOL_WEB_BLOCK =
  `# The \`web\` service and its search provider stay in the host composition; only\n` +
  `# the model-facing tool is per-session.\n` +
  `- id: tool-web\n` +
  `  name: '@deepseek-ai/dsh-tool-web'\n` +
  `  config:\n` +
  `    fetch: true\n` +
  `    searchTimeoutMs: 60000\n`
for (const preset of ['standard', 'ptc', 'cordis']) {
  edit(`packages/preset/agent-presets/presets/${preset}/agent.cordis.yml`, [
    [
      `preset ${preset} tool-web removal`,
      TOOL_WEB_BLOCK,
      `# Privasys: the built-in web tool is removed — web access rides the attested\n` +
        `# MCP fleet (mcp__web_search__*, mcp__web_reader__*) via the egress proxy.\n`,
    ],
  ])
}

// --- 2d. cache_salt: partition the confidential backend's prefix cache ------
// vLLM behind Confidential AI supports a per-request `cache_salt`; dsh's
// designed seam is the deepseek-llm-api-extensions registry (extra top-level
// body fields, sessionId provided per request). Self-register in the registry's
// constructor so no extra plugin row or package is needed; the session id is
// stable per session and unique across sessions — exactly the salt contract.
edit('packages/llm/deepseek-llm-api-extensions/src/types.ts', [
  [
    'extension map cache_salt merge',
    `export interface DeepSeekLlmApiExtensionMap {}`,
    `export interface DeepSeekLlmApiExtensionMap {\n` +
      `  /** Privasys: per-session prefix-cache partition salt (vLLM cache_salt). */\n` +
      `  cache_salt: string\n` +
      `}`,
  ],
])
edit('packages/llm/deepseek-llm-api-extensions/src/index.ts', [
  [
    'registry constructor cache_salt registration',
    `  constructor(ctx: Context) {\n` +
      `    super(ctx, 'deepseekLlmApiExtensions')\n` +
      `  }`,
    `  constructor(ctx: Context) {\n` +
      `    super(ctx, 'deepseekLlmApiExtensions')\n` +
      `    // Privasys: partition the confidential backend's prefix cache per\n` +
      `    // session (vLLM cache_salt) so sessions never share cached prefixes.\n` +
      `    this.register('cache_salt', {\n` +
      `      prepare: request => request.sessionId === undefined\n` +
      `        ? undefined\n` +
      `        : { value: request.sessionId },\n` +
      `    })\n` +
      `  }`,
  ],
])

// --- 2e. preset personas: Privasys identity ---------------------------------
// Preset dsh-persona rows SHADOW the deployment persona (same section name in
// the agent scope), so the profile-level Privasys persona never shows in
// preset sessions — rewrite the preset texts themselves.
const PRIVASYS_PERSONA =
  `      You are a coding agent of the Privasys Attested Harness, powered by the {{model}} model running in a hardware-attested confidential enclave. Your working directory is {{cwd}}.`
for (const preset of ['standard', 'ptc']) {
  edit(`packages/preset/agent-presets/presets/${preset}/agent.cordis.yml`, [
    [
      `preset ${preset} persona rebrand`,
      `      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`,
      PRIVASYS_PERSONA,
    ],
  ])
}
edit('packages/preset/agent-presets/presets/cordis/agent.cordis.yml', [
  [
    'preset cordis persona rebrand',
    `      You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.`,
    PRIVASYS_PERSONA,
  ],
])

// --- 2f. trajectory "Attestation" detail tab --------------------------------
// The Inspect view's detail tabs are HARDCODED in TrajectoryTable.tsx (no slot
// exists — verified against the generated slot catalog), so the sixth tab
// needs three anchored edits + locale keys. The tab component itself is a new
// file (overlay/trajectory/PrivasysAttestationTab.tsx, react+fetch only).
put(
  'packages/client/ui-trajectory/src/client/PrivasysAttestationTab.tsx',
  'overlay/trajectory/PrivasysAttestationTab.tsx',
)
edit('packages/client/ui-trajectory/src/client/TrajectoryTable.tsx', [
  [
    'attestation tab import',
    `import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'`,
    `import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'\n` +
      `import { PrivasysAttestationTab } from './PrivasysAttestationTab.tsx'`,
  ],
  [
    'DetailTab union attestation',
    `  | 'timing'\n  | 'diff'\ntype RecordState`,
    `  | 'timing'\n  | 'diff'\n  | 'attestation'\ntype RecordState`,
  ],
  [
    'detailTabs tool branch attestation',
    `  return [\n` +
      `    { id: 'overview', labelKey: 'tab.summary' },\n` +
      `    ...(record.cell.inputDetail ? [{ id: 'input', labelKey: 'tab.payload' } as const] : []),\n` +
      `    ...(record.cell.outputDetail ? [{ id: 'output', labelKey: 'tab.result' } as const] : []),\n` +
      `    { id: 'schema', labelKey: 'tab.schema' },\n` +
      `    { id: 'timing', labelKey: 'tab.timing' },\n` +
      `  ]`,
    `  return [\n` +
      `    { id: 'overview', labelKey: 'tab.summary' },\n` +
      `    ...(record.cell.inputDetail ? [{ id: 'input', labelKey: 'tab.payload' } as const] : []),\n` +
      `    ...(record.cell.outputDetail ? [{ id: 'output', labelKey: 'tab.result' } as const] : []),\n` +
      `    { id: 'schema', labelKey: 'tab.schema' },\n` +
      `    { id: 'timing', labelKey: 'tab.timing' },\n` +
      `    { id: 'attestation', labelKey: 'tab.attestation' },\n` +
      `  ]`,
  ],
  [
    'attestation tab panel',
    `            {!promptSelected && selected !== undefined && activeTab === 'timing' && (\n` +
      `              <RecordTiming record={selected} t={t} />\n` +
      `            )}`,
    `            {!promptSelected && selected !== undefined && activeTab === 'timing' && (\n` +
      `              <RecordTiming record={selected} t={t} />\n` +
      `            )}\n` +
      `            {!promptSelected && selected !== undefined && activeTab === 'attestation' && (\n` +
      `              <PrivasysAttestationTab toolWireName={selected.cell.text} />\n` +
      `            )}`,
  ],
])
edit('packages/client/ui-trajectory/src/client/locales.ts', [
  [
    'zh tab.attestation',
    `  'tab.timing': '计时',`,
    `  'tab.timing': '计时',\n  'tab.attestation': '远程证明',`,
  ],
  [
    'en tab.attestation',
    `  'tab.timing': 'Timing',`,
    `  'tab.timing': 'Timing',\n  'tab.attestation': 'Attestation',`,
  ],
])

// --- 3. shared attestation view (vendored AS SOURCE) + its stylesheet -------
// The SAME @privasys/attestation-view every Privasys property renders
// (canonical: websites/libs/attestation-view), placed into ui-brand-official
// so the sidebar row compiles against it. The stylesheet is the lib's Tailwind
// utilities pre-extracted to a static file (theme + utilities layers ONLY — no
// preflight, so dsh's own styling is untouched).
for (const rel of [
  'index.ts', 'types.ts', 'use-attestation.ts',
  'components/attestation-result-view.tsx', 'components/composite-attestation-view.tsx',
  'components/attestation-connect.tsx', 'components/badge.tsx', 'components/field-row.tsx',
  'internal/use-copy.ts',
]) {
  put(`packages/client/ui-brand-official/src/client/attestation-view/${rel}`, `vendor/attestation-view/${rel}`)
}
put('packages/client/ui-brand-official/src/client/PrivasysAttestation.tsx', 'overlay/brand/PrivasysAttestation.tsx')
put('apps/web/public/privasys/privasys-attestation.css', 'vendor/privasys-attestation.css')

console.log('[overlay] done')
