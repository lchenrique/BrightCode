/**
 * React hooks for the agents store.
 *
 * `useAgents(enabledOnly?)` returns the agent list with a stable
 * snapshot reference across renders (so `useSyncExternalStore` does
 * not loop). When `enabledOnly` is true, disabled agents are filtered
 * out — used by the sidebar which only renders enabled agents.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { agentStore, type AgentDefinition } from '@/lib/agents'

export type AgentRow = AgentDefinition

function shallowEqualAgents(a: AgentRow[], b: AgentRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && (a[i].id !== b[i].id || a[i].name !== b[i].name)) {
      return false
    }
  }
  return true
}

/**
 * Subscribe to the agents store. Returns a stable array reference
 * between renders even if the underlying store emits without changes,
 * so it is safe to feed into `useSyncExternalStore` without looping.
 */
export function useAgents(enabledOnly = false): AgentRow[] {
  const cacheRef = useRef<AgentRow[]>([])
  const subscribe = useCallback((cb: () => void) => agentStore.subscribe(cb), [])
  const getSnapshot = useCallback(() => {
    const next = enabledOnly ? agentStore.list().filter((a) => a.enabled) : agentStore.list()
    const prev = cacheRef.current
    if (shallowEqualAgents(prev, next)) return prev
    cacheRef.current = next
    return next
  }, [enabledOnly])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}