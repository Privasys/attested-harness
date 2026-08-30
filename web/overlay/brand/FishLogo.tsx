/**
 * Privasys mark in place of the DeepSeek whale (attested-harness fork).
 *
 * This file overrides `packages/client/ui-primitives/src/FishLogo.tsx` at the
 * SOURCE of every brand surface: the sidebar mark, the wordmark's leading
 * mark, and the conversation hero's animated fallback (EmptyHero composes its
 * own svg from FISH_LOGO_PATH/FISH_LOGO_VIEWBOX) all consume these exports —
 * so one override rebrands them all, including surfaces we do not know about.
 * The export names and shapes are kept identical to upstream.
 */
import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link FISH_LOGO_PATH} (width and height in user units). */
export const FISH_LOGO_VIEWBOX = { width: 500, height: 500 }

/**
 * The Privasys mark as one silhouette path (two angular panes), exported for
 * consumers that compose their own svg (entrance effects, masks) around the
 * same geometry — those render it with `currentColor`, monochrome.
 */
export const FISH_LOGO_PATH =
  'M100 0H450L0 450V100A100 100 0 0 1 100 0Z ' +
  'M500 50V400A100 100 0 0 1 400 500H50L500 50Z'

/**
 * Render the Privasys logo (full brand colors).
 * @param props.size - width in px (default 24; square).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d="M100 0H450L0 450V100A100 100 0 0 1 100 0Z" fill="#34E89E" />
      <path d="M500 50V400A100 100 0 0 1 400 500H50L500 50Z" fill="#00BCF2" />
      <polygon points="0,500 50,500 500,50 500,0" fill="#fff" />
    </svg>
  )
}
