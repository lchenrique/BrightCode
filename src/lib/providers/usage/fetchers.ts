import type { ProviderAccount } from '../types'
import { accountStore } from '../auth/account-store'
import { usageStore } from './store'
import type {
  QuotaSnapshot,
  QuotaWindow,
  RateLimitResetCredit,
  RateLimitResetCredits,
} from './types'

const FETCH_TIMEOUT_MS = 10_000
const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const GEMINI_LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const ANTIGRAVITY_MODELS_URL = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
const MINIMAX_URLS: Record<string, string[]> = {
  minimax: [
    'https://www.minimax.io/v1/token_plan/remains',
    'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  ],
  'minimax-cn': [
    'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  ],
}
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

export interface QuotaFetcher {
  providerId: string
  fetchQuota(account: ProviderAccount): Promise<QuotaSnapshot | null>
}

function projectId(account: ProviderAccount): string | undefined {
  const value = account.metadata?.projectId
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function resetAt(value: unknown): number | undefined {
  if (!value) return undefined
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).getTime()
  if (typeof value === 'string') {
    const parsed = /^\d+$/.test(value)
      ? Number(value) < 1e12 ? Number(value) * 1000 : Number(value)
      : Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function responseWindow(
  id: string,
  label: string,
  remainingFraction: number,
  reset: unknown,
  model?: string,
): QuotaWindow {
  const remaining = Math.max(0, Math.min(1, Number(remainingFraction) || 0))
  const limit = 1000
  return {
    id,
    label,
    model,
    used: Math.round(limit * (1 - remaining)),
    limit,
    unit: 'requests',
    resetAt: resetAt(reset),
    status: remaining <= 0 ? 'exhausted' : remaining < 0.1 ? 'limited' : 'available',
  }
}

async function jsonFetch(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: unknown } | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    // In Electron, route through the main process to avoid CORS (MiniMax's
    // server rejects the browser preflight on the `x-api-key` header).
    if (typeof window !== 'undefined' && window.electronAPI?.usage?.fetchQuota) {
      const headers: Record<string, string> = {}
      if (init.headers) {
        new Headers(init.headers).forEach((value, key) => { headers[key] = value })
      }
      return await window.electronAPI.usage.fetchQuota(url, {
        method: init.method,
        headers,
        body: typeof init.body === 'string' ? init.body : undefined,
      })
    }
    // Browser fallback
    const response = await fetch(url, { ...init, signal: controller.signal })
    const data = await response.json().catch(() => null)
    return { ok: response.ok, status: response.status, data }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function geminiQuota(account: ProviderAccount, antigravity = false): Promise<QuotaSnapshot | null> {
  if (!account.accessToken) return null
  let pid = projectId(account)

  if (!pid && !antigravity) {
    const loaded = await jsonFetch(GEMINI_LOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { ideType: 9, platform: 5, pluginType: 2 } }),
    })
    const value = (loaded?.data as { cloudaicompanionProject?: unknown } | null)?.cloudaicompanionProject
    if (typeof value === 'string') pid = value
    else if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') pid = (value as { id: string }).id
  }

  const endpoint = antigravity ? ANTIGRAVITY_MODELS_URL : GEMINI_QUOTA_URL
  const result = await jsonFetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json',
      ...(antigravity ? { 'User-Agent': 'antigravity/ide/2.1.1 darwin/arm64', 'X-Client-Name': 'antigravity', 'X-Client-Version': '2.1.1' } : {}),
    },
    body: JSON.stringify(pid ? { project: pid } : {}),
  })
  if (!result?.ok || !result.data || typeof result.data !== 'object') return null

  const data = result.data as { buckets?: unknown[]; models?: Record<string, unknown> }
  const windows: QuotaWindow[] = []
  if (Array.isArray(data.buckets)) {
    for (const bucket of data.buckets) {
      if (!bucket || typeof bucket !== 'object') continue
      const item = bucket as Record<string, unknown>
      if (typeof item.modelId !== 'string' || item.remainingFraction === undefined) continue
      windows.push(responseWindow(item.modelId, item.modelId, Number(item.remainingFraction), item.resetTime, item.modelId))
    }
  }
  if (data.models && typeof data.models === 'object') {
    for (const [model, value] of Object.entries(data.models)) {
      const info = value && typeof value === 'object' ? value as Record<string, unknown> : null
      const quota = info?.quotaInfo && typeof info.quotaInfo === 'object' ? info.quotaInfo as Record<string, unknown> : null
      if (!quota || quota.remainingFraction === undefined) continue
      windows.push(responseWindow(model, String(info?.displayName ?? model), Number(quota.remainingFraction), quota.resetTime, model))
    }
  }
  if (windows.length === 0) return null
  return {
    providerId: account.providerId,
    accountId: account.id,
    windows,
    source: account.authMethod === 'cli_detected' ? 'cli' : 'provider',
    collectedAt: Date.now(),
  }
}

