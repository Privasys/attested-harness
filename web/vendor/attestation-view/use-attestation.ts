// @ts-nocheck -- vendored AS SOURCE from websites/libs/attestation-view (the canonical
// shared attestation view; keep in sync on change). ts-nocheck: compiled here under
// dsh's stricter tsc flags which the canonical copy does not target; runtime is identical.
// React hook for fetching an attestation
// from a Privasys-platform endpoint and (optionally) verifying its TDX
// quote signature against an attestation server.
//
// Intentionally minimal: the host app provides the URLs and bearer token.
// This keeps the lib agnostic to the consumer's auth/session strategy
// (developer.privasys.org uses next-auth, chat.privasys.org uses the
// Privasys ID SDK directly).

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttestationResult, QuoteVerifyResult } from './types';

/** Generate a 32-byte hex challenge using the Web Crypto API. */
export function generateChallenge(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AttestationTarget {
    /** Full URL to the attestation endpoint (e.g. .../api/v1/apps/{id}/attest). */
    attestUrl: string;
    /** Optional URL to POST the raw quote to for signature verification. */
    verifyQuoteUrl?: string;
    /** Bearer token for the attest endpoint. Omit for public endpoints.
     *  Pass a function to mint the token lazily — useful when the token
     *  has a short lifetime and may need to be refreshed per call. */
    token?: string | (() => Promise<string>);
    /** Bearer token for the verify-quote endpoint. When omitted falls
     *  back to {@link token}. Used by the chat security view to mint a
     *  per-call `aud=attestation-server` JWT (challenge mode requires
     *  an audience-bound token). */
    verifyQuoteToken?: string | (() => Promise<string>);
    /** When true, automatically call inspect() once on mount (and again
     *  whenever attestUrl changes). The chat UI uses this to skip the
     *  pre-connect screen and go straight to the result view. */
    autoInspect?: boolean;
    /** When true, automatically call verifyQuoteSignature() once a result
     *  with a raw quote arrives. Mirrors the developer-portal pattern. */
    autoVerifyQuote?: boolean;
}

export interface AttestationState {
    result: AttestationResult | null;
    quoteVerify: QuoteVerifyResult | null;
    challenge: string;
    loading: boolean;
    verifying: boolean;
    error: string | null;
    quoteVerifyError: string | null;
}

export interface AttestationActions {
    /** Attest with the current challenge (or an explicit override). */
    inspect: (_overrideChallenge?: string) => Promise<void>;
    verifyQuoteSignature: () => Promise<void>;
    regenerateChallenge: () => void;
    /** Generate a fresh challenge AND attest with it in one step, so the
     *  editable nonce field and the "challenge sent" the enclave echoes
     *  never desync (which they would if you regenerated then inspected
     *  separately — inspect would still read the pre-update challenge). */
    newChallenge: () => Promise<void>;
    setChallenge: (next: string) => void;
    reset: () => void;
}

const CHALLENGE_RE = /^[0-9a-fA-F]{32,128}$/;

/** Resolve a token spec to a string, calling a thunk if provided.
 *  Returns undefined when no token is configured so callers can omit
 *  the Authorization header entirely. */
async function resolveToken(
    spec: string | (() => Promise<string>) | undefined
): Promise<string | undefined> {
    if (!spec) return undefined;
    if (typeof spec === 'string') return spec || undefined;
    const v = await spec();
    return v || undefined;
}

/**
 * useAttestation manages a single attestation handshake against a target
 * URL plus optional quote-signature verification via an attestation server.
 *
 * Returns the current state plus action callbacks. The hook does not
 * auto-fetch on mount; the consumer decides when to call inspect().
 */
export function useAttestation(target: AttestationTarget): [AttestationState, AttestationActions] {
    const [result, setResult] = useState<AttestationResult | null>(null);
    const [quoteVerify, setQuoteVerify] = useState<QuoteVerifyResult | null>(null);
    const [challenge, setChallenge] = useState<string>(() =>
        typeof window === 'undefined' ? '' : generateChallenge()
    );
    const [loading, setLoading] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [quoteVerifyError, setQuoteVerifyError] = useState<string | null>(null);

    const inspect = useCallback(async (overrideChallenge?: string) => {
        setLoading(true);
        setError(null);
        setQuoteVerify(null);
        setQuoteVerifyError(null);
        try {
            // An explicit override lets a caller attest with a just-generated
            // challenge WITHOUT waiting for the setChallenge state update to
            // flush (see newChallenge), so the request and the field agree.
            const trimmed = (overrideChallenge ?? challenge).trim();
            if (trimmed && !CHALLENGE_RE.test(trimmed)) {
                throw new Error('Challenge must be 32-128 hex characters (16-64 bytes)');
            }
            const url = trimmed
                ? `${target.attestUrl}${target.attestUrl.includes('?') ? '&' : '?'}challenge=${encodeURIComponent(trimmed)}`
                : target.attestUrl;
            const headers: Record<string, string> = { Accept: 'application/json' };
            const tokenValue = await resolveToken(target.token);
            if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;
            const res = await fetch(url, { headers });
            if (!res.ok) {
                throw new Error(`Attest request failed: ${res.status} ${res.statusText}`);
            }
            const data: AttestationResult = await res.json();
            setResult(data);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Attestation failed');
        } finally {
            setLoading(false);
        }
    }, [challenge, target.attestUrl, target.token]);

    const verifyQuoteSignature = useCallback(async () => {
        const raw = result?.quote?.raw_base64;
        if (!raw || !target.verifyQuoteUrl) return;
        setVerifying(true);
        setQuoteVerifyError(null);
        try {
            const headers: Record<string, string> = {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            };
            const tokenValue = await resolveToken(target.verifyQuoteToken ?? target.token);
            if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;
            const res = await fetch(target.verifyQuoteUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ quote: raw })
            });
            if (res.status === 401 || res.status === 403) {
                // Distinguish "you are not signed in" from "your token broke":
                // the attestation viewer is public, and an anonymous visitor
                // never had a token to lose — telling them theirs is invalid
                // reads as an error they caused.
                throw new Error(tokenValue
                    ? 'The attestation server rejected the request: token missing or invalid.'
                    : 'The attestation server requires a signed-in session. Everything above — certificate, measurements, freshness — is verified locally in your browser; sign in to have the server check the quote signature too.');
            }
            if (!res.ok) {
                throw new Error(`Verify request failed: ${res.status} ${res.statusText}`);
            }
            const data: QuoteVerifyResult = await res.json();
            setQuoteVerify(data);
        } catch (e) {
            setQuoteVerifyError(e instanceof Error ? e.message : 'Quote verification failed');
        } finally {
            setVerifying(false);
        }
    }, [result, target.verifyQuoteUrl, target.token, target.verifyQuoteToken]);

    const regenerateChallenge = useCallback(() => {
        setChallenge(generateChallenge());
    }, []);

    // Fresh challenge + attest atomically: set the field to `next` AND
    // inspect with `next` in the same call, so the "challenge sent" the
    // enclave binds into ReportData matches the nonce shown in the field.
    const newChallenge = useCallback(async () => {
        const next = generateChallenge();
        setChallenge(next);
        await inspect(next);
    }, [inspect]);

    // Manual challenge override. We accept any string, strip non-hex and
    // lowercase it, but otherwise let the user paste / edit freely. The
    // 32-128 hex validation runs at inspect() time so an in-progress edit
    // is not flagged mid-typing.
    const setChallengeAction = useCallback((next: string) => {
        const cleaned = next.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        setChallenge(cleaned.slice(0, 128));
    }, []);

    const reset = useCallback(() => {
        setResult(null);
        setQuoteVerify(null);
        setError(null);
        setQuoteVerifyError(null);
        setLoading(false);
        setVerifying(false);
    }, []);

    // Auto-inspect on mount / whenever the attest URL changes. We track
    // the last URL we fired against so a re-render with the same URL
    // doesn't loop. Consumers that toggle autoInspect on/off should also
    // change attestUrl to re-trigger.
    const lastAutoUrlRef = useRef<string | null>(null);
    useEffect(() => {
        if (!target.autoInspect || !target.attestUrl) return;
        if (lastAutoUrlRef.current === target.attestUrl) return;
        lastAutoUrlRef.current = target.attestUrl;
        void inspect();
    }, [target.autoInspect, target.attestUrl, inspect]);

    // Auto-verify the quote signature once a fresh result with a real
    // quote arrives (mock quotes are skipped, matching the previous
    // inline implementation in the developer portal).
    useEffect(() => {
        if (!target.autoVerifyQuote) return;
        if (!result?.quote?.raw_base64 || result.quote.is_mock) return;
        if (!target.verifyQuoteUrl) return;
        void verifyQuoteSignature();
    }, [target.autoVerifyQuote, target.verifyQuoteUrl, result, verifyQuoteSignature]);

    return [
        { result, quoteVerify, challenge, loading, verifying, error, quoteVerifyError },
        { inspect, verifyQuoteSignature, regenerateChallenge, newChallenge, setChallenge: setChallengeAction, reset }
    ];
}

