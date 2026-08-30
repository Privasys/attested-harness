// @ts-nocheck -- vendored AS SOURCE from websites/libs/attestation-view (the canonical
// shared attestation view; keep in sync on change). ts-nocheck: compiled here under
// dsh's stricter tsc flags which the canonical copy does not target; runtime is identical.
// Shared attestation types.
//
// These mirror the JSON shape returned by management-service
// `GET /api/v1/apps/{id}/attest` and consumed by:
//   * developer.privasys.org dashboard "Attestation" tab,
//   * explorer.privasys.org (once ported to Next.js),
//   * chat.privasys.org info drawer.
//
// Source of truth: platform/management-service/handlers.go AttestApp.
// Keep in sync; the developer-portal copy in
// `apps/fronts/developer.privasys.org/lib/types.ts` will be replaced
// with re-exports from this lib in a follow-up.

export interface AttestationCertificate {
    subject: string;
    issuer: string;
    serial_number: string;
    not_before: string;
    not_after: string;
    signature_algorithm: string;
    public_key_sha256: string;
}

export interface AttestationQuote {
    type: string;
    oid: string;
    is_mock: boolean;
    version?: number;
    report_data?: string;
    raw_base64?: string;
    // Base64 of the 32-byte RA-TLS channel binder this TLS session derived
    // (management-service reads it from the Go fork's
    // ConnectionState.RATLSChannelBinder). In challenge mode the enclave folds
    // it into report_data — SHA-512(SHA-256(pubkey) || nonce || binder) — so a
    // verifier MUST include it or the report_data check mismatches. GPU
    // enclaves additionally fold SHA-256(GPU evidence) after the binder (see
    // PRIVASYS_OID.GPU_EVIDENCE). Absent on TLS 1.2 / deterministic-mode certs.
    channel_binder?: string;
    // The management-service's own verdict on the binding, computed with the
    // full formula (including the GPU-evidence fold). `challenge_verified` is
    // set in challenge mode, `deterministic_verified` otherwise. A `false`
    // here means the quote was NOT freshly bound to this TLS session and the
    // enclave's identity must not be trusted.
    challenge_verified?: boolean;
    deterministic_verified?: boolean;
    mr_enclave?: string;
    mr_signer?: string;
    mr_td?: string;
    rtmr0?: string;
    rtmr1?: string;
    rtmr2?: string;
    rtmr3?: string;
    format?: string;
}

export interface AttestationExtension {
    oid: string;
    label: string;
    value_hex: string;
}

// The official Enclave OS GitHub release the attesting enclave runs. Captured
// when the enclave is registered on the platform and stamped onto the
// attestation payload by management-service, so the link is authoritative and
// instant (no measurement lookup at view time).
export interface OsRelease {
    url: string;
    tag: string;
    // Verification of the enclave's measurements against the release
    // (management-service): 'verified' | 'mismatch' | 'unverified' | ''.
    status?: string;
}

// WorkloadRelease is the app-code analogue of OsRelease: the build the deployed
// version's workload came from, plus whether the ATTESTED workload digest
// (OID 3.2) matches that build's output. Stamped by management-service.
// Containers link to the published GHCR package / GitHub release; wasm apps link
// to the reproducible-app-builder Actions run that produced the .cwasm.
export interface WorkloadRelease {
    url: string;      // GHCR package / release page (container) or build-run URL (wasm)
    label?: string;   // e.g. "v0.5.2" (container) or "reproducible build" (wasm)
    digest?: string;  // expected bare hex digest (image digest / .cwasm SHA-256)
    matches?: boolean; // attested OID 3.2 == expected digest (omitted when unknown)
}

export interface AttestationTLS {
    version: string;
    cipher_suite: string;
}

export interface EventLogDigest {
    pcr: number;
    event_type: number;
    digest: string;       // SHA-384 hex
    data_text?: string;   // Human-readable when decodable
}

export interface AppEvent {
    timestamp: string;
    pcr: number;
    digest_sha384: string;
    digest_sha256: string;
    type: string;        // 'container_load' | 'container_unload'
    description: string;
}

// NVIDIA GPU Confidential-Computing attestation verdict, produced by the
// attestation server when the enclave certificate carries GPU evidence
// (the tdx-gpu combined case). Mirrors the attestation-server
// GPUAttestationResult; populated by management-service AttestApp.
export interface GPUAttestationResult {
    verified: boolean;
    // measurements_verified is true only once firmware/VBIOS measurements are
    // matched against a signed NVIDIA RIM. verified can hold (genuine device,
    // CC mode, authentic nonce-bound report) while this is still false.
    measurements_verified: boolean;
    gpu_uuid?: string;
    driver?: string;
    vbios?: string;
    cc_environment?: string;
    status?: string;
    error?: string;
}

