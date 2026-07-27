import type { UsageRecord, UsageSummary, QuotaSnapshot } from './types'
import { USAGE_STORAGE_KEY, QUOTA_STORAGE_KEY } from './types'
import { estimateCost } from './cost'

type Listener = () => void
type RecordsData = Record<string, Record<string, UsageRecord[]>>
type QuotaData = Record<string, Record<string, QuotaSnapshot>>

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

const isElectron =
  typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

// ── Browser (localStorage) backend ───────────────────────────────────

function readRecordsLocal(): RecordsData {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeRecordsLocal(data: RecordsData): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.error('[usageStore] failed to persist:', err)
  }
}

function readQuotaLocal(): QuotaData {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(QUOTA_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeQuotaLocal(data: QuotaData): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(QUOTA_STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.error('[usageStore] failed to persist quota:', err)
  }
}

const localListeners = new Set<Listener>()

const localBackend = {
  async ensureHydrated(): Promise<void> {
    // localStorage is read synchronously by the browser backend.
  },

  async record(record: UsageRecord): Promise<void> {
    const all = readRecordsLocal()
    const prov = all[record.providerId] ??= {}
    const list = prov[record.accountId] ??= []
    list.push(record)
    const cutoff = Date.now() - THIRTY_DAYS_MS
    all[record.providerId][record.accountId] = list.filter((r) => r.timestamp >= cutoff)
    writeRecordsLocal(all)
    for (const l of localListeners) l()
  },

  getHistory(providerId: string, accountId?: string, since?: number): UsageRecord[] {
    const all = readRecordsLocal()
    const prov = all[providerId]
    if (!prov) return []
    const cutoff = since ?? 0
    if (accountId) {
      const list = prov[accountId]
      return list ? list.filter((r) => r.timestamp >= cutoff) : []
    }
    const out: UsageRecord[] = []
    for (const list of Object.values(prov)) {
      for (const r of list) {
        if (r.timestamp >= cutoff) out.push(r)
      }
    }
    out.sort((a, b) => b.timestamp - a.timestamp)
    return out
  },

  getSummaries(): UsageSummary[] {
    const all = readRecordsLocal()
    const quotaData = readQuotaLocal()
    const summaryMap = new Map<string, UsageSummary>()

    for (const [providerId, prov] of Object.entries(all)) {
      for (const [accountId, records] of Object.entries(prov)) {
        const grouped = new Map<string, UsageRecord[]>()
        for (const r of records) {
          const key = `${providerId}::${accountId}::${r.model}`
          const g = grouped.get(key) ?? []
          g.push(r)
          grouped.set(key, g)
        }
        for (const [key, group] of grouped) {
          const model = group[0].model
          let totalInput = 0, totalOutput = 0, totalCost = 0, totalCacheRead = 0, totalCacheWrite = 0, lastUsed = 0
          for (const r of group) {
            totalInput += r.inputTokens
            totalOutput += r.outputTokens
            totalCost += r.estimatedCost ?? 0
            if (r.cacheRead) totalCacheRead += r.cacheRead
            if (r.cacheWrite) totalCacheWrite += r.cacheWrite
            if (r.timestamp > lastUsed) lastUsed = r.timestamp
          }
          const quota = quotaData[providerId]?.[accountId]
          summaryMap.set(key, {
            providerId,
            accountId,
            model,
            totalInputTokens: totalInput,
            totalOutputTokens: totalOutput,
            totalRequests: group.length,
            totalCacheRead: totalCacheRead || undefined,
            totalCacheWrite: totalCacheWrite || undefined,
            estimatedCost: Math.round(totalCost * 1_000_000) / 1_000_000,
            lastUsedAt: lastUsed,
            quota,
          })
        }
      }
    }
    return Array.from(summaryMap.values())
  },

  getAccountSummary(providerId: string, accountId: string): UsageSummary | undefined {
    return localBackend.getSummaries().find(
      (s) => s.providerId === providerId && s.accountId === accountId,
    )
  },

  async setQuota(providerId: string, accountId: string, quota: QuotaSnapshot): Promise<void> {
    const all = readQuotaLocal()
    all[providerId] ??= {}
    all[providerId][accountId] = quota
    writeQuotaLocal(all)
    for (const l of localListeners) l()
  },

  getQuota(providerId: string, accountId: string): QuotaSnapshot | undefined {
    return readQuotaLocal()[providerId]?.[accountId]
  },

  getAllQuotas(): QuotaData {
    return readQuotaLocal()
  },

  async clear(): Promise<void> {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.removeItem(USAGE_STORAGE_KEY)
      localStorage.removeItem(QUOTA_STORAGE_KEY)
    } catch (err) {
      console.error('[usageStore] clear failed:', err)
    }
    for (const l of localListeners) l()
  },

  subscribe(l: Listener): () => void {
    localListeners.add(l)
    return () => localListeners.delete(l)
  },
}

// ── Electron backend ─────────────────────────────────────────────────

