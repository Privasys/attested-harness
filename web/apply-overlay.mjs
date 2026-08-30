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
// Rebrand: Privasys mark + name in dsh's brand slots, and the Privasys favicon.
put('packages/client/ui-brand-official/src/client/Brand.tsx', 'overlay/brand/Brand.tsx')
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

// --- 2b. connection requestRejection: defer the launch-token guard ----------
edit('packages/client/connection/src/rpc-host.ts', [
  [
    'requestRejection launch-token deferral',
    `  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {\n` +
      `    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403\n` +
      `    return this.browserAuth.isAuthenticated(request) ? undefined : 401\n` +
      `  }`,
    `  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {\n` +
      `    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403\n` +
      `    // Privasys: on the confidential platform dsh is reachable ONLY via the\n` +
      `    // enclave manager -> in-TCB egress-proxy (loopback), which forces a\n` +
      `    // trusted Host. The sealed CBOR-AES-GCM session the manager already\n` +
      `    // terminated IS the authentication, and the sealed relay cannot carry\n` +
      `    // dsh's per-process launch-token cookie — so a request that clears the\n` +
      `    // trusted-host fence is authenticated. Defer the browser token guard to\n` +
      `    // that attested ingress. (browserAuth still owns index/authenticatedUrl.)\n` +
      `    return undefined\n` +
      `  }`,
  ],
])

console.log('[overlay] done')