export interface AttestationResult {
    certificate: AttestationCertificate;
    pem: string;
    quote: AttestationQuote | null;
    extensions: AttestationExtension[];
    tls: AttestationTLS;
    // NVIDIA GPU attestation verdict, present when the enclave certificate
    // carries GPU evidence (OID 5.1) and it was verified by the attestation
    // server. Renders a dedicated GPU section in the attestation view.
    gpu_attestation?: GPUAttestationResult | null;
    // Per-workload (SNI) certificate data
    app_extensions?: AttestationExtension[];
    app_pem?: string;
    app_quote?: AttestationQuote | null;
    // Challenge mode
    challenge_mode: boolean;
    challenge?: string;
    // Stored CWASM hash for verification against APP_CODE_HASH_OID (3.2)
    cwasm_hash?: string;
    // TCG2 event log for RTMR replay verification (TDX only)
    event_log_events?: EventLogDigest[];
    event_log_source?: string;
    // Application-level RTMR[3] events from the enclave manager
    app_events?: AppEvent[];
    // The Enclave OS release this enclave runs (set at registration).
    os_release?: OsRelease;
    // The container package the deployed workload was built from + digest match.
    workload_release?: WorkloadRelease;
}

// Result of POST /api/v1/verify-quote (attestation-server proxy).
export interface QuoteVerifyResult {
    success: boolean;
    status: string;
    teeType?: string;
    mrenclave?: string;
    mrsigner?: string;
    mrtd?: string;
    isvProdId?: number;
    isvSvn?: number;
    tcbDate?: string;
    advisoryIds?: string[];
    // Intel platform TCB status derived from PCS collateral (e.g. "UpToDate",
    // "ConfigurationAndSWHardeningNeeded"). Present when the attestation server
    // ran the TCB check (SGX_TCB_MODE report/enforce).
    tcbStatus?: string;
    message?: string;
    error?: string;
}

// Well-known Privasys OIDs (subset surfaced by the proxy / manager).
// Aligned with the canonical per-workload scheme (enclave-os oids +
// ra-tls-clients): 3.1 config root, 3.2 image/code digest, 3.3 image ref,
// 3.4 key source / volume encryption, 3.5 runtime-stamped configuration
// hash (Mini), 3.6 platform-assigned app id. App-specific values live
// UNDER the app arc 3.5.* — the Confidential AI model digest at 3.5.5 and
// tools digest at 3.5.7 — because top-level 3.x slots are reserved for
// runtime-stamped extensions. Pre-migration slots (model digest at literal
// 3.5, tools digest at 3.7) are kept as *_LEGACY while older fleet images
// are live.
export const PRIVASYS_OID = {
    APP_CODE_HASH: '1.3.6.1.4.1.65230.3.2',
    IMAGE_REF: '1.3.6.1.4.1.65230.3.3',
    KEY_SOURCE: '1.3.6.1.4.1.65230.3.4',
    MODEL_DIGEST: '1.3.6.1.4.1.65230.3.5.5',
    /** Pre-migration model-digest slot (collides with Mini's runtime-stamped
     *  configuration hash), emitted by fleet images before v0.5. */
    MODEL_DIGEST_LEGACY: '1.3.6.1.4.1.65230.3.5',
    APP_ID: '1.3.6.1.4.1.65230.3.6',
    TOOLS_DIGEST: '1.3.6.1.4.1.65230.3.5.7',
    /** Pre-migration tools-digest slot, emitted by fleet images before v0.5. */
    TOOLS_DIGEST_LEGACY: '1.3.6.1.4.1.65230.3.7',
    GPU_EVIDENCE: '1.3.6.1.4.1.65230.5.1'
} as const;

// OIDs whose value bytes are UTF-8 strings, not raw hashes.
export const TEXT_OIDS: ReadonlySet<string> = new Set([
    PRIVASYS_OID.IMAGE_REF,
    PRIVASYS_OID.KEY_SOURCE
]);

// Optional expected values that the consumer can supply so the
// attestation view can render a green/red verification badge next
// to the matching workload extension. All values are lowercase hex
// strings; comparisons are case-insensitive.
export interface AttestationExpectations {
    /** Expected APP_CODE_HASH (OID 3.2). For container apps this is the
     *  registry image digest (sha256 hex without the algorithm prefix).
     *  For WASM apps this is the CWASM module SHA-256. */
    workloadImageDigest?: string;
    /** Expected MODEL_DIGEST (OID 3.5) - SHA-256 of the active AI model. */
    modelDigest?: string;
    /** Expected TOOLS_DIGEST (OID 3.7) - sha256 over the canonical JSON
     *  of the configured MCP tool servers. */
    toolsDigest?: string;
    /** Expected APP_ID (OID 3.6) - the management app id as undashed
     *  lowercase hex (raw 16-byte UUID). */
    appId?: string;
    /** Optional friendly labels shown in the verification badge.
     *  Defaults to a generic "Matches expected value". */
    labels?: {
        workloadImageDigest?: string;
        modelDigest?: string;
        toolsDigest?: string;
        appId?: string;
    };
}
