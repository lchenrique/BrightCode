/**
 * TaskView — a single conversation thread, identified by task id.
 *
 * Replaces the old hand-rolled mock with a real chat. Looks up the
 * task in the tasks store, resolves the owning project (if any), and
 * mounts a ChatSurface with the project injected into the system
 * prompt. The first user message (if it was just submitted from the
 * welcome screen) is auto-sent on mount via the `initialMessage`
 * prop, and the pending entry in the store is cleared once the send
 * fires — so the user doesn't have to retype.
 *
 * The header shows the task title (truncated on small widths). The
 * progress panel and edited-files card are not used here yet —
 * those are project-level concerns. Phase 2 can add per-task
 * progress tracking if needed.
 */

import { useEffect, useMemo, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatSurface } from '@/components/chat/ChatSurface'
import { ViewTopBar } from '@/components/layout/ViewTopBar'
import { useTask } from '@/hooks/use-tasks'
import { useProjects } from '@/hooks/use-projects'
import { tasksStore } from '@/lib/tasks/store'
import type { Project } from '@/lib/projects/store'

export function TaskView({ taskId }: { taskId: string }) {
  const task = useTask(taskId)
  const projects = useProjects()

  // Project for the system prompt. May be null for "loose" tasks.
  const project = useMemo<Project | null>(() => {
    if (!task?.projectId) return null
    return projects.find((p) => p.id === task.projectId) ?? null
    // We deliberately depend on `projects` so re-renders pick up newly
    // added/removed projects. `task` is already reactive via useTask.
  }, [task, projects])

  // Read the pending first message from the store exactly once. We
  // lift it into state so the prop reference is stable across renders
  // — ChatSurface guards against re-fires with its own ref, but a
  // stable value here keeps things clean.
  const [initialMessage] = useState<string | null>(() =>
    tasksStore.peekPendingFirstMessage(taskId) ?? null,
  )

  // Clear the pending entry once the auto-send has fired. This runs
  // before the ChatSurface mounts (the prop value is already set),
  // so the store stays consistent even if the user re-creates a task
  // with the same id.
  useEffect(() => {
    if (initialMessage) {
      tasksStore.clearPendingFirstMessage(taskId)
    }
  }, [initialMessage, taskId])

  if (!task) {
    // Task was deleted (or id is stale). Fall back to a minimal empty
    // state so the user isn't stuck on a blank screen — Phase 2 will
    // route the user back to the welcome view automatically.
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        This task no longer exists.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ViewTopBar title={task.title} />

      <ChatSurface
        taskId={taskId}
        project={project}
        initialMessage={initialMessage}
        key={taskId}
      />
    </div>
  )
}

// Suppress the no-unused-vars lint on the ScrollArea import — we keep
// it because Phase 2 may want a custom scrollable wrapper here, and
// removing the import just to add it back later churns the diff.
// (Currently the chat surface owns its own scroll container.)
void ScrollArea
