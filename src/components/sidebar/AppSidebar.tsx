import { useState, useCallback, useRef, useSyncExternalStore } from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarResizeHandle,
  SidebarSeparator,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus,
  Search,
  Sparkles,
  Clock,
  Smartphone,
  Monitor,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pin,
  Pencil,
  Settings,
  Trash2,
  Check,
  BrainCircuit,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { tasksStore } from '@/lib/tasks/store'
import { SidebarTopNav } from './SidebarTopNav'
import { UserCard } from './UserCard'
import { TeamAvatar } from './TeamAvatar'
import {
  useProjects,
  useActiveProject,
  useProjectsActions,
} from '@/hooks/use-projects'
import { useTasksByProject } from '@/hooks/use-tasks'
import { AddProjectDialog } from '@/components/projects/AddProjectDialog'
import { agentStore, type AgentDefinition } from '@/lib/agents'

const topNav = [
  { title: 'New task', icon: Plus, accent: true },
  { title: 'Search', icon: Search },
  { title: 'Skills', icon: Sparkles },
  { title: 'Bright Memory', icon: BrainCircuit },
  { title: 'Automation', icon: Clock },
  { title: 'Connect Mobile', icon: Smartphone },
  { title: 'Remote Control', icon: Monitor },
] as const

const COLORS = ['rose', 'amber', 'primary', 'emerald'] as const
type AgentColor = (typeof COLORS)[number]

function pickColor(id: string): AgentColor {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i)
    hash |= 0
  }
  return COLORS[Math.abs(hash) % COLORS.length]!
}

type Agent = Pick<AgentDefinition, 'id' | 'name' | 'avatarSeed'> & { color: AgentColor }

