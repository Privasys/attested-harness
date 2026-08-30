/**
 * "Attestation" detail tab for the trajectory Inspect view (attested-harness
 * fork; placed into ui-trajectory by apply-overlay, wired via three anchored
 * edits in TrajectoryTable.tsx + locale keys).
 *
 * For a tool call it answers: WHICH attested enclave served this call, what
 * identity is it PINNED to (the harness's sealed dependency set, read from the
 * same-origin /privasys/attestation summary the egress proxy serves), and a
 * link-out fact set (app id, code hash, measurements). MCP fleet tools map by
 * wire name (mcp__<server>__<tool>); every other tool runs inside the harness
 * enclave itself, whose full report lives behind the sidebar's
 * "Secure Hardware Attestation" row.
 */
import { useEffect, useState } from 'react'

/** Wire-name prefix map: MCP server -> platform app id (prod control plane). */
const SERVER_APPS: Readonly<Record<string, { appId: string; label: string }>> = {
  web_search: { appId: '82cb3965811d4ad298cac29e4837fd45', label: 'Web Search (Brave)' },
  web_reader: { appId: '09965ab93f2e480ea0417cce438f0696', label: 'Web Reader (Lightpanda)' },
  drive: { appId: 'cf7a0d585468416884c341ebe0ce4025', label: 'Privasys Drive' },
}

interface PinnedDep {
  app_id?: string
  code_hash?: string
  measurements?: readonly Record<string, string>[]
}
interface AttestationSummaryDoc {
  app?: { app_id?: string; image_digest?: string; public_host?: string; tee?: string }
  dependencies?: readonly PinnedDep[]
  dependency_fold?: string
  tool_hosts?: Readonly<Record<string, string>>
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly doc: AttestationSummaryDoc }

function serverOf(wireName: string): string | undefined {
  if (!wireName.startsWith('mcp__')) return undefined
  return wireName.slice('mcp__'.length).split('__')[0]
}

function Mono({ value }: { value: string }) {
  return (
    <code style={{
      display: 'block', fontSize: 11, wordBreak: 'break-all',
      opacity: 0.85, padding: '2px 0',
    }}>{value}</code>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <Mono value={value} />
    </div>
  )
}

/** Attestation facts for one tool call, keyed by the call's wire tool name. */
export function PrivasysAttestationTab({ toolWireName }: { toolWireName: string }) {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  useEffect(() => {
    let current = true
    // Same-origin, served unsealed by the measured egress proxy (the
    // static-unsealed /privasys/ prefix): the app identity + the sealed
    // dependency set the agent's every model/tool dial is pinned to.
    void fetch('/privasys/attestation').then(async (response) => {
      if (!response.ok) throw new Error(String(response.status))
      return await response.json() as AttestationSummaryDoc
    }).then(
      (doc) => { if (current) setState({ status: 'ready', doc }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [toolWireName])

  if (state.status === 'loading') return <p style={{ opacity: 0.7 }}>Reading attestation…</p>
  if (state.status === 'error') {
    return <p style={{ opacity: 0.7 }}>Could not read the attestation summary. The transport stays sealed and pinned regardless; only this panel is affected.</p>
  }

  const doc = state.doc
  const server = serverOf(toolWireName)
  const known = server !== undefined ? SERVER_APPS[server] : undefined
  const dep = known !== undefined
    ? doc.dependencies?.find(entry => entry.app_id === known.appId)
    : undefined

  if (server === undefined || known === undefined) {
    // A harness-local tool (bash, fs, subagents...): the evidence is the
    // harness enclave's own attestation.
    return (
      <div>
        <p style={{ fontSize: 13, marginBottom: 12 }}>
          <strong>{toolWireName}</strong> runs inside the harness enclave itself — no
          data leaves the attested boundary for this call. The enclave&apos;s full
          live report is behind <strong>Secure Hardware Attestation</strong> in the sidebar.
        </p>
        {doc.app?.tee !== undefined ? <Field label="TEE" value={doc.app.tee} /> : null}
        {doc.app?.public_host !== undefined ? <Field label="Enclave host" value={doc.app.public_host} /> : null}
        {doc.app?.image_digest !== undefined ? <Field label="Measured image (OID 3.2)" value={doc.app.image_digest} /> : null}
        {doc.app?.app_id !== undefined ? <Field label="App id (OID 3.6)" value={doc.app.app_id} /> : null}
      </div>
    )
  }

  const host = doc.tool_hosts?.[server]
  return (
    <div>
      <p style={{ fontSize: 13, marginBottom: 12 }}>
        <strong>{known.label}</strong> served this call as a separately attested
        enclave. The egress proxy dials it over mutual RA-TLS and refuses any
        peer that does not match the pinned identity below (fail closed) — the
        pin is sealed into the harness&apos;s own attested certificate.
      </p>
      {host !== undefined ? <Field label="Host" value={host} /> : null}
      {dep === undefined
        ? <p style={{ opacity: 0.7, fontSize: 12 }}>This tool is not in the live dependency set — its calls are refused.</p>
        : (
          <>
            {dep.app_id !== undefined ? <Field label="Pinned app id (OID 3.6)" value={dep.app_id} /> : null}
            {dep.code_hash !== undefined ? <Field label="Pinned code hash (OID 3.2)" value={dep.code_hash} /> : null}
            {(dep.measurements ?? []).map((measurement, index) => (
              Object.entries(measurement).map(([kind, value]) => (
                <Field key={`${index}-${kind}`} label={`Pinned ${kind.toUpperCase()}`} value={String(value)} />
              ))
            ))}
          </>
        )}
      {doc.dependency_fold !== undefined
        ? <Field label="Dependency fold" value={doc.dependency_fold} />
        : null}
    </div>
  )
}
