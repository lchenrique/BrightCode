/**
 * React hooks for the tasks store. Same stable-snapshot pattern as
 * `use-projects.ts` — module-scoped cache keyed by store version, so
 * `useTasks()` returns the same array reference across renders and
 * doesn't loop.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { tasksStore, type Task } from '@/lib/tasks/store'

type Snapshot<T> = { version: number; value: T }

// Per-hook caches. All consumers share the same stable reference for a
// given store version.
const tasksCache: Snapshot<Task[]> = { version: -1, value: [] }

function readCached<T>(cache: Snapshot<T>, read: () => T): T {
  const v = tasksStore.getVersion()
  if (cache.version !== v) {
    cache.version = v
    cache.value = read()
  }
  return cache.value
}

function useStoreSelector<T>(cache: Snapshot<T>, read: () => T): T {
  const subscribe = useCallback(
    (onChange: () => void) => tasksStore.subscribe(onChange),
    [],
  )
  const getSnapshot = useCallback(() => readCached(cache, read), [cache, read])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** All tasks, newest first. */
export function useTasks(): Task[] {
  return useStoreSelector(tasksCache, () => tasksStore.getTasks())
}

/** Tasks belonging to a specific project (or null for "loose" tasks). */
export function useTasksByProject(projectId: string | null): Task[] {
  return useStoreSelector(
    { version: -1, value: [] },
    () => tasksStore.getTasksByProject(projectId),
  )
}

/** A single task by id. Returns `undefined` if not found. */
export function useTask(id: string | null): Task | undefined {
  return useStoreSelector(
    { version: -1, value: undefined },
    () => (id ? tasksStore.getTask(id) : undefined),
  )
}

/** Imperative actions — return stable callbacks. */
export function useTasksActions() {
  const create = useCallback(
    (input: {
      projectId: string | null
      title: string
      selectedModel?: string
    }) =>
      tasksStore.create(input),
    [],
  )
  const remove = useCallback((id: string) => tasksStore.remove(id), [])
  const update = useCallback(
    (id: string, patch: Parameters<typeof tasksStore.update>[1]) =>
      tasksStore.update(id, patch),
    [],
  )
  return { create, remove, update }
}
