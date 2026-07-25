import {
  ChevronDown,
  Code2,
  FolderOpen,
  Globe,
  PanelRight,
  SlidersHorizontal,
} from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

const chromeButtons = [
  { label: 'Open in browser', icon: Globe },
  { label: 'Task settings', icon: SlidersHorizontal },
  { label: 'Open folder', icon: FolderOpen },
] as const

/**
 * Shared top bar for the task and agent conversation views:
 * title + chevron on the left, window chrome icons on the right.
 *
 * The progress panel toggle is optional — pass `progressOpen` +
 * `onToggleProgress` only when the view actually has a progress panel
 * (the agent view does, the task view doesn't yet).
 */
export function ViewTopBar({
  title,
  progressOpen,
  onToggleProgress,
}: {
  title: string
  /** Optional: when provided, the progress toggle button renders. */
  progressOpen?: boolean
  onToggleProgress?: () => void
}) {
  const showProgressToggle = progressOpen !== undefined && onToggleProgress !== undefined
  return (
    <header className="border-border/60 flex h-12 shrink-0 items-center justify-between border-b px-3">
      <div className="flex min-w-0 items-center gap-1">
        <SidebarTrigger className="text-muted-foreground hover:text-foreground size-8" />
        <span className="bg-border/60 mx-1 h-4 w-px" />
        <button
          type="button"
          className="hover:bg-accent/50 flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors"
          onClick={() => console.log('[topbar] switch context')}
        >
          <span className="truncate text-[13px] font-medium">{title}</span>
          <ChevronDown className="text-muted-foreground size-4 shrink-0" />
        </button>
      </div>

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className="border-border/60 text-foreground/90 hover:bg-accent/50 mr-1 inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors"
          onClick={() => console.log('[topbar] open in VS Code')}
        >
          <Code2 className="size-3.5" />
          VS Code
        </button>

        {chromeButtons.map(({ label, icon: Icon }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            className="text-muted-foreground hover:text-foreground hover:bg-accent/50 inline-flex size-8 items-center justify-center rounded-md transition-colors"
            onClick={() => console.log(`[topbar] ${label}`)}
          >
            <Icon className="size-4" />
          </button>
        ))}

        {showProgressToggle && (
          <button
            type="button"
            aria-label="Toggle progress panel"
            aria-pressed={progressOpen}
            onClick={onToggleProgress}
            className={cn(
              'inline-flex size-8 items-center justify-center rounded-md transition-colors',
              progressOpen
                ? 'text-foreground bg-accent/60'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
          >
            <PanelRight className="size-4" />
          </button>
        )}
      </div>
    </header>
  )
}
