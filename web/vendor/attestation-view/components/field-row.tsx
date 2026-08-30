// @ts-nocheck -- vendored AS SOURCE from websites/libs/attestation-view (the canonical
// shared attestation view; keep in sync on change). ts-nocheck: compiled here under
// dsh's stricter tsc flags which the canonical copy does not target; runtime is identical.
'use client';

import { useCopy } from '../internal/use-copy';

// A single labelled value row with copy + optional
// description + optional badge slot. Used by AttestationResultView
// for cert fields, quote fields and OID extensions.
export function FieldRow({
    label,
    value,
    description,
    badge,
    children,
}: {
    label: string;
    value: string;
    description?: string;
    /** Right-aligned status badge (e.g. "Verified"). */
    badge?: React.ReactNode;
    /** Extra content rendered under the value (e.g. mismatch debug). */
    children?: React.ReactNode;
}) {
    const { copied, copy } = useCopy();
    return (
        <div>
            <div className='flex items-center gap-2'>
                <span className='text-xs text-black/50 dark:text-white/50'>{label}</span>
                {badge}
                <button
                    type='button'
                    onClick={() => copy(value, label)}
                    className='text-[10px] text-black/30 dark:text-white/30 hover:text-black/60 dark:hover:text-white/60'
                    title='Copy'
                    aria-label={`Copy ${label}`}
                >
                    {copied === label ? '✓' : '⧉'}
                </button>
            </div>
            <code className='mt-1 block break-all rounded bg-black/5 dark:bg-white/5 px-2 py-1 font-mono text-xs'>
                {value}
            </code>
            {description && (
                <p className='mt-0.5 text-[11px] text-black/35 dark:text-white/35'>{description}</p>
            )}
            {children}
        </div>
    );
}
