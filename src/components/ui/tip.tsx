/**
 * <Tip> — convenience wrapper around Radix Tooltip.
 *
 * One-call ergonomics: `<Tip label="...">{trigger}</Tip>`. Combines
 * Provider + Root + Trigger + Content so call sites don't repeat the
 * four-element dance. Use this instead of native `title=` attributes —
 * native title has an OS-level ~500ms delay, unstyled tooltip, and no
 * theming.
 *
 * Per brightcode/DESIGN.md (Hermes reference):
 *   - Tips only when hover teaches something new
 *   - Use the themed <Tip>, never `title=` on buttons
 *   - Pair with `aria-label` when the trigger is icon-only
 *   - Keybind hints should use the kbd prop (visual chip)
 *   - Don't tip kebabs / menu triggers / close X / paraphrased labels
 *
 * Theming hooks onto the existing `bg-popover` token and the Hermes
 * `shadow-nous` + `border-(--stroke-nous)` borderless elevation.
 */

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger
const TooltipPortal = TooltipPrimitive.Portal
const TooltipContent = TooltipPrimitive.Content

/** Optional keybind hint rendered as a chip inside the tooltip. */
export interface TipProps {
  /** Tooltip text. Required — never pass an empty tip. */
  label: React.ReactNode
  /** Element that triggers the tip on hover/focus. */
  children: React.ReactElement
  /** Preferred side. Default "top". */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** Offset in px from the trigger. Default 6. */
  sideOffset?: number
  /** Alignment relative to the trigger. */
  align?: 'start' | 'center' | 'end'
  /** When true, opens on hover AND focus. Default true. */
  showOnFocus?: boolean
  /** Optional keybind hint rendered as a chip after the label. */
  kbd?: string
  /** Disable the tip entirely (e.g. when label is redundant). */
  disabled?: boolean
  /** Additional class on the content panel. */
  className?: string
}

/**
 * <Tip> — themed tooltip.
 *
 * @example
 *   <Tip label="New task for this project" kbd="Ctrl+N">
 *     <Button variant="ghost" size="icon" aria-label="New task">+</Button>
 *   </Tip>
 */
export function Tip({
  label,
  children,
  side = 'top',
  sideOffset = 6,
  align = 'center',
  kbd,
  disabled = false,
  className,
}: TipProps) {
  if (disabled || !label) {
    return <>{children}</>
  }
  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            side={side}
            sideOffset={sideOffset}
            align={align}
            className={cn(
              'z-50 overflow-hidden rounded-md border border-(--stroke-nous)',
              'bg-popover text-popover-foreground text-xs shadow-nous',
              'px-2.5 py-1',
              'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0',
              'data-[state=delayed-open]:zoom-in-95',
              className,
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <span>{label}</span>
              {kbd ? (
                <kbd
                  className={cn(
                    'inline-flex items-center rounded border border-(--ui-stroke-tertiary)',
                    'bg-(--ui-bg-quaternary) px-1 font-mono text-[10px] leading-tight',
                    'text-(--ui-text-tertiary)',
                  )}
                >
                  {kbd}
                </kbd>
              ) : null}
            </span>
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Re-export the Radix primitives for advanced use cases. */
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
