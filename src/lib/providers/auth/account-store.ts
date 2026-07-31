import type { AuthMethod, CLISource, ProviderAccount } from '../types'

type Listener = () => void

type AccountsData = Record<string, Record<string, ProviderAccount>>

const isElectron =
  typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

const ACCOUNTS_KEY = 'brightcode.accounts.v2'
const OLD_CREDENTIALS_KEY = 'brightcode.auth.v1'

// ── Helpers ──────────────────────────────────────────────────────────

function now(): number {
  return Date.now()
}

interface OldCredShim {
  method: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  cliSource?: string
  cliEmail?: string
}

function fromOld(
  providerId: string,
  old: OldCredShim,
  id = 'default',
  label = 'Default',
): ProviderAccount {
  return {
    id,
    providerId,
    label,
    authMethod: old.method as AuthMethod,
    apiKey: old.apiKey,
    accessToken: old.accessToken,
    refreshToken: old.refreshToken,
    expiresAt: old.expiresAt,
    cliSource: old.cliSource as CLISource | undefined,
    cliEmail: old.cliEmail,
    enabled: true,
    lastUsedAt: now(),
    createdAt: now(),
  }
}

// ── Browser (localStorage) backend ───────────────────────────────────

function readLocal(): AccountsData {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    }
    const oldRaw = localStorage.getItem(OLD_CREDENTIALS_KEY)
    if (oldRaw) {
      const old = JSON.parse(oldRaw) as Record<string, OldCredShim>
      const migrated: AccountsData = {}
      for (const [pid, cred] of Object.entries(old)) {
        migrated[pid] = { default: fromOld(pid, cred) }
      }
      writeLocal(migrated)
      localStorage.removeItem(OLD_CREDENTIALS_KEY)
      return migrated
    }
    return {}
  } catch {
    return {}
  }
}

function writeLocal(data: AccountsData): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(data))
  } catch (err) {
    console.error('[accountStore] failed to persist:', err)
  }
}

function readActiveLocal(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem('brightcode.active-accounts.v2')
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeActiveLocal(data: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem('brightcode.active-accounts.v2', JSON.stringify(data))
  } catch (err) {
    console.error('[accountStore] failed to persist active:', err)
  }
}

const localListeners = new Set<Listener>()

const localBackend = {
  listAccounts(providerId: string): ProviderAccount[] {
    const all = readLocal()
    const accounts = all[providerId]
    return accounts ? Object.values(accounts) : []
  },

  getAccount(providerId: string, accountId: string): ProviderAccount | undefined {
    return readLocal()[providerId]?.[accountId]
  },

  addAccount(providerId: string, account: ProviderAccount): void {
    const all = readLocal()
    all[providerId] = all[providerId] ?? {}
    all[providerId][account.id] = account
    writeLocal(all)
    for (const l of localListeners) l()
  },

  updateAccount(providerId: string, accountId: string, patch: Partial<ProviderAccount>): void {
    const all = readLocal()
    const existing = all[providerId]?.[accountId]
    if (!existing) return
    all[providerId][accountId] = { ...existing, ...patch }
    writeLocal(all)
    for (const l of localListeners) l()
  },

  removeAccount(providerId: string, accountId: string): void {
    const all = readLocal()
    if (!all[providerId]) return
    delete all[providerId][accountId]
    if (Object.keys(all[providerId]).length === 0) {
      delete all[providerId]
    }
    writeLocal(all)
    for (const l of localListeners) l()
  },

  setActiveAccount(providerId: string, accountId: string): void {
    const active = readActiveLocal()
    active[providerId] = accountId
    writeActiveLocal(active)
    for (const l of localListeners) l()
  },

  getActiveAccountId(providerId: string): string | undefined {
    return readActiveLocal()[providerId]
  },

  readAll(): AccountsData {
    return readLocal()
  },

  subscribe(l: Listener): () => void {
    localListeners.add(l)
    return () => localListeners.delete(l)
  },
}

// ── Electron backend ─────────────────────────────────────────────────

