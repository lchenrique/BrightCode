export interface UsageRecord {
  id: string
  providerId: string
  accountId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead?: number
  cacheWrite?: number
  estimatedCost?: number
  timestamp: number
  source: 'provider' | 'cli' | '9router' | 'estimated'
}

export interface QuotaSnapshot {
  providerId: string
  accountId: string
  /** Provider-specific quota buckets, such as 5-hour/7-day or per-model limits. */
  windows?: QuotaWindow[]
  quotaRemaining?: number
  quotaLimit?: number
  quotaResetAt?: number
  rateLimitRemaining?: number
  rateLimitResetAt?: number
  /** Earned Codex reset credits reported by the ChatGPT account backend. */
  rateLimitResetCredits?: RateLimitResetCredits
  source: 'provider' | 'cli' | '9router' | 'unavailable'
  collectedAt: number
}

export interface RateLimitResetCredit {
  id?: string
  resetType?: string
  status?: string
  grantedAt?: number
  expiresAt?: number
  title?: string
  description?: string
}

export interface RateLimitResetCredits {
  availableCount: number
  credits?: RateLimitResetCredit[] | null
}

export interface QuotaWindow {
  id: string
  label: string
  model?: string
  used?: number
  limit?: number
  unit?: 'requests' | 'tokens' | 'credits'
  resetAt?: number
  status?: 'available' | 'limited' | 'exhausted' | 'unknown'
}

export interface UsageSummary {
  providerId: string
  accountId: string
  model: string
  totalInputTokens: number
  totalOutputTokens: number
  totalRequests: number
  totalCacheRead?: number
  totalCacheWrite?: number
  estimatedCost: number
  lastUsedAt: number
  quota?: QuotaSnapshot
}

export const USAGE_STORAGE_KEY = 'brightcode.usage.v1'
export const QUOTA_STORAGE_KEY = 'brightcode.quota.v1'
