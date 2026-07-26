import { useEffect, useMemo, useState } from 'react'
import { TaskWorkspace } from '@/components/task/TaskWorkspace'
import { useTask } from '@/hooks/use-tasks'
import { useProjects } from '@/hooks/use-projects'
import { tasksStore } from '@/lib/tasks/store'
import type { Project } from '@/lib/projects/store'

/**
 * A conversation workspace where Chat and opened files share the main tab bar.
 * The optional right sidebar is reserved for the project FileTree.
 */
export function TaskView({ taskId }: { taskId: string }) {
  const task = useTask(taskId)
  const projects = useProjects()
  const [explorerOpen, setExplorerOpen] = useState(false)

  const project = useMemo<Project | null>(() => {
    if (!task?.projectId) return null
    return projects.find((item) => item.id === task.projectId) ?? null
  }, [task, projects])

  const [initialMessage] = useState<string | null>(() =>
    tasksStore.peekPendingFirstMessage(taskId) ?? null,
  )

  useEffect(() => {
    if (initialMessage) {
      tasksStore.clearPendingFirstMessage(taskId)
    }
  }, [initialMessage, taskId])

  useEffect(() => {
    setExplorerOpen(false)
  }, [taskId])

  if (!task) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-[13px]">
        This task no longer exists.
      </div>
    )
  }

  const toggleExplorer = project
    ? () => setExplorerOpen((current) => !current)
    : undefined

  return (
    <TaskWorkspace
      title={task.title}
      taskId={taskId}
      project={project}
      initialMessage={initialMessage}
      explorerOpen={explorerOpen}
      onToggleExplorer={toggleExplorer}
    />
  )
}
