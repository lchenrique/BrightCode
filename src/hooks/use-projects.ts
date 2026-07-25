/**
 * React hooks for the projects store. All hooks use `useSyncExternalStore`
 * with a version-keyed cache so that the snapshot reference is stable
 * across renders (returning a new array each call would cause infinite
 * re-render loops).
 */

import { useCallback, useSyncExternalStore } from 'react'
import { projectsStore, type Project } from '@/lib/projects/store'

type Snapshot<T> = { version: number; value: T }

// Per-hook caches. Module-scoped so all hook consumers share the same
// stable references for the same store version.
const projectsCache: Snapshot<Project[]> = { version: -1, value: [] }
const activeIdCache: Snapshot<string | null> = { version: -1, value: null }
const activeCache: Snapshot<Project | null> = { version: -1, value: null }
const hydratedCache: Snapshot<boolean> = { version: -1, value: false }

function readCached<T>(cache: Snapshot<T>, read: () => T): T {
  const v = projectsStore.getVersion()
  if (cache.version !== v) {
    cache.version = v
    cache.value = read()
  }
  return cache.value
}

function useStoreSelector<T>(cache: Snapshot<T>, read: () => T): T {
  const subscribe = useCallback((onChange: () => void) => projectsStore.subscribe(onChange), [])
  const getSnapshot = useCallback(() => readCached(cache, read), [cache, read])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** All projects in the registry (order = insertion order). */
export function useProjects(): Project[] {
  return useStoreSelector(projectsCache, () => projectsStore.getProjects())
}

/** The currently active project id, or null. */
export function useActiveProjectId(): string | null {
  return useStoreSelector(activeIdCache, () => projectsStore.getActiveId())
}

/** The currently active project, or null. */
export function useActiveProject(): Project | null {
  return useStoreSelector(activeCache, () => projectsStore.getActive())
}

/** True once the store has finished its first hydration. */
export function useProjectsHydrated(): boolean {
  return useStoreSelector(hydratedCache, () => projectsStore.isHydrated())
}

/** Imperative actions — return stable callbacks. */
export function useProjectsActions() {
  const add = useCallback((path: string, label?: string) => projectsStore.add(path, label), [])
  const remove = useCallback((id: string) => projectsStore.remove(id), [])
  const setActive = useCallback((id: string | null) => projectsStore.setActive(id), [])
  const refresh = useCallback(() => projectsStore.refresh(), [])
  return { add, remove, setActive, refresh }
}
