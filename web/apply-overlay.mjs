// Apply the Privasys attested-harness web overlay onto a vendored dsh tree.
//
// This is the sanctioned patch-queue divergence (D8: extend-don't-fork). It:
//   1. copies NEW files (no rebase conflicts):
//        - apps/web/src/main.ts                    (gated boot)
//        - apps/web/index.html                     (shell script + roots)
//        - packages/client/connection/src/client/privasys-api-client.ts
//        - apps/web/public/privasys/*              (shell bundle + SDK IIFE)
//   2. applies two anchored edits (fail the build if the anchor moved under a
//      re-pin — that is the signal to rebase the patch, never a silent skip):
//        - client/index.ts apply(): select the sealed carrier when
//          window.__PRIVASYS_SEALED__ is present
//        - connection/src/index.ts: drop the 426 fence so GET /api/events.*
//          falls through to the already-present SSE responder
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
put(
  'packages/client/connection/src/client/privasys-api-client.ts',
  'overlay/connection/privasys-api-client.ts',
)
// Shell assets served as static public files by vite (public/ -> dist/).
put('apps/web/public/privasys/privasys-shell.js', 'privasys-shell.js')
put('apps/web/public/privasys/privasys-shell.css', 'privasys-shell.css')
put('apps/web/public/privasys/privasys-auth-client.iife.js', 'vendor/privasys-auth-client.iife.js')
put('apps/web/public/privasys/privasys-logo.mini.svg', 'vendor/privasys-logo.mini.svg')
// Rebrand: Privasys mark + name in dsh's brand slots, and the Privasys favicon.
put('packages/client/ui-brand-official/src/client/Brand.tsx', 'overlay/brand/Brand.tsx')
put('apps/web/public/favicon.svg', 'vendor/privasys-logo.mini.svg')

// --- 2a. client/index.ts: select the sealed carrier -------------------------
edit('packages/client/connection/src/client/index.ts', [
  [
    'import PrivasysApiClient',
    `import { WebApiClient } from './web-api-client.ts'`,
    `import { WebApiClient } from './web-api-client.ts'\n` +
      `import { PrivasysApiClient, sealedRpcFetch, type SealedHandle } from './privasys-api-client.ts'`,
  ],
  [
    'sealed carrier selector',
    `  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__\n` +
      `  const api: IApiClient = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()\n` +
      `  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc(transport?.fetch)`,
    `  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__\n` +
      `  // Privasys: a sealed session published by the auth shell wins over the\n` +
      `  // stock WebSocket carrier — the confidential platform relays HTTP + SSE only.\n` +
      `  const sealed = (globalThis as { __PRIVASYS_SEALED__?: SealedHandle }).__PRIVASYS_SEALED__\n` +
      `  const api: IApiClient = fixtureClient\n` +
      `    ?? (sealed ? new PrivasysApiClient(sealed) : (transport?.createApiClient() ?? new WebApiClient()))\n` +
      `  const rpc = fixtureClient?.rpc\n` +
      `    ?? createWebConnectionRpc(sealed ? sealedRpcFetch(sealed) : transport?.fetch)`,
  ],
])

// --- 2a-bis. register the new file in the connection tsconfig (explicit
// `files` project — TS6307 without this). ------------------------------------
edit('packages/client/connection/tsconfig.client.json', [
  [
    'privasys-api-client tsconfig entry',
    `    "src/client/web-api-client.ts",`,
    `    "src/client/web-api-client.ts",\n    "src/client/privasys-api-client.ts",`,
  ],
])

// --- 2b. connection/src/index.ts: drop the 426 WebSocket fence --------------
edit('packages/client/connection/src/index.ts', [
  [
    '426 upgrade-required fence',
    `      if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {\n` +
      `        return new Response('upgrade required', {\n` +
      `          status: 426,\n` +
      `          headers: { connection: 'Upgrade', upgrade: 'websocket' },\n` +
      `        })\n` +
      `      }\n`,
    `      // Privasys: the 426 WebSocket fence is removed so GET /api/events.*\n` +
      `      // falls through to the apiProxy's built-in SSE responder, which the\n` +
      `      // sealed HTTP relay can carry (WebSockets cannot traverse it).\n`,
  ],
])

console.log('[overlay] done')