function formatMinimaxName(raw: string): string {
  if (raw === 'MiniMax-M*' || raw === 'general') return 'M-series'
  return raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function minimaxWindow(
  model: Record<string, unknown>,
  label: string,
  totalSnake: string,
  totalCamel: string,
  usageSnake: string,
  usageCamel: string,
  percentSnake: string,
  percentCamel: string,
  remainsSnake: string,
  remainsCamel: string,
  endSnake: string,
  endCamel: string,
  countMeansRemaining: boolean,
): QuotaWindow | null {
  let total = Math.max(0, Number(model[totalSnake] ?? model[totalCamel] ?? 0))
  const rawUsage = Number(model[usageSnake] ?? model[usageCamel] ?? 0)
  const pct = Number(model[percentSnake] ?? model[percentCamel])
  const hasPct = Number.isFinite(pct)

  if (total <= 0 && !hasPct) return null
  if (total <= 0) total = 100

  let used: number
  if (hasPct) {
    used = total - Math.round(total * (pct / 100))
  } else if (countMeansRemaining) {
    used = Math.max(0, total - rawUsage)
  } else {
    used = Math.min(total, Math.max(0, rawUsage))
  }

  const remains = Number(model[remainsSnake] ?? model[remainsCamel] ?? 0)
  const resetVal =
    remains > 0 ? Date.now() + remains
    : model[endSnake] ?? model[endCamel] ?? undefined

  const remaining = Math.max(0, total - used)
  const fraction = total > 0 ? remaining / total : 0

  return {
    id: label,
    label,
    used,
    limit: total,
    unit: 'requests',
    resetAt: resetAt(resetVal),
    status: fraction <= 0 ? 'exhausted' : fraction < 0.1 ? 'limited' : 'available',
  }
}

const AUTH_PATTERN = /token plan|coding plan|invalid api key|invalid key|unauthorized|inactive/i

async function minimaxQuota(account: ProviderAccount): Promise<QuotaSnapshot | null> {
  const token = account.apiKey || account.accessToken
  if (!token) return null

  const urls = MINIMAX_URLS[account.providerId] ?? []
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    if (!url) continue
    const canFallback = i < urls.length - 1

    const result = await jsonFetch(url, {
      method: 'GET',
      headers: { 'x-api-key': token, Accept: 'application/json' },
    })

    if (!result) {
      if (canFallback) continue
      return null
    }

    // Check base_resp for API-level errors
    if (result.data && typeof result.data === 'object') {
      const data = result.data as Record<string, unknown>
      const baseResp = (data['base_resp'] ?? data['baseResp']) as Record<string, unknown> | undefined
      if (baseResp) {
        const apiStatus = Number(baseResp['status_code'] ?? baseResp['statusCode'] ?? 0)
        if (apiStatus === 1004) return null
        if (apiStatus !== 0) {
          if (canFallback) continue
          return null
        }
      }

      if (AUTH_PATTERN.test(JSON.stringify(data))) {
        if (canFallback) continue
        return null
      }
    }

    // Handle HTTP errors with fallback
    if (!result.ok) {
      if ((result.status === 404 || result.status === 405 || result.status >= 500) && canFallback) continue
      return null
    }

    if (!result.data || typeof result.data !== 'object') {
      if (canFallback) continue
      return null
    }

    const payload = result.data as Record<string, unknown>
    const modelRemains = payload['model_remains'] ?? payload['modelRemains']
    const allModels = Array.isArray(modelRemains) ? modelRemains : []

    if (allModels.length === 0 && AUTH_PATTERN.test(JSON.stringify(payload))) {
      if (canFallback) continue
      return null
    }

    const countMeansRemaining = url.includes('/coding_plan/remains')
    const windows: QuotaWindow[] = []

    for (const entry of allModels) {
      if (!entry || typeof entry !== 'object') continue
      const model = entry as Record<string, unknown>
      const rawName = String(model['model_name'] ?? model['modelName'] ?? 'MiniMax')
      const name = formatMinimaxName(rawName)

      const session = minimaxWindow(
        model, `${name} (5h)`,
        'current_interval_total_count', 'currentIntervalTotalCount',
        'current_interval_usage_count', 'currentIntervalUsageCount',
        'current_interval_remaining_percent', 'currentIntervalRemainingPercent',
        'remains_time', 'remainsTime',
        'end_time', 'endTime',
        countMeansRemaining,
      )
      if (session) windows.push(session)

      const weekly = minimaxWindow(
        model, `${name} (7d)`,
        'current_weekly_total_count', 'currentWeeklyTotalCount',
        'current_weekly_usage_count', 'currentWeeklyUsageCount',
        'current_weekly_remaining_percent', 'currentWeeklyRemainingPercent',
        'weekly_remains_time', 'weeklyRemainsTime',
        'weekly_end_time', 'weeklyEndTime',
        countMeansRemaining,
      )
      if (weekly) windows.push(weekly)
    }

    if (windows.length > 0) {
      return {
        providerId: account.providerId,
        accountId: account.id,
        windows,
        source: 'provider',
        collectedAt: Date.now(),
      }
    }
  }

  return null
}

