// @ts-nocheck -- interop with the vendored attestation-view (see the note in
// ui-brand-official/src/client/PrivasysAttestation.tsx).
/**
 * "Attestation" detail tab for the trajectory Inspect view (attested-harness
 * fork; placed into ui-trajectory by apply-overlay, wired via anchored edits
 * in TrajectoryTable.tsx + locale keys).
 *
 * For an MCP fleet tool it renders the SHARED @privasys/attestation-view
 * report (refresh, challenge, quote verification — the same surface as
 * chat/drive and the sidebar's Secure Hardware Attestation) against the TOOL
 * app's live /attest endpoint, with the harness's PINNED identity (from the
 * same-origin /privasys/attestation summary the egress proxy serves) fed in
 * as expectations — so the view itself proves live-matches-pinned. Harness-
 * local tools point at the enclave's own report in the sidebar.
 */
import { useEffect, useState } from 'react'
import {
  AttestationResultView,
  AttestationStatusBadge,
  attestationStatusOf,
  computeAttestationSummary,
  useAttestation,
} from './attestation-view/index.ts'

/** Wire-name prefix map: MCP server -> platform app id (prod control plane). */
const SERVER_APPS: Readonly<Record<string, { appId: string; label: string }>> = {
  web_search: { appId: '82cb3965811d4ad298cac29e4837fd45', label: 'Web Search (Brave)' },
  web_reader: { appId: '09965ab93f2e480ea0417cce438f0696', label: 'Web Reader (Lightpanda)' },
  drive: { appId: 'cf7a0d585468416884c341ebe0ce4025', label: 'Privasys Drive' },
}
const TOOLS_CONTROL_PLANE = 'https://api.developer.privasys.org'

function shellConfig() {
  return (globalThis as { __PRIVASYS_SHELL__?: Record<string, unknown> }).__PRIVASYS_SHELL__ ?? {}
}

function serverOf(wireName: string): string | undefined {
  if (!wireName.startsWith('mcp__')) return undefined
  return wireName.slice('mcp__'.length).split('__')[0]
}

function dashed(appIdHex: string): string {
  return `${appIdHex.slice(0, 8)}-${appIdHex.slice(8, 12)}-${appIdHex.slice(12, 16)}-${appIdHex.slice(16, 20)}-${appIdHex.slice(20)}`
}

/** Dependency pins arrive base64; the attestation view compares OIDs in hex. */
function base64ToHex(value: string): string {
  try {
    const raw = atob(value)
    let hex = ''
    for (let index = 0; index < raw.length; index += 1) {
      hex += raw.charCodeAt(index).toString(16).padStart(2, '0')
    }
    return hex
  } catch {
    return value
  }
}

/** Attestation report for one tool call, keyed by the call's wire tool name. */
export function PrivasysAttestationTab({ toolWireName }: { toolWireName: string }) {
  const server = serverOf(toolWireName)
  const known = server !== undefined ? SERVER_APPS[server] : undefined

  // The harness's own pinned dependency set — the identities the egress proxy
  // refuses to deviate from. Same-origin, served unsealed by the measured proxy.
  const [pins, setPins] = useState(undefined)
  useEffect(() => {
    let current = true
    void fetch('/privasys/attestation')
      .then(async response => (response.ok ? await response.json() : undefined))
      .then(doc => { if (current) setPins(doc) }, () => { if (current) setPins(null) })
    return () => { current = false }
  }, [])

  const cfg = shellConfig()
  const verifyQuoteUrl = cfg.verifyQuoteUrl ?? 'https://as.privasys.org/verify-quote'
  const tokenThunk = () =>
    typeof cfg.getTokenForAudience === 'function'
      ? cfg.getTokenForAudience('attestation-server')
      : Promise.resolve('')
  const attestUrl = known !== undefined
    ? `${TOOLS_CONTROL_PLANE}/api/v1/apps/${dashed(known.appId)}/attest`
    : ''
  const [state, actions] = useAttestation({
    attestUrl,
    verifyQuoteUrl,
    verifyQuoteToken: tokenThunk,
    autoInspect: Boolean(attestUrl),
    autoVerifyQuote: Boolean(attestUrl),
  })

  if (server === undefined || known === undefined) {
    return (
      <div style={{ fontSize: 13, padding: '4px 0' }}>
        <p>
          <strong>{toolWireName}</strong> runs inside the harness enclave itself — no
          data leaves the attested boundary for this call. The enclave&apos;s full live
          report is behind <strong>Secure Hardware Attestation</strong> in the sidebar.
        </p>
      </div>
    )
  }

  const dep = pins?.dependencies?.find(entry => entry.app_id === known.appId)
  const expectations = dep?.code_hash !== undefined
    ? {
        workloadImageDigest: base64ToHex(dep.code_hash),
        labels: { workloadImageDigest: 'pinned in the harness dependency set' },
      }
    : undefined
  const summary = computeAttestationSummary(state, expectations)
  const { status, reason } = attestationStatusOf(summary, Boolean(attestUrl))

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong>{known.label}</strong>
        <AttestationStatusBadge status={status} {...(reason !== undefined ? { reason } : {})} />
      </div>
      <p style={{ opacity: 0.75, marginBottom: 12 }}>
        This call was served by a separately attested enclave, dialled over
        mutual RA-TLS; the egress proxy refuses any peer that does not match the
        identity pinned in the harness&apos;s sealed dependency set (fail closed).
        The report below is the tool enclave&apos;s LIVE attestation; the pinned
        code hash is checked against it.
      </p>
      {pins === null
        ? <p style={{ opacity: 0.7 }}>Could not read the harness pin summary; the live report below stands alone.</p>
        : null}
      {state.error && !state.result
        ? (
          <div>
            <div style={{ color: '#dc2626', marginBottom: 8 }}>{state.error}</div>
            <button type="button" onClick={() => { void actions.inspect() }}>Retry</button>
          </div>
        )
        : !state.result
          ? <p style={{ opacity: 0.7 }}>Verifying the tool enclave…</p>
          : (
            <AttestationResultView
              result={state.result}
              quoteVerify={state.quoteVerify}
              quoteVerifying={state.verifying}
              quoteVerifyError={state.quoteVerifyError}
              challenge={state.challenge}
              onRegenerateChallenge={actions.regenerateChallenge}
              onRefresh={() => { void actions.inspect() }}
              loading={state.loading}
              verifyQuoteUrl={verifyQuoteUrl}
              {...(expectations !== undefined ? { expectations } : {})}
            />
          )}
    </div>
  )
}
