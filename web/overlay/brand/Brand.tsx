/**
 * Privasys occupants for dsh's generic browser-brand slots (attested-harness
 * fork). Overrides the stock DeepSeek Brand.tsx: same exports + signatures so
 * ui-brand-official/index.ts fills sidebar.brand.mark / sidebar.brand.name /
 * conversation.hero.brand.mark with Privasys branding instead of the whale.
 */
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/** The Privasys mark (same artwork as the sign-in gate + favicon). */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  const dim = size ?? '1.5em'
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 500 500"
      className={className}
      role="img"
      aria-label="Privasys"
    >
      <path d="M100 0H450L0 450V100A100 100 0 0 1 100 0Z" fill="#34E89E" />
      <path d="M500 50V400A100 100 0 0 1 400 500H50L500 50Z" fill="#00BCF2" />
      <polygon points="0,500 50,500 500,50 500,0" fill="#fff" />
    </svg>
  )
}

/** The app wordmark shown beside the mark. */
export function OfficialBrandName() {
  return <span style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>Attested Harness</span>
}
