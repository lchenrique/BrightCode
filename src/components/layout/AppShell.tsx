import { useCallback, useEffect, useState } from 'react'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/sidebar/AppSidebar'
import { WelcomeScreen } from '@/components/home/WelcomeScreen'
import { TaskView } from '@/components/task/TaskView'
import { AgentView } from '@/components/agent/AgentView'
import { CreateAgentDialog } from '@/components/agent/CreateAgentDialog'
import { AgentSettingDialog } from '@/components/agent/AgentSettingDialog'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { SearchDialog } from '@/components/search/SearchDialog'
import { useSettingsListener } from '@/hooks/use-settings'
import { useActiveProject, useProjectsActions } from '@/hooks/use-projects'
import { tasksStore, deriveTaskTitle } from '@/lib/tasks/store'
import { requestProjectFileOpen } from '@/lib/projects/file-events'
import { BashApprovalDialog } from '@/components/chat/BashApprovalDialog'
import { agentStore } from '@/lib/agents'
import {
  readLegacyAgentTranscript,
  clearLegacyAgentTranscript,
  writeTaskTranscript,
} from '@/lib/agents/transcript'

import { SkillsView } from '@/components/skills/SkillsView'
import { BrightMemoryView } from '@/components/bright-memory/BrightMemoryView'

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
 * `bright-memory` → Bright Memory setup and status view.
 */
