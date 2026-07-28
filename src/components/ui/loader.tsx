/**
 * <Loader> — animated indicator for in-flight operations.
 *
 * Per brightcode/DESIGN.md (Hermes reference):
 *   - Use the lemniscate-bloom animation for long-running operations
 *   - Never ship the literal text "Loading…"
 *   - Respects `prefers-reduced-motion`
 *   - Tint inherits the current text color (set via `text-*` classes)
 *
 * Variants:
 *   - `spin`   — default. Lemniscate-bloom for long ops.
 *   - `dots`   — three pulsing dots. Quick feedback, no rotation.
 *   - `bars`   — three rising bars. Suggests streaming/progress.
 *   - `ring`   — indeterminate progress ring.
 */

import * as React from 'react'

import { cn } from '@/lib/utils'

export type LoaderVariant = 'spin' | 'dots' | 'bars' | 'ring'

export interface LoaderProps extends React.ComponentProps<'span'> {
  /** Visual style. Default 'spin' (lemniscate-bloom). */
  variant?: LoaderVariant
  /** Pixel size. Default 16. */
  size?: number
  /** Optional accessible label. Default 'Loading'. */
  label?: string
}

export function Loader({
  variant = 'spin',
  size = 16,
  label = 'Loading',
  className,
  ...props
}: LoaderProps) {
  const a11y = (
    <span className="sr-only" role="status" aria-live="polite">
      {label}
    </span>
  )

  if (variant === 'dots') {
    return (
      <span
        data-slot="loader"
        data-variant="dots"
        aria-busy="true"
        className={cn('inline-flex items-center gap-1', className)}
        {...props}
      >
        <Dots size={size} />
        {a11y}
      </span>
    )
  }

  if (variant === 'bars') {
    return (
      <span
        data-slot="loader"
        data-variant="bars"
        aria-busy="true"
        className={cn('inline-flex items-end gap-0.5', className)}
        {...props}
      >
        <Bars size={size} />
        {a11y}
      </span>
    )
  }

  if (variant === 'ring') {
    return (
      <span
        data-slot="loader"
        data-variant="ring"
        aria-busy="true"
        className={cn('inline-block', className)}
        style={{ width: size, height: size }}
        {...props}
      >
        <svg
          viewBox="0 0 24 24"
          width={size}
          height={size}
          className="animate-spin"
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            opacity="0.2"
          />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        {a11y}
      </span>
    )
  }

  // Default: lemniscate-bloom (Hermes long-op loader)
  return (
    <span
      data-slot="loader"
      data-variant="spin"
      aria-busy="true"
      className={cn('inline-block', className)}
      style={{ width: size, height: size }}
      {...props}
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        className="loader-lemniscate"
        aria-hidden="true"
      >
        <path
          d="M 50 10 C 20 10 20 50 50 50 C 80 50 80 90 50 90 C 20 90 20 50 50 50 C 80 50 80 10 50 10 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </svg>
      {a11y}
    </span>
  )
}

function Dots({ size }: { size: number }) {
  const dotSize = Math.max(4, Math.floor(size / 4))
  return (
    <>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block rounded-full bg-current"
          style={{
            width: dotSize,
            height: dotSize,
            animation: 'loader-dots 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </>
  )
}

function Bars({ size }: { size: number }) {
  const barWidth = Math.max(2, Math.floor(size / 5))
  return (
    <>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block rounded-sm bg-current"
          style={{
            width: barWidth,
            height: size,
            transformOrigin: 'bottom',
            animation: 'loader-bars 0.9s ease-in-out infinite',
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </>
  )
}

// Keyframes — appended once via a sentinel global style.
if (typeof document !== 'undefined' && !document.getElementById('loader-keyframes')) {
  const style = document.createElement('style')
  style.id = 'loader-keyframes'
  style.textContent = `
    @keyframes loader-dots {
      0%, 80%, 100% { opacity: 0.35; transform: scale(0.85); }
      40%            { opacity: 1;    transform: scale(1); }
    }
    @keyframes loader-bars {
      0%, 100% { transform: scaleY(0.35); opacity: 0.6; }
      50%      { transform: scaleY(1);    opacity: 1; }
    }
    .loader-lemniscate {
      transform-origin: center;
      animation: lemniscate-bloom 1.4s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .loader-lemniscate { animation: none; opacity: 0.7; }
      [data-slot='loader'] [style*='loader-dots'] { animation: none !important; }
      [data-slot='loader'] [style*='loader-bars'] { animation: none !important; }
    }
  `
  document.head.appendChild(style)
}
