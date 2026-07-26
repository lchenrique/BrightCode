import { useCallback, useEffect, useState } from 'react'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/sidebar/AppSidebar'
import { WelcomeScreen } from '@/components/home/WelcomeScreen'
import { TaskView } from '@/components/task/TaskView'
import { AgentView } from '@/components/agent/AgentView'
import { CreateAgentDialog } from '@/components/agent/CreateAgentDialog'
import { AgentSettingDialog } from '@/components/agent/AgentSettingDialog'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { useSettingsListener } from '@/hooks/use-settings'
import { useActiveProject, useProjectsActions } from '@/hooks/use-projects'
import { tasksStore, deriveTaskTitle } from '@/lib/tasks/store'

import { SkillsView } from '@/components/skills/SkillsView'

/**
 * Interface-only view switching — plain React state, no router.
 *
 * `welcome`      → hero landing / New task view (with the active project).
 *                  Submitting the first message creates a task and
 *                  switches the view to `task`.
 * `task`         → a specific conversation thread, by id. Created when
 *                  the user submits the first message in `welcome`.
 * `agent`        → the agent configuration view.
 * `skills`       → skills manager and library view.
 */
type View =
  | { kind: 'welcome' }
  | { kind: 'task'; id: string }
  | { kind: 'agent'; name: string; emoji: string }
  | { kind: 'skills' }

/** Resizable sidebar width (rem), persisted across sessions. */
const SIDEBAR_WIDTH_STORAGE_KEY = 'brightcode:sidebar-width'
const SIDEBAR_DEFAULT_WIDTH = 16
const SIDEBAR_MIN_WIDTH = 13 // 208px
const SIDEBAR_MAX_WIDTH = 26 // 416px

function clampSidebarWidth(width: number) {
  return Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH)
}

function getInitialSidebarWidth() {
  const stored = Number.parseFloat(
    localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? '',
  )
  return Number.isFinite(stored)
    ? clampSidebarWidth(stored)
    : SIDEBAR_DEFAULT_WIDTH
}

export function AppShell() {
  const [view, setView] = useState<View>({ kind: 'welcome' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [agentSettings, setAgentSettings] = useState<{
    name: string
    emoji: string
  } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth)
  const activeProject = useActiveProject()
  const { setActive: setActiveProject } = useProjectsActions()

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  // Allow any component to open Settings via the global event bus.
  useSettingsListener(setSettingsOpen)

  const handleSidebarResize = useCallback((widthRem: number) => {
    setSidebarWidth(clampSidebarWidth(widthRem))
  }, [])

  /**
   * Called by the WelcomeScreen when the user submits the first
   * message. Creates a task (parented to the active project, or loose
   * if none), parks the message for the TaskView to auto-send, and
   * switches the view to the new task. This is the entry point for
   * the "New task" flow that creates a sidebar entry under the
   * project, mirroring MiniMax Code.
   */
  const handleCreateTask = useCallback(
    (message: string) => {
      const projectId = activeProject?.id ?? null
      const title = deriveTaskTitle(message)
      const task = tasksStore.create({ projectId, title })
      tasksStore.setPendingFirstMessage(task.id, message)
      setView({ kind: 'task', id: task.id })
    },
    [activeProject],
  )

  return (
    <SidebarProvider
      style={
        {
          '--sidebar-width': `${sidebarWidth}rem`,
          '--sidebar-width-icon': '3.5rem',
        } as React.CSSProperties
      }
    >
      <div className="flex h-svh w-full">
        <AppSidebar
          activeTaskId={view.kind === 'task' ? view.id : undefined}
          onNewTask={() => setView({ kind: 'welcome' })}
          onSelectSkills={() => setView({ kind: 'skills' })}
          onSelectProject={(projectId) => {
            void setActiveProject(projectId)
            setView({ kind: 'welcome' })
          }}
          onSelectTask={(id) => {
            const task = tasksStore.getTask(id)
            if (task?.projectId) {
              void setActiveProject(task.projectId)
            }
            setView({ kind: 'task', id })
          }}
          onSelectAgent={(agent) =>
            setView({ kind: 'agent', name: agent.name, emoji: agent.emoji })
          }
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenCreateAgent={() => setCreateAgentOpen(true)}
          onOpenAgentSettings={(agent) =>
            setAgentSettings({ name: agent.name, emoji: agent.emoji })
          }
          onSidebarResize={handleSidebarResize}
        />

        <main className="bg-background relative flex-1 overflow-hidden">
          {view.kind === 'welcome' && (
            <WelcomeScreen onCreateTask={handleCreateTask} />
          )}
          {view.kind === 'task' && <TaskView key={view.id} taskId={view.id} />}
          {view.kind === 'agent' && (
            <AgentView key={view.name} agentName={view.name} emoji={view.emoji} />
          )}
          {view.kind === 'skills' && <SkillsView />}
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <CreateAgentDialog
        open={createAgentOpen}
        onOpenChange={setCreateAgentOpen}
      />
      {agentSettings && (
        <AgentSettingDialog
          key={agentSettings.name}
          open
          onOpenChange={(open) => {
            if (!open) setAgentSettings(null)
          }}
          agentName={agentSettings.name}
          emoji={agentSettings.emoji}
        />
      )}
    </SidebarProvider>
  )
}
