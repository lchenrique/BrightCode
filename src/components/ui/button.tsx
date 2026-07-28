import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * Single source for button appearance. Pick a `variant` + `size`; do NOT pass
 * `h-*`, `px-*`, `py-*`, or icon-size overrides at the call site.
 *
 * Per brightcode/DESIGN.md (Hermes reference):
 *   - Text buttons (`text`, `textStrong`) are square (no radius) and sized by
 *     padding + line-height (no fixed heights).
 *   - Only icon-family sizes carry the shared 4px radius.
 *   - SVGs inherit `size-4`; do not re-set icon size.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        /** Boxless quiet inline — "Cancel", "Clear". No radius, no fixed height. */
        text:
          'rounded-none text-foreground/70 hover:text-foreground px-1 py-0 h-auto [&:not([class*="h-"])]:h-auto',
        /** Bold underlined inline affordance — "Change", "Open logs". */
        textStrong:
          'rounded-none text-foreground font-semibold underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground px-1 py-0 h-auto [&:not([class*="h-"])]:h-auto',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 rounded-md px-3 has-[>svg]:px-2.5 text-xs',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        /** Compact 28px — for dense toolbars. */
        xs: 'h-7 rounded-md px-2.5 has-[>svg]:px-2 text-xs',
        /** Flush, zero box — for buttons inside a heading/sentence. */
        inline: 'h-auto px-0 py-0 rounded-none',
        /** Tiny — for status-stack / table-footer affordances. */
        micro: 'h-5 px-1.5 has-[>svg]:px-1 text-[10px] rounded',
        icon: 'size-9',
        'icon-sm': 'size-7',
        'icon-xs': 'size-6',
        'icon-lg': 'size-10',
        'icon-titlebar': 'size-8 rounded',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

