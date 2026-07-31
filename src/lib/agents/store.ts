/**
 * Agent store — types + dual-backend persistence for agent team definitions.
 *
 * Dual mode:
 *   - Electron wrapper: delegates to the main process via IPC. The main
 *     process writes to `electron-store` (a JSON file under the OS user
 *     config dir). The renderer caches the last-seen values so reads are
 *     synchronous after the first IPC round-trip.
 *   - Plain browser dev: writes to `localStorage`. Same shape. Same API.
 *
 * Storage key: `brightcode.agents.v1`
 * Electron store key: `agents`
 */

export interface AgentDefinition {
  id: string
  name: string
  /**
   * Deterministic seed for the DiceBear bottts avatar. Same seed renders
   * the same robot, so we can use the agent name as a stable seed without
   * storing image data.
   */
  avatarSeed: string
  description: string
  systemPrompt: string
  model: string
  accountId?: string
  projectId?: string
  tools: string[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

type Listener = () => void

const isElectron =
  typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

const STORAGE_KEY = 'brightcode.agents.v1'

function now(): number {
  return Date.now()
}

// ── Browser (localStorage) backend ───────────────────────────────────────

/**
 * Backfill `avatarSeed` for older records that were stored before the
 * emoji → avatar migration. Anything that already has `avatarSeed` is
 * left alone. The seed is just used by DiceBear, so any non-empty
 * string is fine — falling back to the agent name keeps the avatar
 * stable per persona.
 */
function migrate(record: Record<string, unknown>): AgentDefinition {
  const r = record as Partial<AgentDefinition> & { emoji?: string }
  if (!r.avatarSeed) {
    r.avatarSeed = r.emoji && r.emoji.length > 0 ? r.emoji : (r.name ?? 'agent')
  }
  delete (r as { emoji?: string }).emoji
  return r as AgentDefinition
}

function readLocal(): Record<string, AgentDefinition> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const out: Record<string, AgentDefinition> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v === 'object') out[k] = migrate(v as Record<string, unknown>)
        }
        return out
      }
    }
    return {}
  } catch {
    return {}
  }
}

function writeLocal(data: Record<string, AgentDefinition>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.error('[agentStore] failed to persist:', err)
  }
}

const localListeners = new Set<Listener>()

const localBackend = {
  list(): AgentDefinition[] {
    return Object.values(readLocal())
  },

  get(id: string): AgentDefinition | undefined {
    return readLocal()[id]
  },

  add(agent: Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>): AgentDefinition {
    const all = readLocal()
    const id = crypto.randomUUID()
    const ts = now()
    const def: AgentDefinition = { ...agent, id, createdAt: ts, updatedAt: ts }
    all[id] = def
    writeLocal(all)
    for (const l of localListeners) l()
    return def
  },

  update(id: string, patch: Partial<AgentDefinition>): void {
    const all = readLocal()
    const existing = all[id]
    if (!existing) return
    all[id] = { ...existing, ...patch, updatedAt: now() }
    writeLocal(all)
    for (const l of localListeners) l()
  },

  remove(id: string): void {
    const all = readLocal()
    if (!all[id]) return
    delete all[id]
    writeLocal(all)
    for (const l of localListeners) l()
  },

  subscribe(l: Listener): () => void {
    localListeners.add(l)
    return () => localListeners.delete(l)
  },
}

// ── Electron backend ─────────────────────────────────────────────────────

const electronBackend = (() => {
  if (!isElectron) return null
  const api = window.electronAPI!.agents as {
    list(): Promise<AgentDefinition[]>
    get(id: string): Promise<AgentDefinition | null>
    add(agent: Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>): Promise<AgentDefinition>
    update(id: string, patch: Partial<AgentDefinition>): Promise<void>
    remove(id: string): Promise<void>
    onChanged(handler: () => void): () => void
  }

  let cache: Record<string, AgentDefinition> = {}
  let hydrated = false
  let pendingHydrate: Promise<void> | null = null

  async function ensureHydrated(): Promise<void> {
    if (hydrated) return
    if (pendingHydrate) return pendingHydrate
    pendingHydrate = (async () => {
      let list = await api.list()
      if (list.length === 0) {
        const local = Object.values(readLocal())
        if (local.length > 0) {
          list = await Promise.all(local.map((agent) => api.add(agent)))
          localStorage.removeItem(STORAGE_KEY)
        }
      }
      cache = {}
      for (const agent of list) {
        cache[agent.id] = migrate(agent as unknown as Record<string, unknown>)
      }
      hydrated = true
    })()
    await pendingHydrate
    pendingHydrate = null
  }

  const listeners = new Set<Listener>()
  api.onChanged(() => {
    hydrated = false
    void ensureHydrated().then(() => {
      for (const l of listeners) l()
    })
  })

  return {
    async ensureHydrated(): Promise<void> {
      await ensureHydrated()
    },

    list(): AgentDefinition[] {
      return Object.values(cache)
    },

    get(id: string): AgentDefinition | undefined {
      return cache[id]
    },

    async add(agent: Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>): Promise<AgentDefinition> {
      return api.add(agent)
    },

    async update(id: string, patch: Partial<AgentDefinition>): Promise<void> {
      await api.update(id, patch)
    },

    async remove(id: string): Promise<void> {
      await api.remove(id)
    },

    subscribe(l: Listener): () => void {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
})()

// ── Unified store ────────────────────────────────────────────────────────

type Backend = NonNullable<typeof electronBackend>
const backend: Backend | typeof localBackend =
  isElectron && electronBackend ? electronBackend : localBackend

export const agentStore = {
  list(): AgentDefinition[] {
    return backend.list()
  },

  get(id: string): AgentDefinition | undefined {
    return backend.get(id)
  },

  async add(agent: Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>): Promise<AgentDefinition> {
    return backend.add(agent)
  },

  async update(id: string, patch: Partial<AgentDefinition>): Promise<void> {
    return backend.update(id, patch)
  },

  async remove(id: string): Promise<void> {
    return backend.remove(id)
  },

  subscribe(listener: Listener): () => void {
    return backend.subscribe(listener)
  },

  async hydrate(): Promise<void> {
    const eb = electronBackend
    if (eb) {
      await eb.ensureHydrated()
    }
  },

  isElectron,
}