type View =
  | { kind: 'welcome' }
  | { kind: 'task'; id: string }
  | { kind: 'agent'; agentId: string; taskId: string }
  | { kind: 'skills' }
  | { kind: 'bright-memory' }

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
  const [searchOpen, setSearchOpen] = useState(false)
  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [agentSettings, setAgentSettings] = useState<{
    name: string
    avatarSeed: string
  } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth)
  const activeProject = useActiveProject()
  const { setActive: setActiveProject } = useProjectsActions()

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') {
        return
      }
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', openSearch)
    return () => window.removeEventListener('keydown', openSearch)
  }, [])

  // Allow any component to open Settings via the global event bus.
  useSettingsListener(setSettingsOpen)

  const handleSidebarResize = useCallback((widthRem: number) => {
    setSidebarWidth(clampSidebarWidth(widthRem))
  }, [])

  /**
   * Switch the view to a Teams agent's session. If the agent already
   * has sessions, the most recently updated one is opened (so the
   * user does not lose context). Otherwise a fresh session is created
   * so the user can start talking right away. Used by the agent row
   * in the sidebar and by the "Open conversation" link inside the
   * orchestrator's delegation card. Falls back to the welcome view
   * if the agent is gone.
   */
  const openAgentConversation = useCallback(
    async (agentId: string) => {
      const agent = agentStore.list().find((a) => a.id === agentId)
      if (!agent) {
        setView({ kind: 'welcome' })
        return
      }
      const existing = tasksStore.getTasksByAgent(agentId)
      if (existing.length > 0) {
        setView({ kind: 'agent', agentId, taskId: existing[0].id })
        return
      }
      // First session — pull any legacy single-conversation transcript
      // (keyed `agent-<id>`) before the new ChatSurface mounts so the
      // user does not see an empty composer flash before the messages
      // land. After writing to the new taskId, drop the legacy copy so
      // it does not haunt a future migration.
      const legacy = await readLegacyAgentTranscript(agentId)
      const created = tasksStore.create({
        projectId: activeProject?.id ?? null,
        agentId,
        title: `${agent.name} session`,
        selectedModel: agent.model || undefined,
      })
      if (legacy.length > 0) {
        await writeTaskTranscript(created.id, legacy)
        await clearLegacyAgentTranscript(agentId)
      }
      setView({ kind: 'agent', agentId, taskId: created.id })
    },
    [activeProject],
  )

  /**
   * Always create a new session for an agent and switch to it.
   * Mirrors "New chat" in a project: the user explicitly asked for a
   * fresh conversation, so we do not silently reopen the latest one.
   */
  const createAgentSession = useCallback(
    (agentId: string) => {
      const agent = agentStore.list().find((a) => a.id === agentId)
      if (!agent) {
        setView({ kind: 'welcome' })
        return
      }
      const created = tasksStore.create({
        projectId: activeProject?.id ?? null,
        agentId,
        title: `${agent.name} session`,
        selectedModel: agent.model || undefined,
      })
      setView({ kind: 'agent', agentId, taskId: created.id })
    },
    [activeProject],
  )

  /**
   * Called by the WelcomeScreen when the user submits the first
   * message. Creates a task (parented to the active project, or loose
   * if none), parks the message for the TaskView to auto-send, and
   * switches the view to the new task. This is the entry point for
   * the "New task" flow that creates a sidebar entry under the
   * project, mirroring MiniMax Code.
   */
  const handleCreateTask = useCallback(
    (
      payload: { text: string; images: import('@/components/home/ChatInput').AttachedImage[] },
      selectedModel?: string,
      selectedAccountId?: string,
    ) => {
      const projectId = activeProject?.id ?? null
      const title = deriveTaskTitle(payload.text)
      const task = tasksStore.create({ projectId, title, selectedModel, selectedAccountId })
      tasksStore.setPendingFirstMessage(task.id, payload)
      setView({ kind: 'task', id: task.id })
    },
    [activeProject],
  )

  /**
   * When the user picks a project in the sidebar, auto-resume the
   * most recent task in that project — so they don't lose context
   * every time they switch projects. Falls back to the empty welcome
   * view when the project has no tasks yet.
   */
  const handleSelectProject = useCallback(
    (projectId: string) => {
      void setActiveProject(projectId).then(() => {
        const latest = tasksStore.getTasksByProject(projectId)[0]
        if (latest) {
          setView({ kind: 'task', id: latest.id })
        } else {
          setView({ kind: 'welcome' })
        }
      })
    },
    [setActiveProject],
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
      <div className="flex h-full w-full">
        <AppSidebar
          activeTaskId={view.kind === 'task' ? view.id : undefined}
          onNewTask={() => setView({ kind: 'welcome' })}
          onOpenSearch={() => setSearchOpen(true)}
          onSelectSkills={() => setView({ kind: 'skills' })}
          onSelectBrightMemory={() => setView({ kind: 'bright-memory' })}
          onSelectProject={handleSelectProject}
          onSelectTask={(id) => {
            const task = tasksStore.getTask(id)
            if (task?.projectId) {
              void setActiveProject(task.projectId)
            }
            setView({ kind: 'task', id })
          }}
          onSelectAgent={(agent) => openAgentConversation(agent.id)}
          onCreateAgentSession={(agent) => createAgentSession(agent.id)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenCreateAgent={() => setCreateAgentOpen(true)}
          onOpenAgentSettings={(agent) =>
            setAgentSettings({ name: agent.name, avatarSeed: agent.avatarSeed })
          }
          onSidebarResize={handleSidebarResize}
        />

        <main className="bg-background relative min-w-0 flex-1 overflow-hidden">
          {view.kind === 'welcome' && (
            <WelcomeScreen onCreateTask={handleCreateTask} />
          )}
          {view.kind === 'task' && (
            <TaskView
              key={view.id}
              taskId={view.id}
              onOpenAgentConversation={openAgentConversation}
            />
          )}
          {view.kind === 'agent' && (
            <AgentView
              key={view.taskId}
              agentId={view.agentId}
              taskId={view.taskId}
              onOpenAgentConversation={openAgentConversation}
            />
          )}
          {view.kind === 'skills' && <SkillsView />}
          {view.kind === 'bright-memory' && <BrightMemoryView />}
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelectProject={(projectId) => {
          void setActiveProject(projectId)
          setView({ kind: 'welcome' })
        }}
        onSelectTask={(id) => {
          const task = tasksStore.getTask(id)
          if (task?.projectId) void setActiveProject(task.projectId)
          setView({ kind: 'task', id })
        }}
        onSelectFile={({ projectId, path, name }) => {
          void (async () => {
            await setActiveProject(projectId)
            const task =
              tasksStore.getTasksByProject(projectId)[0] ??
              tasksStore.create({
                projectId,
                title: 'Project workspace',
              })
            requestProjectFileOpen({ projectId, path, name })
            setView({ kind: 'task', id: task.id })
          })()
        }}
      />
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
          avatarSeed={agentSettings.avatarSeed}
        />
      )}
      <BashApprovalDialog />
    </SidebarProvider>
  )
}
