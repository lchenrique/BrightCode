import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Clock3,
  RefreshCw,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { providerRegistry } from '@/lib/providers'
import { accountStore } from '@/lib/providers/auth/account-store'
import type { AuthMethod } from '@/lib/providers/types'
import {
  refreshQuotaForProvider,
  quotaFetchers,
  type QuotaSnapshot,
  type QuotaWindow,
  type UsageSummary,
  usageStore,
} from '@/lib/providers/usage'
import { cn } from '@/lib/utils'

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function formatCost(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(value)
}

function formatDate(value: number | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(value)
}

function formatReset(value: number | undefined): string {
  if (!value) return 'reset unavailable'
  const diff = value - Date.now()
  if (diff <= 0) return 'resetting now'
  const hours = Math.floor(diff / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  if (hours > 24) return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `in ${hours}h ${minutes}m`
  return `in ${Math.max(1, minutes)}m`
}

function quotaPercent(window: QuotaWindow): number | undefined {
  if (!window.limit || window.limit <= 0 || window.used === undefined) return undefined
  return Math.max(0, Math.min(100, (window.used / window.limit) * 100))
}

function sourceLabel(source: QuotaSnapshot['source']): string {
  if (source === '9router') return '9Router'
  if (source === 'provider') return 'Provider'
  if (source === 'cli') return 'CLI'
  return 'Unavailable'
}

function QuotaBar({ window }: { window: QuotaWindow }) {
  const percent = quotaPercent(window)
  const status = window.status ?? (percent !== undefined && percent >= 100 ? 'exhausted' : 'available')
  const color =
    status === 'exhausted' || (percent !== undefined && percent >= 90)
      ? 'bg-red-500'
      : percent !== undefined && percent >= 70
        ? 'bg-amber-400'
        : 'bg-emerald-500'

  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="text-foreground/85 min-w-0 truncate">{window.label}</span>
        <span className="text-muted-foreground shrink-0">
          {window.used !== undefined && window.limit !== undefined
            ? `${formatNumber(window.used)} / ${formatNumber(window.limit)}`
            : 'No limit data'}
        </span>
      </div>
      <div className="bg-secondary/70 h-1.5 overflow-hidden rounded-full">
        {percent !== undefined && (
          <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${percent}%` }} />
        )}
      </div>
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-[10px]">
        <span>{percent !== undefined ? `${Math.round(percent)}% used` : 'Usage unavailable'}</span>
        <span>{formatReset(window.resetAt)}</span>
      </div>
    </div>
  )
}

function QuotaPanel({ quota, unavailableReason }: { quota?: QuotaSnapshot; unavailableReason?: string }) {
  if (!quota) {
    return (
      <div className="border-border/50 bg-background/30 text-muted-foreground flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px]">
        <TriangleAlert className="size-3.5 shrink-0" />
        {unavailableReason ?? 'Quota is not available for this account yet.'}
      </div>
    )
  }

  const windows = quota.windows ?? []
  const fallbackWindow =
    windows.length === 0 && quota.quotaLimit !== undefined
      ? [{
          id: 'default',
          label: 'Provider quota',
          used: Math.max(0, quota.quotaLimit - (quota.quotaRemaining ?? 0)),
          limit: quota.quotaLimit,
          resetAt: quota.quotaResetAt,
        } satisfies QuotaWindow]
      : []

  return (
    <div className="border-border/50 bg-background/30 rounded-lg border px-3 py-2">
      <div className="text-muted-foreground mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide">
        <span>Quota</span>
        <span>{sourceLabel(quota.source)} · {formatDate(quota.collectedAt)}</span>
      </div>
      {quota.rateLimitResetCredits && (
        <div className="border-border/40 bg-emerald-500/5 mb-2 rounded-md border px-2.5 py-2">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-foreground/85 inline-flex items-center gap-1.5">
              <RotateCcw className="size-3.5 text-emerald-500" />
              Earned resets
            </span>
            <span className="font-medium text-emerald-500">
              {quota.rateLimitResetCredits.availableCount} available
            </span>
          </div>
          {quota.rateLimitResetCredits.credits?.map((credit) => (
            <div key={credit.id ?? credit.title ?? credit.expiresAt} className="text-muted-foreground mt-1 text-[10px]">
              {credit.title ?? credit.description ?? 'Rate-limit reset'}
              {credit.expiresAt ? ` · expires ${formatDate(credit.expiresAt)}` : ''}
            </div>
          ))}
        </div>
      )}
      {windows.length > 0 || fallbackWindow.length > 0 ? (
        <div className="divide-border/40 divide-y">
          {[...windows, ...fallbackWindow].map((window) => (
            <QuotaBar key={window.id} window={window} />
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground py-1 text-[11px]">Quota limits were not returned.</div>
      )}
    </div>
  )
}

interface AccountUsageGroup {
  providerId: string
  accountId: string
  providerName: string
  accountLabel: string
  summaries: UsageSummary[]
  quota?: QuotaSnapshot
  authMethod?: AuthMethod
}

function UsageAccountCard({ group }: { group: AccountUsageGroup }) {
  const totals = group.summaries.reduce(
    (acc, summary) => ({
      input: acc.input + summary.totalInputTokens,
      output: acc.output + summary.totalOutputTokens,
      requests: acc.requests + summary.totalRequests,
      cost: acc.cost + summary.estimatedCost,
    }),
    { input: 0, output: 0, requests: 0, cost: 0 },
  )

  return (
    <div className="border-border/60 bg-card/30 flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-foreground truncate text-[13px] font-semibold">{group.providerName}</div>
          <div className="text-muted-foreground truncate text-[11px]">{group.accountLabel}</div>
        </div>
        <span className="text-muted-foreground shrink-0 rounded-full bg-secondary/60 px-2 py-0.5 text-[10px]">
          {totals.requests} requests
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="bg-background/40 rounded-md px-2 py-1.5">
          <div className="text-muted-foreground">Input</div>
          <div className="font-medium">{formatNumber(totals.input)}</div>
        </div>
        <div className="bg-background/40 rounded-md px-2 py-1.5">
          <div className="text-muted-foreground">Output</div>
          <div className="font-medium">{formatNumber(totals.output)}</div>
        </div>
        <div className="bg-background/40 rounded-md px-2 py-1.5">
          <div className="text-muted-foreground">Est. cost</div>
          <div className="font-medium">{formatCost(totals.cost)}</div>
        </div>
      </div>

      <QuotaPanel
        quota={group.quota}
        unavailableReason={group.authMethod === 'api_key'
          ? 'Official quota is available only for OAuth accounts; API keys expose usage after requests.'
          : undefined}
      />

      <div className="border-border/40 divide-border/40 divide-y border-t pt-1">
        {group.summaries.map((summary) => (
          <div key={`${summary.model}-${summary.lastUsedAt}`} className="flex items-center justify-between gap-3 py-1.5 text-[11px]">
            <span className="text-muted-foreground min-w-0 truncate">{summary.model}</span>
            <span className="text-muted-foreground shrink-0">{formatNumber(summary.totalRequests)} calls</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function UsageSettings() {
  const [summaries, setSummaries] = useState<UsageSummary[]>([])
  const [quotas, setQuotas] = useState<Record<string, Record<string, QuotaSnapshot>>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const refreshQuotas = useCallback(async () => {
    const providerIds = new Set([
      ...providerRegistry.list().map((provider) => provider.id),
      ...quotaFetchers.map((fetcher) => fetcher.providerId),
    ])
    await Promise.all(Array.from(providerIds).map((providerId) => refreshQuotaForProvider(providerId)))
    setQuotas(usageStore.getAllQuotas())
  }, [])

  const load = useCallback(async () => {
    await accountStore.hydrate()
    await usageStore.hydrate()
    setSummaries(usageStore.getSummaries())
    setQuotas(usageStore.getAllQuotas())
    setLoading(false)
  }, [])

  useEffect(() => {
    void load().then(() => refreshQuotas())
    return usageStore.subscribe(() => {
      setSummaries(usageStore.getSummaries())
      setQuotas(usageStore.getAllQuotas())
    })
  }, [load, refreshQuotas])

  const groups = useMemo<AccountUsageGroup[]>(() => {
    const map = new Map<string, AccountUsageGroup>()
    const providerNames = new Map(providerRegistry.list().map((provider) => [provider.id, provider.name]))

    for (const summary of summaries) {
      const key = `${summary.providerId}::${summary.accountId}`
      const account = accountStore.getAccount(summary.providerId, summary.accountId)
      const group = map.get(key) ?? {
        providerId: summary.providerId,
        accountId: summary.accountId,
        providerName: providerNames.get(summary.providerId) ?? summary.providerId,
        accountLabel: account?.label ?? account?.email ?? summary.accountId,
        summaries: [],
        quota: quotas[summary.providerId]?.[summary.accountId] ?? summary.quota,
        authMethod: account?.authMethod,
      }
      group.summaries.push(summary)
      map.set(key, group)
    }

    for (const [providerId, providerQuotas] of Object.entries(quotas)) {
      for (const [accountId, quota] of Object.entries(providerQuotas)) {
        const key = `${providerId}::${accountId}`
        if (map.has(key)) continue
        const account = accountStore.getAccount(providerId, accountId)
        map.set(key, {
          providerId,
          accountId,
          providerName: providerNames.get(providerId) ?? providerId,
          accountLabel: account?.label ?? account?.email ?? accountId,
        summaries: [],
        quota,
        authMethod: account?.authMethod,
      })
      }
    }

    const providerIds = new Set([
      ...providerRegistry.list().map((provider) => provider.id),
      ...quotaFetchers.map((fetcher) => fetcher.providerId),
    ])
    for (const providerId of providerIds) {
      for (const account of accountStore.listAccounts(providerId)) {
        const key = `${providerId}::${account.id}`
        if (map.has(key)) continue
        map.set(key, {
          providerId,
          accountId: account.id,
          providerName: providerNames.get(providerId) ?? providerId,
          accountLabel: account.label ?? account.email ?? account.cliEmail ?? account.id,
          summaries: [],
          quota: quotas[providerId]?.[account.id],
          authMethod: account.authMethod,
        })
      }
    }

    return Array.from(map.values()).sort((a, b) => a.providerName.localeCompare(b.providerName))
  }, [quotas, summaries])

  const totals = useMemo(
    () => groups.reduce(
      (acc, group) => group.summaries.reduce(
        (inner, summary) => ({
          requests: inner.requests + summary.totalRequests,
          input: inner.input + summary.totalInputTokens,
          output: inner.output + summary.totalOutputTokens,
          cost: inner.cost + summary.estimatedCost,
        }),
        acc,
      ),
      { requests: 0, input: 0, output: 0, cost: 0 },
    ),
    [groups],
  )

  const refresh = async () => {
    setRefreshing(true)
    try {
      await refreshQuotas()
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  const clear = async () => {
    if (!window.confirm('Clear all local usage history and quota snapshots?')) return
    await usageStore.clear()
    await load()
  }

  if (loading) {
    return <div className="text-muted-foreground py-10 text-center text-[13px]">Loading usage…</div>
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionLabel>Usage overview</SectionLabel>
          <p className="text-muted-foreground mt-1 text-[12px]">
            Consumption is measured from provider responses. Quota is shown only when an adapter reports it.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={clear} disabled={refreshing} className="text-muted-foreground hover:text-destructive">
            <Trash2 className="size-3.5" />
            Clear
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Requests', value: formatNumber(totals.requests), icon: Activity },
          { label: 'Input tokens', value: formatNumber(totals.input), icon: Zap },
          { label: 'Output tokens', value: formatNumber(totals.output), icon: CheckCircle2 },
          { label: 'Estimated cost', value: formatCost(totals.cost), icon: Clock3 },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="border-border/50 bg-background/30 rounded-lg border p-3">
            <Icon className="text-muted-foreground mb-2 size-3.5" />
            <div className="text-foreground text-[15px] font-semibold">{value}</div>
            <div className="text-muted-foreground text-[10px]">{label}</div>
          </div>
        ))}
      </div>

      {groups.length === 0 ? (
        <div className="border-border/50 bg-background/20 flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
          <Activity className="text-muted-foreground size-5" />
          <p className="text-foreground text-[13px] font-medium">No usage recorded yet</p>
          <p className="text-muted-foreground max-w-sm text-[11px]">
            Send a message with a provider that reports usage and its account will appear here.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {groups.map((group) => <UsageAccountCard key={`${group.providerId}::${group.accountId}`} group={group} />)}
        </div>
      )}

      <div className="border-border/50 bg-background/20 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <Clock3 className="size-3.5" />
          Local history is retained for 30 days.
        </div>
        <span className="text-muted-foreground text-[11px]">
          Quotas are fetched inside BrightCode from supported provider accounts.
        </span>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <span className="text-muted-foreground/70 text-[11px] font-normal tracking-wide uppercase">{children}</span>
}
