import { useSyncExternalStore } from 'react'

/**
 * Per-task "is the user or the agent actively working on this?" signal.
 *
 * The AppSidebar uses this to drive the "shine" highlight on the active
 * task row. The base highlight ("is the task open?") is always on, but
 * the animated gradient sweep only runs while the user is typing or the
 * agent is streaming — see the "default" vs "working" rule in the
 * companion README.
 *
 * A small singleton store is enough because at most one task is active
 * at a time. We key it by `taskId` so opening a different task moves the
 * shine to the new row.
 */

export type TaskActivity = 'idle' | 'user-typing' | 'streaming'

let current: { taskId: string | null; activity: TaskActivity } = {
  taskId: null,
  activity: 'idle',
}
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function setTaskActivity(taskId: string | null, activity: TaskActivity): void {
  if (current.taskId === taskId && current.activity === activity) return
  current = { taskId, activity }
  emit()
}

export function clearTaskActivity(taskId: string | null): void {
  if (current.taskId !== taskId) return
  current = { taskId, activity: 'idle' }
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): { taskId: string | null; activity: TaskActivity } {
  return current
}

/**
 * Returns the current activity state and a boolean indicating whether
 * `taskId` is the active one. Components that only care about whether
 * the *active* task is currently working can read `working` directly.
 */
export function useTaskActivity(taskId?: string | null): {
  activeTaskId: string | null
  activity: TaskActivity
  working: boolean
  isCurrent: boolean
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const isCurrent = snap.taskId === taskId && !!taskId
  return {
    activeTaskId: snap.taskId,
    activity: snap.activity,
    working: isCurrent && snap.activity !== 'idle',
    isCurrent,
  }
}