/**
 * Verifies that the quote's report_data field equals
 *   SHA-512( SHA-256(pubkey) || nonce || binder )
 * which proves the quote was generated for the certificate the client
 * actually saw on the wire AND is bound to this exact TLS session.
 *
 * `binderB64` is the base64 RA-TLS channel binder (32 bytes) the enclave
 * folds into report_data on the challenge path.
 *
 * Returns 'match' | 'mismatch' | 'error'. Computed and actual values
 * are also returned so the UI can surface the diff.
 */
export async function verifyReportData(args: {
    pubKeySha256Hex: string;
    challengeHex: string;
    reportDataHex: string;
    binderB64?: string;
    /**
     * Raw NVIDIA GPU-evidence extension value (OID 1.3.6.1.4.1.65230.5.1),
     * hex. GPU enclaves (e.g. confidential-ai) fold SHA-256(gpu_evidence)
     * into the binding after the channel binder — the management-service does
     * the same in gpuFoldBinding. When present the report_data is
     * SHA-512(SHA-256(pubkey) || nonce || binder || SHA-256(gpu_evidence));
     * omitting it makes GPU quotes falsely report a mismatch.
     */
    gpuEvidenceHex?: string;
}): Promise<{ status: 'match' | 'mismatch' | 'error'; computed?: string; actual?: string }> {
    try {
        const pub = hexToBytes(args.pubKeySha256Hex);
        const nonce = hexToBytes(args.challengeHex);
        const binder = args.binderB64 ? base64ToBytes(args.binderB64) : new Uint8Array(0);
        let gpuFold = new Uint8Array(0);
        if (args.gpuEvidenceHex) {
            const gpuBytes = hexToBytes(args.gpuEvidenceHex);
            const gpuInput = new Uint8Array(gpuBytes.length);
            gpuInput.set(gpuBytes);
            gpuFold = new Uint8Array(await crypto.subtle.digest('SHA-256', gpuInput));
        }
        const buf = new Uint8Array(pub.length + nonce.length + binder.length + gpuFold.length);
        buf.set(pub);
        buf.set(nonce, pub.length);
        buf.set(binder, pub.length + nonce.length);
        buf.set(gpuFold, pub.length + nonce.length + binder.length);
        const hash = await crypto.subtle.digest('SHA-512', buf);
        const computed = bytesToHex(new Uint8Array(hash));
        const actual = args.reportDataHex.toLowerCase();
        return {
            status: computed === actual ? 'match' : 'mismatch',
            computed,
            actual
        };
    } catch {
        return { status: 'error' };
    }
}

function hexToBytes(hex: string): Uint8Array {
    const m = hex.match(/.{1,2}/g);
    if (!m) throw new Error('invalid hex');
    return new Uint8Array(m.map((b) => parseInt(b, 16)));
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