const electronBackend = (() => {
  if (!isElectron) return null
  const api = window.electronAPI!.usage as {
    record(record: UsageRecord): Promise<void>
    getHistory(providerId: string, accountId?: string, since?: number): Promise<UsageRecord[]>
    getAllHistory(): Promise<RecordsData>
    getSummaries(): Promise<UsageSummary[]>
    setQuota(providerId: string, accountId: string, quota: QuotaSnapshot): Promise<void>
    getQuota(providerId: string, accountId: string): Promise<QuotaSnapshot | undefined>
    getAllQuotas(): Promise<QuotaData>
    clear(): Promise<void>
    onChanged(handler: () => void): () => void
  }

  let recordsCache: RecordsData = {}
  let quotaCache: QuotaData = {}
  let hydrated = false
  let pendingHydrate: Promise<void> | null = null

  async function ensureHydrated(): Promise<void> {
    if (hydrated) return
    if (pendingHydrate) return pendingHydrate
    pendingHydrate = (async () => {
      recordsCache = (await api.getAllHistory()) ?? {}
      quotaCache = (await api.getAllQuotas()) ?? {}
      hydrated = true
    })()
    await pendingHydrate
    pendingHydrate = null
  }

  const ebListeners = new Set<Listener>()
  api.onChanged(() => {
    hydrated = false
    void ensureHydrated().then(() => {
      for (const l of ebListeners) l()
    })
  })

  return {
    async ensureHydrated(): Promise<void> {
      await ensureHydrated()
    },

    async record(record: UsageRecord): Promise<void> {
      await api.record(record)
      const prov = recordsCache[record.providerId] ??= {}
      const list = prov[record.accountId] ??= []
      list.push(record)
      const cutoff = Date.now() - THIRTY_DAYS_MS
      prov[record.accountId] = list.filter((r) => r.timestamp >= cutoff)
    },

    getHistory(providerId: string, accountId?: string, since?: number): UsageRecord[] {
      const prov = recordsCache[providerId]
      if (!prov) return []
      const cutoff = since ?? 0
      if (accountId) {
        const list = prov[accountId]
        return list ? list.filter((r) => r.timestamp >= cutoff) : []
      }
      const out: UsageRecord[] = []
      for (const list of Object.values(prov)) {
        for (const r of list) {
          if (r.timestamp >= cutoff) out.push(r)
        }
      }
      out.sort((a, b) => b.timestamp - a.timestamp)
      return out
    },

    getSummaries(): UsageSummary[] {
      const summaryMap = new Map<string, UsageSummary>()
      for (const [providerId, prov] of Object.entries(recordsCache)) {
        for (const [accountId, records] of Object.entries(prov)) {
          const grouped = new Map<string, UsageRecord[]>()
          for (const r of records) {
            const key = `${providerId}::${accountId}::${r.model}`
            const g = grouped.get(key) ?? []
            g.push(r)
            grouped.set(key, g)
          }
          for (const [key, group] of grouped) {
            const model = group[0].model
            let totalInput = 0, totalOutput = 0, totalCost = 0, totalCacheRead = 0, totalCacheWrite = 0, lastUsed = 0
            for (const r of group) {
              totalInput += r.inputTokens
              totalOutput += r.outputTokens
              totalCost += r.estimatedCost ?? 0
              if (r.cacheRead) totalCacheRead += r.cacheRead
              if (r.cacheWrite) totalCacheWrite += r.cacheWrite
              if (r.timestamp > lastUsed) lastUsed = r.timestamp
            }
            const quota = quotaCache[providerId]?.[accountId]
            summaryMap.set(key, {
              providerId,
              accountId,
              model,
              totalInputTokens: totalInput,
              totalOutputTokens: totalOutput,
              totalRequests: group.length,
              totalCacheRead: totalCacheRead || undefined,
              totalCacheWrite: totalCacheWrite || undefined,
              estimatedCost: Math.round(totalCost * 1_000_000) / 1_000_000,
              lastUsedAt: lastUsed,
              quota,
            })
          }
        }
      }
      return Array.from(summaryMap.values())
    },

    getAccountSummary(providerId: string, accountId: string): UsageSummary | undefined {
      return this.getSummaries().find(
        (s) => s.providerId === providerId && s.accountId === accountId,
      )
    },

    async setQuota(providerId: string, accountId: string, quota: QuotaSnapshot): Promise<void> {
      await api.setQuota(providerId, accountId, quota)
      quotaCache[providerId] ??= {}
      quotaCache[providerId][accountId] = quota
    },

    getQuota(providerId: string, accountId: string): QuotaSnapshot | undefined {
      return quotaCache[providerId]?.[accountId]
    },

    getAllQuotas(): QuotaData {
      return quotaCache
    },

    async clear(): Promise<void> {
      await api.clear()
      recordsCache = {}
      quotaCache = {}
    },

    subscribe(l: Listener): () => void {
      ebListeners.add(l)
      return () => ebListeners.delete(l)
    },
  }
})()

// ── Unified store ────────────────────────────────────────────────────

type Backend = NonNullable<typeof electronBackend>
const backend: Backend | typeof localBackend =
  isElectron && electronBackend ? electronBackend : localBackend

export const usageStore = {
  async record(record: UsageRecord): Promise<void> {
    await backend.record(record)
  },

  getHistory(providerId: string, accountId?: string, since?: number): UsageRecord[] {
    return backend.getHistory(providerId, accountId, since)
  },

  getSummaries(): UsageSummary[] {
    return backend.getSummaries()
  },

  getAccountSummary(providerId: string, accountId: string): UsageSummary | undefined {
    return backend.getAccountSummary(providerId, accountId)
  },

  async setQuota(providerId: string, accountId: string, quota: QuotaSnapshot): Promise<void> {
    await backend.setQuota(providerId, accountId, quota)
  },

  getQuota(providerId: string, accountId: string): QuotaSnapshot | undefined {
    return backend.getQuota(providerId, accountId)
  },

  getAllQuotas(): Record<string, Record<string, QuotaSnapshot>> {
    return backend.getAllQuotas()
  },

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    return estimateCost(model, inputTokens, outputTokens)
  },

  async clear(): Promise<void> {
    await backend.clear()
  },

  subscribe(listener: Listener): () => void {
    return backend.subscribe(listener)
  },

  async hydrate(): Promise<void> {
    await backend.ensureHydrated()
  },

  isElectron,
}
