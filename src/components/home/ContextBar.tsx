/**
 * ContextBar — MiniMax Code-style row of context dropdowns that sits
 * directly under the welcome prompt: which workspace the task runs in,
 * the execution mode (local only, for now), and the current git branch.
 *
 * The workspace picker is the only one that switches anything today —
 * "Local mode" and the branch dropdown are informational, matching the
 * reference UI while keeping the door open for future options (remote
 * runners, branch checkout).
 */

import { useEffect, useState } from 'react'
import { Check, ChevronDown, Folder, GitBranch, Monitor } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  useActiveProject,
  useProjects,
  useProjectsActions,
} from '@/hooks/use-projects'
import { cn } from '@/lib/utils'

type GitResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; error: string }

/** Lightweight branch reader — fetch once per project, no polling. */
function useCurrentBranch(projectId: string | null) {
  const [branch, setBranch] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setBranch(null)
    if (!projectId) return
    const api = window.electronAPI
    if (!api?.git) return

    void api.git
      .exec(projectId, ['branch', '--show-current'])
      .then((result: GitResult) => {
        if (cancelled) return
        if (result.ok) {
          const name = result.stdout.trim()
          setBranch(name || null)
        }
      })
      .catch(() => {
        /* not a git repo / git missing — chip just stays hidden */
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  return branch
}

const triggerClass =
  'text-muted-foreground hover:text-foreground hover:bg-accent/60 inline-flex max-w-[180px] items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors'

export function ContextBar() {
  const projects = useProjects()
  const activeProject = useActiveProject()
  const { setActive } = useProjectsActions()
  const branch = useCurrentBranch(activeProject?.id ?? null)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)

  if (!activeProject) return null

  return (
    <div
      data-context-bar
      className="mt-3 flex flex-wrap items-center justify-center gap-1"
    >
      {/* Workspace picker */}
      <Popover open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={triggerClass} aria-label="Select workspace">
            <Folder className="size-3.5 shrink-0" />
            <span className="truncate">{activeProject.label}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" sideOffset={8} className="w-56 p-1.5">
          <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
            Workspace
          </div>
          <div className="flex flex-col">
            {projects.map((p) => {
              const selected = p.id === activeProject.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setActive(p.id)
                    setWorkspaceOpen(false)
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                    selected
                      ? 'bg-accent text-foreground'
                      : 'text-foreground/85 hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <Folder className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  {selected && <Check className="text-muted-foreground size-3.5 shrink-0" />}
                </button>
              )
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/* Execution mode — local only for now */}
      <Popover open={modeOpen} onOpenChange={setModeOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={triggerClass} aria-label="Execution mode">
            <Monitor className="size-3.5 shrink-0" />
            <span>Local mode</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" sideOffset={8} className="w-56 p-1.5">
          <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
            Execution mode
          </div>
          <div className="bg-accent text-foreground flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
            <Monitor className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">Local mode</span>
              <span className="text-muted-foreground block text-[10.5px]">
                Runs on this machine
              </span>
            </span>
            <Check className="text-muted-foreground size-3.5 shrink-0" />
          </div>
        </PopoverContent>
      </Popover>

      {/* Current git branch — informational */}
      {branch && (
        <Popover open={branchOpen} onOpenChange={setBranchOpen}>
          <PopoverTrigger asChild>
            <button type="button" className={triggerClass} aria-label="Current branch">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">{branch}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-70" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="center" sideOffset={8} className="w-56 p-1.5">
            <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
              Branch
            </div>
            <div className="bg-accent text-foreground flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{branch}</span>
              <Check className="text-muted-foreground size-3.5 shrink-0" />
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
