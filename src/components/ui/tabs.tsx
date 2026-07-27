/**
 * Minimal Tabs primitive.
 *
 * Radix tabs would be one extra dep; this is a few lines of state and
 * styling. The API mirrors the common pattern: a `<Tabs value onValueChange>`
 * wrapper around `<TabsList>` and `<TabsContent value=...>`. State is
 * lifted to the parent so the rest of the form can read the active tab
 * (e.g. "Preset" vs. "Custom" vs. "From file" in the agent creator).
 *
 * Visuals: an underline-style tab bar matching the dialog chrome, with
 * keyboard navigation (←/→/Home/End) for accessibility.
 */

import {
  createContext,
  useContext,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'

interface TabsContextValue {
  value: string
  onValueChange: (value: string) => void
  baseId: string
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabs(component: string): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) {
    throw new Error(`<${component}> must be rendered inside <Tabs>`)
  }
  return ctx
}

let TABS_ID = 0
function nextTabsId(): string {
  TABS_ID += 1
  return `tabs-${TABS_ID}`
}

export function Tabs({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string
  onValueChange: (value: string) => void
  className?: string
  children: ReactNode
}) {
  const baseIdRef = useRef<string>(nextTabsId())
  return (
    <TabsContext.Provider
      value={{ value, onValueChange, baseId: baseIdRef.current }}
    >
      <div className={cn('flex flex-col', className)}>{children}</div>
    </TabsContext.Provider>
  )
}

export function TabsList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const ctx = useTabs('TabsList')
  const listRef = useRef<HTMLDivElement>(null)

  // Find the labels in the order they appear so ←/→ can rotate
  // between them, matching the standard WAI-ARIA tablist pattern.
  const labels = (Array.isArray(children) ? children : [children]).filter(
    (child): child is React.ReactElement<{ value: string; children?: ReactNode }> =>
      Boolean(child),
  )

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = labels.findIndex(
      (label) => (label.props as { value: string }).value === ctx.value,
    )
    if (current < 0) return
    let nextIndex = current
    if (event.key === 'ArrowRight') nextIndex = (current + 1) % labels.length
    else if (event.key === 'ArrowLeft')
      nextIndex = (current - 1 + labels.length) % labels.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = labels.length - 1
    else return
    event.preventDefault()
    const next = labels[nextIndex] as
      | React.ReactElement<{ value: string }>
      | undefined
    if (next) {
      ctx.onValueChange((next.props as { value: string }).value)
      // Move focus to the new tab
      requestAnimationFrame(() => {
        const el = listRef.current?.querySelector<HTMLButtonElement>(
          `button[role="tab"][data-value="${(next.props as { value: string }).value}"]`,
        )
        el?.focus()
      })
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={handleKey}
      className={cn(
        'border-border/40 flex gap-1 border-b',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function TabsTrigger({
  value,
  children,
  className,
}: {
  value: string
  children: ReactNode
  className?: string
}) {
  const ctx = useTabs('TabsTrigger')
  const active = ctx.value === value
  return (
    <button
      type="button"
      role="tab"
      data-value={value}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        'text-muted-foreground hover:text-foreground/90 relative -mb-px px-3 py-2 text-[13px] font-medium transition-colors outline-none',
        'focus-visible:ring-ring/60 focus-visible:ring-2 focus-visible:ring-offset-0 rounded-sm',
        active && 'text-foreground',
        active &&
          'after:bg-foreground after:absolute after:right-3 after:bottom-[-1px] after:left-3 after:h-0.5 after:rounded-full',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string
  children: ReactNode
  className?: string
}) {
  const ctx = useTabs('TabsContent')
  if (ctx.value !== value) return null
  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-content-${value}`}
      className={cn('pt-4', className)}
    >
      {children}
    </div>
  )
}
