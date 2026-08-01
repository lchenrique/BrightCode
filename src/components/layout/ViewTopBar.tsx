import {
  ChevronDown,
  Code2,
  FolderOpen,
  GitBranch,
  MessageSquare,
  PanelRight,
  SquareTerminal,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { ProjectActionItems } from '@/components/projects/ProjectActionItems'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { runProjectOpenAction } from '@/lib/projects/open-project'
import type { Project } from '@/lib/projects/store'
import { cn } from '@/lib/utils'

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
  tabs,
  titleTabActive,
  onSelectTitleTab,
  folderOpen,
  onToggleFolder,
  folderDisabled = !onToggleFolder,
  onOpenTerminal,
  progressOpen,
  onToggleProgress,
  envInfoOpen,
  onToggleEnvInfo,
  panelLabel = 'Toggle right sidebar',
  project,
  onProjectActionError,
}: {
  title: string
  /** Optional task tabs rendered in the same compact header row. */
  tabs?: ReactNode
  /** Makes the conversation title itself the Chat tab. */
  titleTabActive?: boolean
  onSelectTitleTab?: () => void
  /** Opens the project workspace/file tree when available. */
  folderOpen?: boolean
  onToggleFolder?: () => void
  folderDisabled?: boolean
  /** Opens a new terminal tab (always creates a new one and focuses it). */
  onOpenTerminal?: () => void
  /** Optional: when provided, the progress toggle button renders. */
  progressOpen?: boolean
  onToggleProgress?: () => void
  /** Opens the Environmental Information panel (git, commit, push, terminal, progress). */
  envInfoOpen?: boolean
  onToggleEnvInfo?: () => void
  panelLabel?: string
  /** Enables native project shortcuts in the VS Code split button. */
  project?: Project | null
  onProjectActionError?: (message: string) => void
}) {
  const showProgressToggle = progressOpen !== undefined && onToggleProgress !== undefined
  const showEnvToggle = envInfoOpen !== undefined && onToggleEnvInfo !== undefined
  const titleIsTab = onSelectTitleTab !== undefined
  return (
    <header className="border-border/60 flex h-12 shrink-0 items-center border-b px-2">
      <div
        className={cn(
          'flex min-w-0 shrink-0 items-center gap-1 self-stretch',
          tabs && 'max-w-[280px]',
        )}
      >
        <SidebarTrigger className="text-muted-foreground hover:text-foreground size-8" />
        <span className="bg-border/60 mx-1 h-4 w-px" />
        <button
          type="button"
          role={titleIsTab ? 'tab' : undefined}
          aria-label={titleIsTab ? `Conversation: ${title}` : undefined}
          aria-selected={titleIsTab ? titleTabActive : undefined}
          className={cn(
            'hover:bg-accent/50 flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
            tabs && 'max-w-[220px]',
            titleIsTab && 'relative h-full rounded-none',
            titleIsTab && titleTabActive && 'bg-background text-foreground',
          )}
          onClick={
            onSelectTitleTab ?? (() => console.log('[topbar] switch context'))
          }
        >
          {titleIsTab && <MessageSquare className="size-3.5 shrink-0" />}
          <span className="truncate text-[13px] font-medium">{title}</span>
          <ChevronDown className="text-muted-foreground size-4 shrink-0" />
          {titleIsTab && titleTabActive && (
            <span className="bg-primary absolute inset-x-0 bottom-0 h-0.5" />
          )}
        </button>
      </div>

      {tabs ? (
        <div className="mx-1 min-w-0 flex-1 self-stretch overflow-hidden border-x">
          {tabs}
        </div>
      ) : (
        <div className="min-w-4 flex-1" />
      )}

      <div className="flex shrink-0 items-center gap-0.5">
        <div className="border-border/60 mr-1 inline-flex h-7 overflow-hidden rounded-full border">
          <button
            type="button"
            disabled={!project}
            className="text-foreground/90 hover:bg-accent/50 inline-flex items-center gap-1.5 px-3 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() =>
              project &&
              void runProjectOpenAction(
                project,
                'vscode',
                onProjectActionError,
              )
            }
          >
            <Code2 className="size-3.5" />
            VS Code
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!project}>
              <button
                type="button"
                aria-label="Choose how to open the project"
                className="border-border/60 text-muted-foreground hover:bg-accent/50 hover:text-foreground inline-flex w-7 items-center justify-center border-l transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            {project && (
              <DropdownMenuContent align="end">
                <ProjectActionItems
                  project={project}
                  onError={onProjectActionError}
                />
              </DropdownMenuContent>
            )}
          </DropdownMenu>
        </div>

        {onOpenTerminal && (
          <button
            type="button"
            aria-label="Open new terminal tab"
            title="New terminal tab"
            className="text-muted-foreground hover:text-foreground hover:bg-accent/50 inline-flex size-8 items-center justify-center rounded-md transition-colors"
            onClick={onOpenTerminal}
          >
            <SquareTerminal className="size-4" />
          </button>
        )}

        {showEnvToggle && (
          <button
            type="button"
            aria-label="Toggle environment info"
            aria-pressed={envInfoOpen}
            disabled={!project}
            title="Environment info (git, commit, push)"
            className={cn(
              'inline-flex size-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-35',
              envInfoOpen
                ? 'text-foreground bg-accent/60'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
            onClick={onToggleEnvInfo}
          >
            <GitBranch className="size-4" />
          </button>
        )}

        <button
          type="button"
          aria-label="Open project files"
          aria-pressed={folderOpen}
          disabled={folderDisabled}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-35',
            folderOpen
              ? 'text-foreground bg-accent/60'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
          )}
          onClick={onToggleFolder}
        >
          <FolderOpen className="size-4" />
        </button>

        {showProgressToggle && (
          <button
            type="button"
            aria-label={panelLabel}
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