const electronBackend = (() => {
  if (!isElectron) return null
  const api = window.electronAPI!.accounts as {
    list(providerId: string): Promise<ProviderAccount[]>
    listAll(): Promise<AccountsData>
    listActive(): Promise<Record<string, string>>
    get(providerId: string, accountId: string): Promise<ProviderAccount | null>
    add(providerId: string, account: ProviderAccount): Promise<void>
    update(providerId: string, accountId: string, patch: Partial<ProviderAccount>): Promise<void>
    remove(providerId: string, accountId: string): Promise<void>
    setActive(providerId: string, accountId: string): Promise<void>
    getActive(providerId: string): Promise<ProviderAccount | null>
    onChanged(handler: () => void): () => void
  }

  let cache: AccountsData = {}
  let activeCache: Record<string, string> = {}
  let hydrated = false
  let pendingHydrate: Promise<void> | null = null

  async function ensureHydrated(): Promise<void> {
    if (hydrated) return
    if (pendingHydrate) return pendingHydrate
    pendingHydrate = (async () => {
      cache = await api.listAll()
      activeCache = await api.listActive()
      if (Object.keys(cache).length === 0) {
        const local = readLocal()
        for (const [providerId, accounts] of Object.entries(local)) {
          for (const account of Object.values(accounts)) {
            await api.add(providerId, account)
          }
        }
        const localActive = readActiveLocal()
        for (const [providerId, accountId] of Object.entries(localActive)) {
          if (local[providerId]?.[accountId]) {
            await api.setActive(providerId, accountId)
          }
        }
        if (Object.keys(local).length > 0) {
          cache = await api.listAll()
          activeCache = await api.listActive()
          localStorage.removeItem(ACCOUNTS_KEY)
          localStorage.removeItem('brightcode.active-accounts.v2')
        }
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

    listAccounts(providerId: string): ProviderAccount[] {
      const accounts = cache[providerId]
      return accounts ? Object.values(accounts) : []
    },

    getAccount(providerId: string, accountId: string): ProviderAccount | undefined {
      return cache[providerId]?.[accountId]
    },

    async addAccount(providerId: string, account: ProviderAccount): Promise<void> {
      await api.add(providerId, account)
    },

    async updateAccount(
      providerId: string,
      accountId: string,
      patch: Partial<ProviderAccount>,
    ): Promise<void> {
      await api.update(providerId, accountId, patch)
    },

    async removeAccount(providerId: string, accountId: string): Promise<void> {
      await api.remove(providerId, accountId)
    },

    async setActiveAccount(providerId: string, accountId: string): Promise<void> {
      await api.setActive(providerId, accountId)
    },

    getActiveAccountId(providerId: string): string | undefined {
      return activeCache[providerId]
    },

    readAll(): AccountsData {
      return cache
    },

    subscribe(l: Listener): () => void {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
})()

// ── Unified store ─────────────────────────────────────────────────────

type Backend = NonNullable<typeof electronBackend>
const backend: Backend | typeof localBackend =
  isElectron && electronBackend ? electronBackend : localBackend

export const accountStore = {
  listAccounts(providerId: string): ProviderAccount[] {
    return backend.listAccounts(providerId)
  },

  getAccount(providerId: string, accountId: string): ProviderAccount | undefined {
    return backend.getAccount(providerId, accountId)
  },

  async addAccount(providerId: string, account: ProviderAccount): Promise<void> {
    await backend.addAccount(providerId, account)
  },

  async updateAccount(
    providerId: string,
    accountId: string,
    patch: Partial<ProviderAccount>,
  ): Promise<void> {
    await backend.updateAccount(providerId, accountId, patch)
  },

  async removeAccount(providerId: string, accountId: string): Promise<void> {
    await backend.removeAccount(providerId, accountId)
  },

  async setActiveAccount(providerId: string, accountId: string): Promise<void> {
    await backend.setActiveAccount(providerId, accountId)
  },

  getActiveAccount(providerId: string): ProviderAccount | undefined {
    const accountId = backend.getActiveAccountId(providerId)
    if (accountId) {
      const account = backend.getAccount(providerId, accountId)
      if (account) return account
    }
    const accounts = backend.listAccounts(providerId)
    return accounts.find((a) => a.id === 'default') ?? accounts[0]
  },

  readAll(): AccountsData {
    return backend.readAll()
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