function useAgents(): Agent[] {
  const cacheRef = useRef<Agent[]>([])
  const subscribe = useCallback(
    (cb: () => void) => agentStore.subscribe(cb),
    [],
  )
  const getSnapshot = useCallback(() => {
    const next = agentStore
      .list()
      .filter((a) => a.enabled)
      .map((a) => ({
        id: a.id,
        name: a.name,
        avatarSeed: a.avatarSeed,
        color: pickColor(a.id),
      }))
    const prev = cacheRef.current
    if (
      prev.length === next.length &&
      prev.every((p, i) => p.id === next[i].id)
    ) {
      return prev
    }
    cacheRef.current = next
    return next
  }, [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function AppSidebar({
  activeTaskId,
  onNewTask,
  onOpenSearch,
  onSelectSkills,
  onSelectBrightMemory,
  onSelectProject,
  onSelectTask,
  onSelectAgent,
  onOpenSettings,
  onOpenCreateAgent,
  onOpenAgentSettings,
  onSidebarResize,
}: {
  activeTaskId?: string
  onNewTask: () => void
  onOpenSearch: () => void
  onSelectSkills?: () => void
  onSelectBrightMemory?: () => void
  onSelectProject: (projectId: string) => void
  /** Switch to a specific task by id. */
  onSelectTask: (id: string) => void
  onSelectAgent: (agent: Agent) => void
  onOpenSettings: () => void
  onOpenCreateAgent: () => void
  onOpenAgentSettings: (agent: Agent) => void
  onSidebarResize: (widthRem: number) => void
}) {
  const projects = useProjects()
  const activeProject = useActiveProject()
  const { setActive, remove } = useProjectsActions()
  const [addOpen, setAddOpen] = useState(false)
  const agents = useAgents()

  return (
    <Sidebar variant="inset" collapsible="offcanvas" className="border-r-0">
      <SidebarHeader className="p-3">
        <div className="flex items-center">
          <SidebarTrigger className="text-muted-foreground hover:text-foreground size-8" />
        </div>
        <SidebarTopNav
          items={topNav}
          onItemClick={(title) => {
            if (title === 'New task') onNewTask()
            else if (title === 'Search') onOpenSearch()
            else if (title === 'Skills') onSelectSkills?.()
            else if (title === 'Bright Memory') onSelectBrightMemory?.()
            else console.log('[nav]', title)
          }}
        />
      </SidebarHeader>

      <SidebarSeparator className="mx-3 bg-border/40" />

      <SidebarContent className="px-2">
        {/* Projects â€” each project renders its own task list as nested
            children, mirroring MiniMax Code's "Contexto da conversa"
            pattern. Tasks are reactive via the tasks store. */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-muted-foreground/70 flex items-center justify-between px-2 text-[11px] font-normal tracking-wide uppercase">
            <span>Projects</span>
            <button
              type="button"
              className="hover:bg-sidebar-accent text-muted-foreground hover:text-foreground -mr-1 flex h-5 w-5 items-center justify-center rounded transition-colors"
              aria-label="Add project"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="size-3.5" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.length === 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="default"
                    className="text-muted-foreground"
                    onClick={() => setAddOpen(true)}
                  >
                    <Folder className="size-4" />
                    <span className="text-[13px]">Add your first project</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {projects.map((p) => (
                <ProjectGroup
                  key={p.id}
                  projectId={p.id}
                  label={p.label}
                  path={p.path}
                  active={activeProject?.id === p.id}
                  activeTaskId={activeTaskId}
                  onActivate={() => setActive(p.id)}
                  onNewTaskForProject={() => {
                    void setActive(p.id)
                    onSelectProject(p.id)
                  }}
                  onRemoveProject={() => void remove(p.id)}
                  onSelectTask={onSelectTask}
                />
              ))}
              <LooseTasksGroup
                activeTaskId={activeTaskId}
                onSelectTask={onSelectTask}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Agent Team */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-muted-foreground/70 flex items-center justify-between px-2 text-[11px] font-normal tracking-wide uppercase">
            <span>Agent Team</span>
            <button
              type="button"
              className="hover:bg-sidebar-accent text-muted-foreground hover:text-foreground -mr-1 flex h-5 w-5 items-center justify-center rounded transition-colors"
              aria-label="Add agent"
              onClick={onOpenCreateAgent}
            >
              <Plus className="size-3.5" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {agents.map((a) => (
                <AgentRow
                  key={a.name}
                  agent={a}
                  onSelect={() => onSelectAgent(a)}
                  onOpenSettings={() => onOpenAgentSettings(a)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="mt-auto p-2">
        <UserCard
          name="Carlos Henrique"
          plan="Plus Plan"
          initials="CH"
          avatarUrl=""
          onClick={onOpenSettings}
        />
      </SidebarFooter>

      <SidebarResizeHandle onResize={onSidebarResize} />

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
    </Sidebar>
  )
}

/** Project row + its nested tasks. */
function ProjectGroup({
  projectId,
  label,
  path,
  active,
  activeTaskId,
  onActivate,
  onNewTaskForProject,
  onRemoveProject,
  onSelectTask,
}: {
  projectId: string
  label: string
  path: string
  active: boolean
  activeTaskId?: string
  onActivate: () => void
  onNewTaskForProject: () => void
  onRemoveProject: () => void
  onSelectTask: (id: string) => void
}) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const tasks = useTasksByProject(projectId)
  const hasActiveTask = tasks.some((task) => task.id === activeTaskId)

  return (
    <SidebarMenuItem
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <div className="group relative flex w-full items-center">
        <SidebarMenuButton
          size="default"
          isActive={active && !hasActiveTask}
          className="text-foreground/80 pr-14"
          onClick={() => {
            if (!active) {
              onActivate()
              setIsCollapsed(false)
            } else {
              setIsCollapsed((c) => !c)
            }
          }}
          title={path}
        >
          {active ? (
            <FolderOpen className="text-foreground size-4 shrink-0" />
          ) : (
            <Folder className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="truncate text-[13px] font-medium">{label}</span>
        </SidebarMenuButton>

        {/* Action buttons on hover: + (New task) and â‹¯ (Options) */}
        <div className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            title="New task for this project"
            onClick={(e) => {
              e.stopPropagation()
              onNewTaskForProject()
            }}
            className="hover:bg-sidebar-accent text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded transition-colors"
          >
            <Plus className="size-3.5" />
          </button>

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${label} options`}
                onClick={(e) => e.stopPropagation()}
                className="hover:bg-sidebar-accent text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded transition-colors"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="min-w-40">
              <DropdownMenuItem onSelect={onNewTaskForProject}>
                <Plus />
                New task
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  navigator.clipboard?.writeText(path).catch(() => undefined)
                }}
              >
                <Pin />
                Copy path
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={onRemoveProject}
              >
                <Trash2 />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {!isCollapsed && tasks.length > 0 && (
        <SidebarMenu className="border-border/40 ml-4 mt-0.5 flex flex-col gap-0.5 border-l pl-2">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              taskId={t.id}
              title={t.title}
              active={activeTaskId === t.id}
              onClick={() => onSelectTask(t.id)}
            />
          ))}
        </SidebarMenu>
      )}
    </SidebarMenuItem>
  )
}

/** Single task row (nested under a project or in the loose group). */
function TaskRow({
  taskId,
  title,
  active,
  onClick,
}: {
  taskId: string
  title: string
  active?: boolean
  onClick: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(title)

  const handleSaveRename = () => {
    const trimmed = editTitle.trim()
    if (trimmed && trimmed !== title) {
      tasksStore.update(taskId, { title: trimmed })
    }
    setIsEditing(false)
  }

  const handleRemove = () => {
    tasksStore.remove(taskId)
  }

  if (isEditing) {
    return (
      <SidebarMenuItem>
        <div className="flex h-7 w-full items-center gap-1 px-1">
          <Input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveRename()
              if (e.key === 'Escape') setIsEditing(false)
            }}
            autoFocus
            className="h-6 px-1.5 text-[12px]"
          />
          <button
            type="button"
            onClick={handleSaveRename}
            className="hover:bg-sidebar-accent text-emerald-500 flex h-6 w-6 items-center justify-center rounded transition-colors"
          >
            <Check className="size-3.5" />
          </button>
        </div>
      </SidebarMenuItem>
    )
  }

  return (
    <SidebarMenuItem
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <SidebarMenuButton
          size="sm"
          isActive={active}
          className="text-foreground/75 hover:text-foreground data-[active=true]:text-foreground h-7 px-2 text-[12.5px]"
          onClick={onClick}
        >
          <span className={`truncate ${active ? 'task-title-shine' : ''}`}>{title}</span>
        </SidebarMenuButton>

        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={`${title} options`}>
            <MoreHorizontal />
          </SidebarMenuAction>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="right" align="start" className="min-w-36">
          <DropdownMenuItem onSelect={() => setIsEditing(true)}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={handleRemove}
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

/** Tasks without a project, displayed with the same visual hierarchy. */
function LooseTasksGroup({
  activeTaskId,
  onSelectTask,
}: {
  activeTaskId?: string
  onSelectTask: (id: string) => void
}) {
  const tasks = useTasksByProject(null)
  const [isCollapsed, setIsCollapsed] = useState(false)
  if (tasks.length === 0) return null

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="default"
        className="text-foreground/80"
        onClick={() => setIsCollapsed((collapsed) => !collapsed)}
      >
        <Folder className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate text-[13px] font-medium">
          No project selected
        </span>
      </SidebarMenuButton>

      {!isCollapsed && (
        <SidebarMenu className="border-border/40 ml-4 mt-0.5 flex flex-col gap-0.5 border-l pl-2">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              taskId={t.id}
              title={t.title}
              active={activeTaskId === t.id}
              onClick={() => onSelectTask(t.id)}
            />
          ))}
        </SidebarMenu>
      )}
    </SidebarMenuItem>
  )
}

/** Agent row with hover "â‹¯" action and right-click context menu. */
function AgentRow({
  agent,
  onSelect,
  onOpenSettings,
}: {
  agent: Agent
  onSelect: () => void
  onOpenSettings: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <SidebarMenuItem
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <SidebarMenuButton
          size="default"
          className="text-foreground/80"
          onClick={onSelect}
        >
          <TeamAvatar seed={agent.avatarSeed} color={agent.color} />
          <span className="text-[13px]">{agent.name}</span>
        </SidebarMenuButton>

        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={`${agent.name} options`}>
            <MoreHorizontal />
          </SidebarMenuAction>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="right" align="start" className="min-w-40">
          <DropdownMenuItem
            onSelect={() => console.log('[agent] pin', agent.name)}
          >
            <Pin />
            Pin
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => console.log('[agent] rename', agent.name)}
          >
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => console.log('[agent] delete', agent.name)}
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

// (Suppression removed â€” SidebarItem is not exported from the sidebar
// UI primitives yet; the import was a leftover from an earlier draft.)



