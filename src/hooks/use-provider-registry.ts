/**
 * React hooks for reading provider registry state.
 *
 * All hooks subscribe to the registry via `useSyncExternalStore`, so any
 * change to providers, credentials, or models triggers a re-render. They
 * return stable references across renders when the underlying snapshot
 * hasn't changed (see `useRegistrySelector` below for the caching scheme).
 *
 * Mental model:
 *   - useRegisteredProviders()        — every provider BrightCode knows about
 *   - useProviderStatus(id)           — one provider + whether it's configured
 *   - useAvailableModels()            — flat list of models the user can call
 *   - useAvailableModelsGrouped()     — same, grouped by provider
 *   - useDefaultModel()               — sensible default selection for the chat
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'
import {
  providerRegistry,
  type IAgentProvider,
  type ModelInfo,
} from '@/lib/providers'

// ── Low-level subscription helper ────────────────────────────────────────

/**
 * Read a value from the registry, re-reading whenever any registry mutation
 * fires. Returns a **stable reference** across renders when nothing has
 * changed — required by `useSyncExternalStore`. Without this, every call
 * to `getSnapshot` produces a new array/object, React sees the change via
 * `Object.is`, schedules a re-render, and the cycle repeats forever.
 *
 * The trick: cache the last computed value keyed by the registry's
 * monotonic `version` counter. When the version is unchanged, return the
 * same reference. The `compute` function is held in a ref so `getSnapshot`
 * can stay a stable identity (also required by `useSyncExternalStore`).
 */
function useRegistrySelector<T>(compute: () => T): T {
  const subscribe = useCallback(
    (onChange: () => void) => providerRegistry.subscribe(onChange),
    [],
  )

  // Hold `compute` in a ref so getSnapshot can stay a stable identity.
  const computeRef = useRef(compute)
  computeRef.current = compute

  // Cache keyed by the registry's version. Same version → same reference.
  const cacheRef = useRef<{ version: number; value: T } | null>(null)

  const getSnapshot = useCallback((): T => {
    const version = providerRegistry.getVersion()
    const cached = cacheRef.current
    if (cached && cached.version === version) {
      return cached.value
    }
    const value = computeRef.current()
    cacheRef.current = { version, value }
    return value
  }, [])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ── Public hooks ─────────────────────────────────────────────────────────

/** Every provider the bootstrap registered, with their current credential state. */
export function useRegisteredProviders(): Array<{
  provider: IAgentProvider
  hasCredential: boolean
}> {
  return useRegistrySelector(() =>
    providerRegistry.list().map((provider) => ({
      provider,
      hasCredential: providerRegistry.hasCredential(provider.id),
    })),
  )
}

export interface ProviderStatus {
  provider: IAgentProvider | undefined
  hasCredential: boolean
  /** Models this provider offers that the user can call right now. */
  callableModels: ModelInfo[]
}

/** Status of a single provider (or `undefined` if the id is unknown). */
export function useProviderStatus(providerId: string): ProviderStatus {
  return useRegistrySelector(() => {
    const provider = providerRegistry.get(providerId)
    if (!provider) {
      return { provider: undefined, hasCredential: false, callableModels: [] }
    }
    const hasCred = providerRegistry.hasCredential(providerId)
    const callableModels = provider.listModels().filter((m) => {
      const requiresAuth = m.requiresAuth !== false
      return hasCred || !requiresAuth
    })
    return {
      provider,
      hasCredential: hasCred,
      callableModels: callableModels.map((m) => ({ ...m, provider: providerId })),
    }
  })
}

/**
 * Flat list of models the user can call right now — i.e. providers with a
 * credential, plus any `requiresAuth: false` model. This is what the chat
 * picker should display.
 */
export function useAvailableModels(): ModelInfo[] {
  return useRegistrySelector(() => providerRegistry.listAllModels())
}

export interface ProviderModelsGroup {
  provider: IAgentProvider
  hasCredential: boolean
  models: ModelInfo[]
}

/** Same as `useAvailableModels` but grouped by provider, for grouped dropdowns. */
export function useAvailableModelsGrouped(): ProviderModelsGroup[] {
  return useRegistrySelector(() => providerRegistry.listAvailableModelsGrouped())
}

/**
 * Best-guess default model for the chat input. Picks the first callable
 * model using this priority:
 *   1. A free model (no auth, no cost)
 *   2. Any configured provider's first model
 *   3. `undefined` (chat will show an empty state)
 */
export function useDefaultModel(): ModelInfo | undefined {
  return useRegistrySelector(() => {
    const groups = providerRegistry.listAvailableModelsGrouped()
    if (groups.length === 0) return undefined

    // Prefer a free model
    for (const g of groups) {
      const free = g.models.find((m) => m.free || m.requiresAuth === false)
      if (free) return free
    }
    // Otherwise any configured provider's first model
    for (const g of groups) {
      if (g.hasCredential && g.models.length > 0) return g.models[0]
    }
    return groups[0]?.models[0]
  })
}

// ── Mutation helpers (stable refs) ───────────────────────────────────────

/** Stable setter that won't change identity across renders. */
export function useSetCredential() {
  return useCallback(
    (providerId: string, apiKey: string) => {
      providerRegistry.setCredential(providerId, { method: 'api_key', apiKey })
    },
    [],
  )
}

export function useRemoveCredential() {
  return useCallback(
    (providerId: string) => providerRegistry.removeCredential(providerId),
    [],
  )
}
