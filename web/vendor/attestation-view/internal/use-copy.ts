// @ts-nocheck -- vendored AS SOURCE from websites/libs/attestation-view (the canonical
// shared attestation view; keep in sync on change). ts-nocheck: compiled here under
// dsh's stricter tsc flags which the canonical copy does not target; runtime is identical.
'use client';

import { useCallback, useState } from 'react';

// Copy-to-clipboard hook with a 2s "Copied" indicator,
// extracted from the developer-portal AttestationTab so all consumers
// of @privasys/attestation-view share the same UX.
export function useCopy(timeoutMs = 2000): {
    copied: string | null;
    copy: (text: string, label: string) => void;
} {
    const [copied, setCopied] = useState<string | null>(null);
    const copy = useCallback(
        (text: string, label: string) => {
            void navigator.clipboard.writeText(text);
            setCopied(label);
            const t = setTimeout(() => setCopied(null), timeoutMs);
            return () => clearTimeout(t);
        },
        [timeoutMs],
    );
    return { copied, copy };
}

/** Decode a hex string to UTF-8 if it is printable ASCII; else null. */
export function hexToPrintableText(hex: string): string | null {
    try {
        const m = hex.match(/.{1,2}/g);
        if (!m) return null;
        const bytes = new Uint8Array(m.map((b) => parseInt(b, 16)));
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (/^[\x20-\x7e]+$/.test(text)) return text;
        return null;
    } catch {
        return null;
    }
}
