import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Right-side progress panel (~320px). With `steps` it lists completed
 * steps as struck-through muted labels; without them it shows the
 * empty state used by the agent chat view.
 */
export function ProgressPanel({ steps }: { steps?: readonly string[] }) {
  const [collapsed, setCollapsed] = useState(false)
  const hasSteps = !!steps && steps.length > 0

  return (
    <aside className="border-border/60 flex w-80 shrink-0 flex-col border-l">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="hover:bg-accent/40 flex h-11 shrink-0 items-center justify-between px-4 transition-colors"
      >
        <span className="text-[13px] font-medium">Progress</span>
        {collapsed ? (
          <ChevronDown className="text-muted-foreground size-4" />
        ) : (
          <ChevronUp className="text-muted-foreground size-4" />
        )}
      </button>

      <div
        className={cn(
          'flex-1 overflow-y-auto px-4 pb-4',
          collapsed && 'hidden',
        )}
      >
        {hasSteps ? (
          <ul className="flex flex-col gap-3 pt-1">
            {steps.map((step) => (
              <li key={step} className="flex items-start gap-2.5">
                <CheckCircle2 className="text-muted-foreground/70 mt-px size-4 shrink-0" />
                <span className="text-muted-foreground text-[13px] leading-5 line-through decoration-muted-foreground/50">
                  {step}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground/80 pt-1 text-[13px] leading-5">
            Track progress on longer tasks.
          </p>
        )}
      </div>
    </aside>
  )
}
