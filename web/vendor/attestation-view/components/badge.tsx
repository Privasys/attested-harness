// @ts-nocheck -- vendored AS SOURCE from websites/libs/attestation-view (the canonical
// shared attestation view; keep in sync on change). ts-nocheck: compiled here under
// dsh's stricter tsc flags which the canonical copy does not target; runtime is identical.
'use client';

import type { ReactNode } from 'react';
import type { AttestationSummary } from './composite-attestation-view';

// The canonical pill/badge used across every attestation surface
// (the result view, the composite rows, the chat AI-tools rows and the
// sidebar status tag). Having ONE implementation is what stops the tones
// drifting into unreadable variants — solid tint + a strong-enough text
// colour in both light and dark, never a faint 10%-opacity fill.

export type BadgeTone = 'ok' | 'warn' | 'err' | 'neutral';

const TONE_CLASS: Record<BadgeTone, string> = {
    ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    err: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    neutral: 'bg-black/5 text-black/50 dark:bg-white/5 dark:text-white/50'
};

export function Badge({
    tone = 'neutral',
    className = '',
    children
}: {
    tone?: BadgeTone;
    className?: string;
    children: ReactNode;
}) {
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${TONE_CLASS[tone]} ${className}`}
        >
            {children}
        </span>
    );
}

/** A tiny inline spinner sized for a badge. */
export function BadgeSpinner() {
    return (
        <svg className='h-2.5 w-2.5 animate-spin' viewBox='0 0 24 24' aria-hidden='true'>
            <circle className='opacity-25' cx='12' cy='12' r='10' stroke='currentColor' strokeWidth='4' fill='none' />
            <path className='opacity-75' fill='currentColor' d='M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z' />
        </svg>
    );
}

export type AttestationBadgeStatus = 'verifying' | 'verified' | 'failed' | 'unavailable';

/** Map a per-target {@link AttestationSummary} to a badge status + reason.
 *  `hasTarget` is false when there is nothing to attest (no attest URL),
 *  which surfaces as 'unavailable' rather than a perpetual 'verifying'. */
export function attestationStatusOf(
    summary: AttestationSummary,
    hasTarget: boolean
): { status: AttestationBadgeStatus; reason?: string } {
    if (!hasTarget) return { status: 'unavailable' };
    if (!summary.ready) return { status: 'verifying' };
    if (summary.quoteOk && summary.digestsOk) return { status: 'verified' };
    const reason = summary.error
        ? 'Attestation error'
        : !summary.quoteOk
            ? 'Quote failed'
            : 'Digest mismatch';
    return { status: 'failed', reason };
}

/**
 * The shared attestation status badge. Every place that shows a
 * verified/failed/verifying verdict should render THIS so the wording and
 * colours stay consistent and readable.
 */
export function AttestationStatusBadge({
    status,
    reason,
    verifiedLabel = 'Verified',
    verifyingLabel = 'Verifying…',
    unavailableLabel = 'Not attested',
    className
}: {
    status: AttestationBadgeStatus;
    /** Failure detail; shown when status is 'failed' and no failedLabel. */
    reason?: string;
    verifiedLabel?: string;
    verifyingLabel?: string;
    unavailableLabel?: string;
    className?: string;
}) {
    switch (status) {
        case 'verified':
            return <Badge tone='ok' className={className}>{'✓'} {verifiedLabel}</Badge>;
        case 'failed':
            return <Badge tone='err' className={className}>{'✗'} {reason ?? 'Not verified'}</Badge>;
        case 'unavailable':
            return <Badge tone='warn' className={className}>{unavailableLabel}</Badge>;
        default:
            return (
                <Badge tone='neutral' className={className}>
                    <BadgeSpinner /> {verifyingLabel}
                </Badge>
            );
    }
}
