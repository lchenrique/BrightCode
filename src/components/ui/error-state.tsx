/**
 * <ErrorState> — canonical error display.
 *
 * Per brightcode/DESIGN.md (Hermes reference):
 *   - One look for the React boundary, in-dialog errors, and the boot-failure
 *     banner.
 *   - Canonical ErrorIcon (no bg chip).
 *   - Pass nodes for title/description so Radix DialogTitle/Description can
 *     flow through for a11y.
 *   - Distinct from `EmptyState` (which is for "no data") and from a plain
 *     inline error message.
 */

import * as React from 'react'
import { AlertCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from './button'

export interface ErrorStateProps extends React.ComponentProps<'div'> {
  /** Short headline. */
  heading?: React.ReactNode
  /** Longer explanation; supports newlines. */
  description?: React.ReactNode
  /** Optional retry handler — renders a secondary button when provided. */
  onRetry?: () => void
  /** Label for the retry button. Default "Try again". */
  retryLabel?: React.ReactNode
  /** Optional secondary action on the right of the retry. */
  secondaryAction?: React.ReactNode
  /** Size of the icon. Default 24. */
  iconSize?: number
  /** When true, render inline (no padding/icon) for use inside a dialog. */
  inline?: boolean
}

export function ErrorState({
  heading = 'Something went wrong',
  description,
  onRetry,
  retryLabel = 'Try again',
  secondaryAction,
  iconSize = 24,
  inline = false,
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn(
        'flex w-full',
        inline ? 'flex-row items-start gap-3' : 'flex-col items-center gap-3 text-center',
        inline ? 'p-3' : 'p-6',
        className,
      )}
      {...props}
    >
      <ErrorIcon size={iconSize} />
      <div className={cn('flex min-w-0 flex-col', inline ? 'gap-0.5' : 'gap-1')}>
        {heading ? (
          <p
            className={cn(
              'font-medium text-foreground',
              inline ? 'text-sm' : 'text-base',
            )}
          >
            {heading}
          </p>
        ) : null}
        {description ? (
          <p
            className={cn(
              'text-(--ui-text-secondary) whitespace-pre-wrap',
              inline ? 'text-xs' : 'text-sm',
            )}
          >
            {description}
          </p>
        ) : null}
        {onRetry || secondaryAction ? (
          <div
            className={cn(
              'flex flex-wrap items-center gap-2',
              inline ? 'mt-2' : 'mt-3',
            )}
          >
            {onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                {retryLabel}
              </Button>
            ) : null}
            {secondaryAction}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Canonical error icon — no bg chip, just the glyph. */
export function ErrorIcon({ size = 24, className, ...props }: { size?: number } & React.ComponentProps<typeof AlertCircle>) {
  return (
    <AlertCircle
      aria-hidden="true"
      size={size}
      className={cn('shrink-0 text-(--ui-text-tertiary)', className)}
      {...props}
    />
  )
}
