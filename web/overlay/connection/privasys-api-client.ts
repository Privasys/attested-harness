/**
 * Privasys sealed-transport API carrier (attested-harness fork).
 *
 * The stock browser carrier (WebApiClient) does unary RPC over plain fetch and
 * the two event downlinks over WebSockets. On the confidential platform the
 * enclave gateway terminates TLS and the manager enforces a sealed
 * CBOR-AES-GCM relay — WebSockets cannot traverse it, and plaintext fetch is
 * refused. This carrier keeps AbstractApiClient's built-in SSE downlinks
 * (openMux/openHost -> readSse) and swaps ONLY the transport aspect (`doFetch`)
 * to ride the sealed session established by the Privasys auth shell.
 *
 * The sealed session is a duck-typed handle (SealedSession from @privasys/auth,
 * or the frame-client postMessage proxy) published on window.__PRIVASYS_SEALED__
 * before boot; this file has no @privasys/auth dependency.
 *
 * Divergence: NEW file (no rebase conflicts) plus a small selector in
 * client/index.ts apply().
 */

import { AbstractApiClient } from './api.ts'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../api-path.ts'

/** Minimal shape of a @privasys/auth SealedSession we depend on. */
export interface SealedHandle {
  request(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<{ status: number; sealed: boolean; body: Uint8Array; headers: Headers }>
  stream(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<{ status: number; sealed: boolean; headers: Headers; body: ReadableStream<Uint8Array> }>
}

/**
 * Map a WHATWG fetch call onto the sealed session. Event downlinks
 * (`GET /api/events.{mux,host}`) are long-lived SSE streams -> `stream()`;
 * everything else is unary JSON RPC -> `request()`. The returned Response
 * exposes only status + body, which is all AbstractApiClient's postJson
 * (`response.ok` + `response.json()`) and readSse (`response.ok` +
 * `response.body`) consume. Sealed responses carry the app's real status in
 * the SDK's parsed `status`; outer transfer headers are intentionally dropped
 * (the encrypted-vs-plaintext lengths would disagree).
 */
// The enclave session-relay enforces a STRICT monotonic c2s counter and 401s
// any out-of-order frame as a replay (sessionrelay.go: "Out-of-order requests
// across parallel fetches will fail"). dsh is a highly concurrent client (two
// long-lived event downlinks plus parallel unary RPC), so its frames would
// arrive out of order and get rejected — a "connection lost" + re-bootstrap
// (429) storm. We serialise every sealed frame through a FIFO chain so they
// reach the manager in counter order. A downlink resolves on response headers
// (its body then streams independently), so the two SSE streams do not block
// the queue; unary calls serialise their round-trip, which is the correct
// trade-off until the relay grows a sliding-window anti-replay.
let sealedChain: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = sealedChain.then(task, task)
  // Keep the chain alive regardless of individual task outcome.
  sealedChain = run.then(noop, noop)
  return run
}
function noop(): void {}

export async function sealedDoFetch(
  sealed: SealedHandle,
  input: URL,
  init?: RequestInit,
): Promise<Response> {
  const path = input.pathname + input.search
  const method = (init?.method ?? 'GET').toUpperCase()
  const isDownlink =
    method === 'GET' && (input.pathname === MUX_EVENTS_PATH || input.pathname === HOST_EVENTS_PATH)

  if (isDownlink) {
    // sealed.stream() resolves once the response headers are in; the body
    // streams after, so enqueuing only the header round-trip is enough to
    // keep the c2s frame ordered without holding the queue for the stream's life.
    const r = await enqueue(() => sealed.stream('GET', path, undefined, forward(init)))
    return new Response(r.body, { status: r.status })
  }

  const r = await enqueue(() => sealed.request(method, path, init?.body ?? undefined, forward(init)))
  return new Response(r.body as BodyInit, { status: r.status })
}

/** Pass through the caller's abort signal; the SDK ignores what it cannot clone. */
function forward(init?: RequestInit): RequestInit | undefined {
  if (!init?.signal) return undefined
  return { signal: init.signal }
}

/** RpcFetch for the generic Typert RPC channel (unary POST over the sealed leg). */
export function sealedRpcFetch(sealed: SealedHandle): (input: URL, init: RequestInit) => Promise<Response> {
  return (input, init) => sealedDoFetch(sealed, input, init)
}

/** Browser carrier that rides the sealed session; SSE downlinks inherited unchanged. */
export class PrivasysApiClient extends AbstractApiClient {
  constructor(private readonly sealed: SealedHandle) {
    super()
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return sealedDoFetch(this.sealed, input, init)
  }
}