function codexWindow(
  id: string,
  label: string,
  value: unknown,
  unit: QuotaWindow['unit'] = 'requests',
): QuotaWindow | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const usedPercent = Number(item.used_percent ?? item.usedPercent)
  if (!Number.isFinite(usedPercent)) return null
  const used = Math.max(0, Math.min(100, usedPercent))
  return {
    id,
    label,
    used,
    limit: 100,
    unit,
    resetAt: resetAt(item.reset_at ?? item.resets_at ?? item.resetAt),
    status: used >= 100 ? 'exhausted' : used >= 90 ? 'limited' : 'available',
  }
}

function codexResetCredits(value: unknown): RateLimitResetCredits | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const count = Number(item.availableCount ?? item.available_count)
  if (!Number.isFinite(count)) return undefined

  const rawCredits = item.credits
  const credits = Array.isArray(rawCredits)
    ? rawCredits.flatMap((entry): RateLimitResetCredit[] => {
        if (!entry || typeof entry !== 'object') return []
        const credit = entry as Record<string, unknown>
        return [{
          id: typeof credit.id === 'string' ? credit.id : undefined,
          resetType: typeof credit.resetType === 'string' ? credit.resetType : typeof credit.reset_type === 'string' ? credit.reset_type : undefined,
          status: typeof credit.status === 'string' ? credit.status : undefined,
          grantedAt: resetAt(credit.grantedAt ?? credit.granted_at),
          expiresAt: resetAt(credit.expiresAt ?? credit.expires_at),
          title: typeof credit.title === 'string' ? credit.title : undefined,
          description: typeof credit.description === 'string' ? credit.description : undefined,
        }]
      })
    : rawCredits === null
      ? null
      : undefined

  return { availableCount: Math.max(0, Math.floor(count)), credits }
}

