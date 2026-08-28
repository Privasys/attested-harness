/**
 * Web application entry — Privasys attested-harness variant.
 *
 * Upstream this file just mounts AppWebEntry immediately. On the confidential
 * platform the app is unreachable until a sealed session is established, so we
 * DEFER the boot: the Privasys shell (privasys-shell.js, a separate bundle)
 * runs the sign-in ceremony, publishes the sealed session on
 * `window.__PRIVASYS_SEALED__`, and then calls `window.__PRIVASYS_BOOT__()`.
 * dsh's connection plugin reads `__PRIVASYS_SEALED__` when it applies and
 * routes its whole API (unary RPC + SSE downlinks) through the sealed session
 * (see packages/client/connection/src/client/index.ts + privasys-api-client.ts).
 *
 * Divergence from upstream: this whole file. Kept intentionally tiny so the
 * rebasing patch queue stays trivial.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')

declare global {
    interface Window {
        __PRIVASYS_BOOT__?: () => void
        __PRIVASYS_SEALED__?: unknown
    }
}

let booted = false
window.__PRIVASYS_BOOT__ = (): void => {
    if (booted) return
    booted = true
    void new AppWebEntry(el).run()
}
