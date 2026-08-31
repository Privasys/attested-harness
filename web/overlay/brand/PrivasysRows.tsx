/**
 * Privasys sidebar foot rows (attested-harness fork): an Attestation row
 * ("Verified" — opens the attestation evidence drawer) and a User row (opens a
 * menu with Sign out). Registered into the `sidebar.footer.action` list slot
 * (see ./index.ts), so they sit at the sidebar foot next to Settings — dsh's
 * designed extension seam, no sidebar source is edited.
 *
 * Both actions call the vanilla auth shell through `window.__PRIVASYS_SHELL__`
 * (privasys-shell.js owns the sealed session, the attestation drawer, and
 * logout); the rows are pure triggers.
 */
import { useEffect, useRef, useState } from 'react'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

interface PrivasysShellHooks {
  logout?: () => void
}

function shell(): PrivasysShellHooks {
  return (globalThis as { __PRIVASYS_SHELL__?: PrivasysShellHooks }).__PRIVASYS_SHELL__ ?? {}
}

// One shared stylesheet for both rows (hover states need real CSS). Theme-proof
// without knowing dsh's tokens: text rides currentColor, hovers are translucent,
// and the menu uses the system Canvas/CanvasText colors, which follow the theme.
const STYLE_ID = 'privasys-sidebar-rows'
const STYLE = `
/* dsh's sidebar-foot action container lays list entries out in a ROW; with the
   full "Secure Hardware Attestation" label the User row overflowed out of
   sight. Stack the foot actions vertically (css-module class names keep the
   readable "footerActions" stem, so the attribute selector is stable enough;
   revisit if upstream renames it). */
[class*="footerActions"] { flex-direction: column !important; align-items: stretch !important; gap: 0; }
/* Sized to dsh's Settings trigger (ui-settings-general SettingsRoot.module.css
   .trigger: 42px row, 14px/22px type, 12px radius, token colors) so the three
   foot rows read as one family. */
.pv-row { display: flex; align-items: center; gap: 8px; width: 100%;
  height: 42px; padding: 0 10px 0 8px; box-sizing: border-box; border: none;
  border-radius: 12px; background: transparent;
  color: var(--dsw-alias-label-primary, inherit); font-family: inherit;
  font-size: 14px; line-height: 22px; cursor: pointer; text-align: left; }
.pv-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.15)); }
.pv-row-narrow { flex: none; width: 36px; height: 36px; margin: 0 auto;
  justify-content: center; gap: 0; padding: 0; border-radius: 50%; }
.pv-row-verified { color: #2bbd82; }
.pv-user-wrap { position: relative; width: 100%; }
.pv-menu { position: absolute; bottom: calc(100% + 6px); left: 8px; z-index: 30;
  min-width: 150px; padding: 4px; border-radius: 10px;
  background: Canvas; color: CanvasText;
  border: 1px solid rgba(128, 128, 128, 0.35);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
.pv-menu-item { display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 10px; border: none; border-radius: 7px; background: transparent;
  color: inherit; font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.pv-menu-item:hover { background: rgba(128, 128, 128, 0.15); }
`

/** Inject the shared row styles once (also used by PrivasysAttestation.tsx). */
export function ensureRowStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = STYLE
  document.head.appendChild(tag)
}
const ensureStyles = ensureRowStyles

function UserIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  )
}

function SignOutIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

// The attestation row lives in ./PrivasysAttestation.tsx now — "Secure
// Hardware Attestation", built on the SHARED @privasys/attestation-view
// component with live verification state (green = verified, never decoration).

/** User row — opens a menu holding session actions (Sign out). */
export function PrivasysUserRow({ wide }: SidebarFooterActionOwnerProps) {
  useEffect(ensureStyles, [])
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="pv-user-wrap" ref={wrapRef}>
      {open
        ? (
          <div className="pv-menu" role="menu" aria-label="User">
            <button
              type="button"
              className="pv-menu-item"
              role="menuitem"
              onClick={() => { setOpen(false); shell().logout?.() }}
            >
              <SignOutIcon />
              <span>Sign out</span>
            </button>
          </div>
        )
        : null}
      <button
        type="button"
        className={`pv-row${wide ? '' : ' pv-row-narrow'}`}
        title="User"
        aria-label="User"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <UserIcon size={wide ? 16 : 18} />
        {wide ? <span>User</span> : null}
      </button>
    </div>
  )
}