async function codexQuota(account: ProviderAccount): Promise<QuotaSnapshot | null> {
  if (!account.accessToken || account.apiKey) return null
  const result = typeof window !== 'undefined' && window.electronAPI?.usage.fetchCodex
    ? await window.electronAPI.usage.fetchCodex(
        account.accessToken,
        typeof account.metadata?.accountId === 'string' ? account.metadata.accountId : undefined,
      )
    : await jsonFetch(CODEX_USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          Accept: 'application/json',
          originator: 'codex_cli_rs',
          'OpenAI-Beta': 'codex-1',
          ...(typeof account.metadata?.accountId === 'string'
            ? { 'ChatGPT-Account-Id': account.metadata.accountId }
            : {}),
        },
      })
  const localResult = typeof window !== 'undefined' && window.electronAPI?.usage.readCodexLocal
    ? await window.electronAPI.usage.readCodexLocal()
    : null
  const payload = result?.data && typeof result.data === 'object'
    ? result.data as Record<string, unknown>
    : {}
  const localPayload = localResult?.data && typeof localResult.data === 'object'
    ? localResult.data as Record<string, unknown>
    : {}
  const rateLimitValue =
    payload.rate_limit ??
    payload.rate_limits ??
    payload.rateLimits ??
    localPayload.rate_limits ??
    localPayload.rateLimits
  const rateLimit = rateLimitValue && typeof rateLimitValue === 'object'
    ? rateLimitValue as Record<string, unknown>
    : null
  const windows = [
    codexWindow('primary', 'Primary window', rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? rateLimit?.primary),
    codexWindow('secondary', 'Secondary window', rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? rateLimit?.secondary),
  ].filter((item): item is QuotaWindow => item !== null)

  const resetCredits = codexResetCredits(
    payload.rateLimitResetCredits ??
      payload.rate_limit_reset_credits ??
      rateLimit?.rateLimitResetCredits ??
      rateLimit?.rate_limit_reset_credits,
  )

  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : Array.isArray(payload.additionalRateLimits) ? payload.additionalRateLimits : []
  for (const entry of additional) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const details = item.rate_limit ?? item.rateLimit
    const name = String(item.limit_name ?? item.limitName ?? item.metered_feature ?? item.meteredFeature ?? 'Additional limit')
    const window = details && typeof details === 'object' ? details as Record<string, unknown> : null
    if (!window) continue
    windows.push(...[
      codexWindow(`${name}-primary`, `${name} · primary`, window.primary_window ?? window.primaryWindow),
      codexWindow(`${name}-secondary`, `${name} · secondary`, window.secondary_window ?? window.secondaryWindow),
    ].filter((item): item is QuotaWindow => item !== null))
  }

  if (windows.length === 0 && !resetCredits) return null
  return {
    providerId: account.providerId,
    accountId: account.id,
    windows,
    rateLimitResetCredits: resetCredits,
    source: 'cli',
    collectedAt: Date.now(),
  }
}

export const quotaFetchers: QuotaFetcher[] = [
  { providerId: 'openai', fetchQuota: codexQuota },
  { providerId: 'gemini-cli', fetchQuota: (account) => geminiQuota(account) },
  { providerId: 'antigravity', fetchQuota: (account) => geminiQuota(account, true) },
  { providerId: 'minimax', fetchQuota: minimaxQuota },
  { providerId: 'minimax-cn', fetchQuota: minimaxQuota },
]

export async function refreshQuotaForProvider(providerId: string): Promise<void> {
  const relevant = quotaFetchers.filter((fetcher) => fetcher.providerId === providerId)
  if (relevant.length === 0) return
  for (const account of accountStore.listAccounts(providerId)) {
    for (const fetcher of relevant) {
      const quota = await fetcher.fetchQuota(account)
      if (quota) await usageStore.setQuota(providerId, account.id, quota)
    }
  }
}
