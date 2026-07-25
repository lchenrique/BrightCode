/**
 * Auth store — persists per-provider credentials.
 *
 * Dual mode:
 *   - Electron wrapper: delegates to the main process via IPC. The main
 *     process writes to `electron-store` (a JSON file under the OS user
 *     config dir, never synced to a browser profile, never reachable from
 *     web content). The renderer caches the last-seen values so reads are
 *     synchronous after the first IPC round-trip.
 *   - Plain browser dev: writes to `localStorage`. Same shape. Same API.
 *
 * Either way, a `subscribe(listener)` API is exposed so the registry can
 * re-emit when credentials change (e.g. the main process broadcast after
 * a Settings save).
 *
 * Storage shape (versioned for future migration):
 *   brightcode.auth.v1 = { [providerId]: StoredCredential }
 *
 * Security TODO before any public release:
 *   - Add `encryptionKey` to electron-store (OS-derived or passphrase).
 *   - Move to OS keyring (keytar) for API keys; electron-store is fine for
 *     metadata, but tokens at rest should live in the keychain.
 */

import type { CLISource, ProviderCredential } from '../types'

export interface StoredCredential {
  method: ProviderCredential['method']
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  cliSource?: CLISource
  cliEmail?: string
}

type Listener = () => void

// ── Detection ───────────────────────────────────────────────────────────

const isElectron =
  typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

// ── Browser (localStorage) backend ──────────────────────────────────────

const STORAGE_KEY = 'brightcode.auth.v1'

function readLocal(): Record<string, StoredCredential> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeLocal(data: Record<string, StoredCredential>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.error('[authStore] failed to persist credentials:', err)
  }
}

const localListeners = new Set<Listener>()
const localBackend = {
  read: (): Record<string, StoredCredential> => readLocal(),
  write: (data: Record<string, StoredCredential>): void => writeLocal(data),
  subscribe: (l: Listener): (() => void) => {
    localListeners.add(l)
    return () => localListeners.delete(l)
  },
  notify: (): void => {
    for (const l of localListeners) l()
  },
}

// ── Electron backend ────────────────────────────────────────────────────

const electronBackend = (() => {
  if (!isElectron) return null
  const api = window.electronAPI!.auth
  let cache: Record<string, StoredCredential> = {}
  let hydrated = false
  let pendingHydrate: Promise<void> | null = null

  async function ensureHydrated(): Promise<void> {
    if (hydrated) return
    if (pendingHydrate) return pendingHydrate
    pendingHydrate = (async () => {
      const list = await api.list()
      const next: Record<string, StoredCredential> = {}
      for (const { providerId, credential } of list) {
        next[providerId] = credential
      }
      cache = next
      hydrated = true
    })()
    await pendingHydrate
    pendingHydrate = null
  }

  const listeners = new Set<Listener>()
  // Main process broadcasts after every set/remove/clear.
  api.onChanged(() => {
    hydrated = false
    void ensureHydrated().then(() => {
      for (const l of listeners) l()
    })
  })

  return {
    read: (): Record<string, StoredCredential> => cache,
    write: (data: Record<string, StoredCredential>): void => {
      // For Electron we never write directly; each op is its own IPC call.
      // This stays here only so the unified `set` below can diff the old
      // vs new value to decide which providerIds to update.
      cache = data
    },
    subscribe: (l: Listener): (() => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    ensureHydrated,
  }
})()

// ── Unified store ───────────────────────────────────────────────────────

const backend = isElectron && electronBackend ? electronBackend : localBackend

export const authStore = {
  /** Read all credentials synchronously. In Electron the cache is primed
   *  at app start; in the browser it's a direct localStorage read. */
  readAll(): Record<string, StoredCredential> {
    return backend.read()
  },

  get(providerId: string): StoredCredential | undefined {
    return backend.read()[providerId]
  },

  /** Set a credential. In Electron this is async (IPC round-trip) but the
   *  in-memory cache is updated synchronously so subsequent reads see the
   *  new value. The returned promise resolves once the main process
   *  acknowledges the write. */
  async set(providerId: string, credential: StoredCredential): Promise<void> {
    if (isElectron) {
      await window.electronAPI!.auth.set(providerId, credential)
      // Cache is refreshed via the broadcast handler, but update it now
      // so the synchronous read right after set() sees the new value.
      const data = { ...backend.read(), [providerId]: credential }
      backend.write(data)
      return
    }
    const data = { ...backend.read(), [providerId]: credential }
    localBackend.write(data)
    localBackend.notify()
  },

  async remove(providerId: string): Promise<void> {
    if (isElectron) {
      await window.electronAPI!.auth.remove(providerId)
      const data = { ...backend.read() }
      delete data[providerId]
      backend.write(data)
      return
    }
    const data = { ...backend.read() }
    delete data[providerId]
    localBackend.write(data)
    localBackend.notify()
  },

  has(providerId: string): boolean {
    return providerId in backend.read()
  },

  list(): Array<{ providerId: string; credential: StoredCredential }> {
    return Object.entries(backend.read()).map(([providerId, credential]) => ({
      providerId,
      credential,
    }))
  },

  async clear(): Promise<void> {
    if (isElectron) {
      await window.electronAPI!.auth.clear()
      backend.write({})
      return
    }
    localBackend.write({})
    localBackend.notify()
  },

  /** Subscribe to credential changes. Used by the registry to re-emit. */
  subscribe(listener: Listener): () => void {
    return backend.subscribe(listener)
  },

  /** Best-effort: pre-load the in-memory cache. Call from app boot to
   *  avoid an empty UI flash in Electron. */
  async hydrate(): Promise<void> {
    if (electronBackend) await electronBackend.ensureHydrated()
  },

  isElectron,
}

export type { Listener as AuthStoreListener }
