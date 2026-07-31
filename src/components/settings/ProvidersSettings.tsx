/**
 * Settings → Connection → Providers
 *
 * Lists every provider BrightCode knows about (from the registry bootstrap)
 * and lets the user add / validate / remove their API key. The chat input
 * reads from the same registry via `useAvailableModels()` so configuring a
 * provider here immediately makes its models selectable in the chat.
 *
 * Phase 3.1 (CLI detection): providers with `authMethod === 'cli_detected'`
 * show a "Already signed in as …" card with a "Use this account" button
 * that adopts the token from a local CLI (Codex, Claude Code, Gemini CLI,
 * Antigravity) into our electron-store.
 */

import { useState } from 'react'
import {
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  Plug,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { providerRegistry, type IAgentProvider, type ProviderAccount } from '@/lib/providers'
import {
  useProviderStatus,
  useRegisteredProviders,
} from '@/hooks/use-provider-registry'
import { useAllCLIDetection } from '@/hooks/use-cli-detection'
import { useProviderAccounts } from '@/hooks/use-provider-accounts'
import type { CLIDetection, DetectedProviderId } from '@/lib/electron-api-types'
import { OAUTH_CONFIGS } from '@/lib/providers/auth/oauth-configs'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

// ── Section label matching the other Settings tabs ──────────────────────

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="text-muted-foreground/70 text-[11px] font-normal tracking-wide uppercase">
      {children}
    </span>
  )
}

// ── Status badge (configured / partial / unconfigured / free-only) ──────

type Status = 'configured' | 'free-only' | 'unconfigured'

function statusOf(hasCred: boolean, freeModelCount: number, totalCount: number): Status {
  if (hasCred) return 'configured'
  if (freeModelCount > 0 && freeModelCount < totalCount) return 'free-only'
  return 'unconfigured'
}

const STATUS_META: Record<
  Status,
  { label: string; dot: string; text: string; icon: typeof Check }
> = {
  configured: {
    label: 'Connected',
    dot: 'bg-emerald-500',
    text: 'text-emerald-500',
    icon: ShieldCheck,
  },
  'free-only': {
    label: 'Free tier available',
    dot: 'bg-sky-400',
    text: 'text-sky-400',
    icon: Sparkles,
  },
  unconfigured: {
    label: 'Not configured',
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    icon: CircleAlert,
  },
}

function StatusBadge({ status }: { status: Status }) {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', meta.text)}>
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      <Icon className="size-3" />
      {meta.label}
    </span>
  )
}

// ── Single provider card ────────────────────────────────────────────────

function authMethodLabel(method: IAgentProvider['authMethod']): string {
  switch (method) {
    case 'api_key':
      return 'API key'
    case 'oauth':
      return 'OAuth'
    case 'cli_detected':
      return 'Detected from CLI'
  }
}

function formatLastUsed(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ── Account row inside a provider card ────────────────────────────────

function AccountRow({
  account,
  isActive,
  onSetActive,
  onRemove,
  onRename,
}: {
  account: ProviderAccount
  isActive: boolean
  onSetActive: () => void
  onRemove: () => void
  onRename: (label: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(account.label)
  const [confirming, setConfirming] = useState(false)

  const handleSaveRename = () => {
    if (editValue.trim() && editValue.trim() !== account.label) {
      onRename(editValue.trim())
    }
    setEditing(false)
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2 py-1 text-[12px]">
        <span className="text-muted-foreground">
          Remove account <span className="text-foreground font-medium">&ldquo;{account.label}&rdquo;</span>?
        </span>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => {
            setConfirming(false)
            onRemove()
          }}
          className="h-7 px-2.5 text-[11px]"
        >
          Remove
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(false)}
          className="h-7 px-2.5 text-[11px]"
        >
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-lg px-3 py-2',
        isActive ? 'border-emerald-500/20 bg-emerald-500/5 border' : '',
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-full border-2',
            isActive ? 'border-emerald-500' : 'border-muted-foreground/30',
          )}
        >
          {isActive && <div className="size-2 rounded-full bg-emerald-500" />}
        </div>

        <div className="min-w-0">
          {editing ? (
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSaveRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveRename()
                if (e.key === 'Escape') {
                  setEditValue(account.label)
                  setEditing(false)
                }
              }}
              autoFocus
              className="h-6 text-[12px] py-0"
            />
          ) : (
            <button
              onClick={() => {
                setEditValue(account.label)
                setEditing(true)
              }}
              className="block cursor-pointer text-left"
            >
              <span className="text-[13px] font-medium">{account.label}</span>
            </button>
          )}
          <div className="text-muted-foreground truncate text-[11px]">
            {(account.email ?? account.cliEmail) && (
              <span>{account.email ?? account.cliEmail} · </span>
            )}
            <span className="text-muted-foreground/60 font-mono uppercase">
              {account.authMethod === 'api_key'
                ? 'API'
                : account.authMethod === 'oauth'
                  ? 'OAuth'
                  : 'CLI'}
            </span>
            {account.lastUsedAt && (
              <span> · used {formatLastUsed(account.lastUsedAt)}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isActive ? (
          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
            Active
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={onSetActive}
            className="h-6 px-2 text-[11px]"
          >
            Set active
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(true)}
          className="text-muted-foreground hover:text-destructive h-6 px-1.5"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  )
}

function ProviderCard({ provider }: { provider: IAgentProvider }) {
  const { hasCredential, callableModels } = useProviderStatus(provider.id)
  const { accounts, activeAccount, setActive, addAccount, removeAccount, updateAccount } =
    useProviderAccounts(provider.id)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'idle' | 'saving' | 'validating' | 'removing' | 'oauth'>('idle')
  const [feedback, setFeedback] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addLabel, setAddLabel] = useState('')
  const [addKey, setAddKey] = useState('')
  const [showAddKey, setShowAddKey] = useState(false)

  const totalModels = provider.listModels().length
  const freeModels = provider.listModels().filter((m) => m.free || m.requiresAuth === false)
  const status = statusOf(hasCredential, freeModels.length, totalModels)
  const isApiKey = provider.authMethod === 'api_key'
  const oauthConfig = OAUTH_CONFIGS[provider.id]

  const handleOAuth = async () => {
    if (!oauthConfig) return
    setBusy('oauth')
    setFeedback(null)
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.oauth) {
        const res = await window.electronAPI.oauth.start(oauthConfig)
        if (res.ok && res.accessToken) {
          const label = res.email ?? `${oauthConfig.name} OAuth`
          const existing = accounts.find(a => a.email === res.email)
          if (existing) {
              await updateAccount(existing.id, {
                accessToken: res.accessToken,
                refreshToken: res.refreshToken,
                expiresAt: res.expiresAt,
                metadata: res.accountId ? { accountId: res.accountId } : existing.metadata,
              })
          } else {
            await addAccount(label, {
              authMethod: 'oauth',
              accessToken: res.accessToken,
              refreshToken: res.refreshToken,
              expiresAt: res.expiresAt,
              email: res.email,
              metadata: res.accountId ? { accountId: res.accountId } : undefined,
            })
          }
          setFeedback({
            kind: 'success',
            message: `Connected via OAuth${res.email ? ` as ${res.email}` : ''}!`,
          })
        } else {
          setFeedback({ kind: 'error', message: res.error || 'OAuth authentication failed' })
        }
      } else {
        setFeedback({ kind: 'error', message: 'OAuth is supported in desktop mode' })
      }
    } catch (err) {
      setFeedback({ kind: 'error', message: errMsg(err) })
    } finally {
      setBusy('idle')
    }
  }

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setFeedback({ kind: 'error', message: 'Enter a key first.' })
      return
    }
    setBusy('saving')
    setFeedback(null)
    try {
      providerRegistry.setCredential(provider.id, { method: 'api_key', apiKey: apiKey.trim() })
      setApiKey('')
      setShowKey(false)
      setFeedback({ kind: 'success', message: 'Saved locally.' })
    } catch (err) {
      setFeedback({ kind: 'error', message: errMsg(err) })
    } finally {
      setBusy('idle')
    }
  }

  const handleValidate = async () => {
    if (!hasCredential) {
      setFeedback({ kind: 'error', message: 'Save a key first, then validate.' })
      return
    }
    setBusy('validating')
    setFeedback(null)
    try {
      const cred = providerRegistry.getCredential(provider.id)
      if (!cred) {
        setFeedback({ kind: 'error', message: 'No credential stored.' })
        return
      }
      const ok = await provider.validateCredential(cred)
      setFeedback(
        ok
          ? { kind: 'success', message: 'Key is valid.' }
          : { kind: 'error', message: 'Key was rejected. Check it and try again.' },
      )
    } catch (err) {
      setFeedback({ kind: 'error', message: errMsg(err) })
    } finally {
      setBusy('idle')
    }
  }

  const handleAddAccount = async () => {
    if (!addLabel.trim()) return
    setBusy('saving')
    setFeedback(null)
    try {
      const key = isApiKey ? addKey.trim() || undefined : undefined
      await addAccount(addLabel.trim(), key)
      setAddLabel('')
      setAddKey('')
      setShowAddForm(false)
      setFeedback({ kind: 'success', message: 'Account added.' })
    } catch (err) {
      setFeedback({ kind: 'error', message: errMsg(err) })
    } finally {
      setBusy('idle')
    }
  }

  const handleRemove = () => {
    setBusy('removing')
    try {
      providerRegistry.removeCredential(provider.id)
      setFeedback({ kind: 'success', message: 'Removed.' })
    } catch (err) {
      setFeedback({ kind: 'error', message: errMsg(err) })
    } finally {
      setBusy('idle')
    }
  }

  return (
    <div className="border-border/60 bg-card/40 rounded-xl border p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[14px] font-medium">{provider.name}</h3>
            <StatusBadge status={status} />
          </div>
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
            {provider.baseURL}
          </p>
          <p className="text-muted-foreground mt-1 text-[12px] leading-5">
            {authMethodLabel(provider.authMethod)} · {callableModels.length} of {totalModels} model
            {totalModels === 1 ? '' : 's'} callable now
            {freeModels.length > 0 && status !== 'configured' && (
              <>
                {' '}
                · {freeModels.length} free{' '}
                {freeModels.length === 1 ? 'model' : 'models'} works without a key
              </>
            )}
          </p>
        </div>
      </div>

      {/* Auth body */}
      <div className="mt-4 flex flex-col gap-3">
        {accounts.length === 0 && isApiKey && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <KeyRound className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your API key"
                autoComplete="off"
                spellCheck={false}
                className="pl-8 pr-9 font-mono text-[12px]"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSave()
                }}
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                aria-label={showKey ? 'Hide key' : 'Show key'}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded transition-colors"
              >
                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>

            <Button
              size="sm"
              onClick={handleSave}
              disabled={busy !== 'idle' || !apiKey.trim()}
              className="min-w-[68px]"
            >
              {busy === 'saving' ? <Loader2 className="size-3.5 animate-spin" /> : 'Save'}
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={handleValidate}
              disabled={busy !== 'idle' || !hasCredential}
            >
              {busy === 'validating' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <>
                  <PlugZap className="size-3.5" />
                  Validate
                </>
              )}
            </Button>
          </div>
        )}

        {oauthConfig && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleOAuth}
              disabled={busy !== 'idle'}
              className="w-full sm:w-auto"
            >
              {busy === 'oauth' ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Awaiting browser sign-in…
                </>
              ) : (
                <>
                  <Plug className="size-3.5" />
                  Sign in with {oauthConfig.name} OAuth
                </>
              )}
            </Button>
          </div>
        )}

        {/* Account list */}
        {accounts.length > 0 && (
          <div className="flex flex-col gap-1">
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                isActive={activeAccount?.id === account.id}
                onSetActive={() => setActive(account.id)}
                onRemove={() => removeAccount(account.id)}
                onRename={(label) => updateAccount(account.id, { label })}
              />
            ))}

            {/* Add account */}
            {showAddForm ? (
              <div className="border-border/40 mt-1 rounded-lg border p-3">
                <div className="flex flex-col gap-1.5">
                  <Input
                    value={addLabel}
                    onChange={(e) => setAddLabel(e.target.value)}
                    placeholder="e.g. Work, Personal"
                    className="h-8 text-[12px]"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleAddAccount()
                    }}
                  />
                  {isApiKey && (
                    <div className="relative">
                      <Input
                        type={showAddKey ? 'text' : 'password'}
                        value={addKey}
                        onChange={(e) => setAddKey(e.target.value)}
                        placeholder="API key"
                        className="h-8 pr-8 text-[12px] font-mono"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAddKey((s) => !s)}
                        aria-label={showAddKey ? 'Hide key' : 'Show key'}
                        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded transition-colors"
                      >
                        {showAddKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                      </button>
                    </div>
                  )}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleAddAccount}
                    disabled={!addLabel.trim() || busy !== 'idle'}
                  >
                    {busy === 'saving' ? <Loader2 className="size-3.5 animate-spin" /> : 'Save'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAddForm(true)}
                className="text-muted-foreground hover:text-foreground px-3 py-1.5 text-left text-[11px] transition-colors"
              >
                + Add account
              </button>
            )}
          </div>
        )}

        {/* Feedback row */}
        <div className="flex min-h-[18px] items-center justify-between gap-2 text-[12px]">
          <div className="min-w-0 flex-1 truncate">
            {feedback && (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5',
                  feedback.kind === 'success' ? 'text-emerald-500' : 'text-destructive',
                )}
              >
                {feedback.kind === 'success' ? (
                  <Check className="size-3" />
                ) : (
                  <X className="size-3" />
                )}
                {feedback.message}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {hasCredential && accounts.length === 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRemove}
                disabled={busy !== 'idle'}
                className="text-muted-foreground hover:text-destructive -my-1"
              >
                {busy === 'removing' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <>
                    <Trash2 className="size-3.5" />
                    Remove
                  </>
                )}
              </Button>
            )}

            {hasCredential && accounts.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleValidate}
                disabled={busy !== 'idle'}
                className="text-muted-foreground -my-1"
              >
                {busy === 'validating' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <>
                    <PlugZap className="size-3.5" />
                    Validate
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Top-level Settings panel ────────────────────────────────────────────

/** Maps a detected CLI to the BrightCode provider it should bind to. */
const CLI_PROVIDER_TARGET: Record<DetectedProviderId, { providerId: string; ready: boolean }> = {
  openai: { providerId: 'openai', ready: true },
  anthropic: { providerId: 'anthropic', ready: true },
  'gemini-cli': { providerId: 'gemini-cli', ready: true },
  antigravity: { providerId: 'antigravity', ready: true },
  'opencode-go': { providerId: 'opencode-go', ready: true },
  'opencode-zen': { providerId: 'opencode-zen', ready: true },
  minimax: { providerId: 'minimax', ready: true },
}

const CLI_DISPLAY: Record<
  DetectedProviderId,
  { label: string; hint: string }
> = {
  openai: {
    label: 'Codex CLI',
    hint: 'Detects ~/.codex/auth.json (or Windows Credential Manager)',
  },
  anthropic: {
    label: 'Claude Code',
    hint: 'Detects ~/.claude/.credentials.json (or macOS Keychain)',
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    hint: 'Detects ~/.gemini/oauth_creds.json',
  },
  antigravity: {
    label: 'Antigravity CLI',
    hint: 'Detects credential in OS keyring (Windows: gemini:antigravity)',
  },
  'opencode-go': {
    label: 'OpenCode Go',
    hint: 'Detects ~/.local/share/opencode/auth.json',
  },
  'opencode-zen': {
    label: 'OpenCode Zen',
    hint: 'Detects ~/.local/share/opencode/auth.json',
  },
  minimax: {
    label: 'MiniMax Coding Plan',
    hint: 'Detects ~/.local/share/opencode/auth.json',
  },
}

function DetectedCLISection() {
  const { detections, loading, refetch } = useAllCLIDetection()
  const [busy, setBusy] = useState<DetectedProviderId | null>(null)
  const [feedback, setFeedback] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const handleAdopt = (detection: CLIDetection) => {
    const target = CLI_PROVIDER_TARGET[detection.providerId]
    if (!target.ready) return
    setBusy(detection.providerId)
    setFeedback(null)
    try {
      providerRegistry.setCredential(target.providerId, {
        method: 'cli_detected',
        accessToken: detection.accessToken,
        refreshToken: detection.refreshToken,
        expiresAt: detection.expiresAt,
        cliSource: detection.source as 'codex-auth.json' | 'codex-keyring' | 'antigravity-keyring' | 'claude-credentials' | 'claude-keyring' | 'gemini-oauth-creds' | 'gemini-keyring',
        cliEmail: detection.accountLabel,
        metadata: detection.projectId || detection.accountId
          ? { ...(detection.projectId ? { projectId: detection.projectId } : {}), ...(detection.accountId ? { accountId: detection.accountId } : {}) }
          : undefined,
      })
      setFeedback({
        kind: 'success',
        message: `Adopted ${detection.accountLabel ?? 'local session'} for ${target.providerId}.`,
      })
    } catch (err) {
      setFeedback({ kind: 'error', message: errMsg(err) })
    } finally {
      setBusy(null)
    }
  }

  const handleRescan = () => {
    setRefreshKey((k) => k + 1)
    refetch()
  }

  const order: DetectedProviderId[] = [
    'openai',
    'anthropic',
    'gemini-cli',
    'antigravity',
    'opencode-go',
    'opencode-zen',
    'minimax',
  ]
  const byProvider = new Map(detections.map((d) => [d.providerId, d]))
  const detectedCount = detections.length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionLabel>Detected local CLIs</SectionLabel>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleRescan}
          className="text-muted-foreground hover:text-foreground -my-1 -mr-1"
        >
          <RefreshCw className="size-3.5" />
          Re-scan
        </Button>
      </div>

      <p className="text-muted-foreground text-[12px] leading-5">
        BrightCode can reuse credentials already on this machine. Click{" "}
        <span className="text-foreground/90 font-medium">Use</span> to adopt a session into the
        matching provider.
      </p>

      <div className="flex flex-col gap-2">
        {order.map((id) => {
          const detection = byProvider.get(id) ?? null
          const display = CLI_DISPLAY[id]
          const target = CLI_PROVIDER_TARGET[id]
          return (
            <div
              key={id}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5',
                detection
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-border/50 bg-card/30',
              )}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {loading && !detection ? (
                  <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
                ) : detection ? (
                  <UserCheck className="size-4 shrink-0 text-emerald-500" />
                ) : (
                  <CircleAlert className="text-muted-foreground size-4 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-foreground text-[13px] font-medium">
                    {display.label}
                  </div>
                  <div className="text-muted-foreground truncate text-[11.5px]">
                    {detection
                      ? `Signed in as ${detection.accountLabel ?? 'unknown user'} · ${detection.source}`
                      : display.hint}
                  </div>
                </div>
              </div>
              {detection &&
                (target.ready ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleAdopt(detection)}
                    disabled={busy === id}
                    className="shrink-0"
                  >
                    {busy === id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <>
                        <UserCheck className="size-3.5" />
                        Use for {target.providerId}
                      </>
                    )}
                  </Button>
                ) : (
                  <span className="text-muted-foreground shrink-0 text-[11px]">
                    Provider coming in 3.2
                  </span>
                ))}
            </div>
          )
        })}
      </div>

      {feedback && (
        <div className="text-[12px]">
          <span
            className={cn(
              'inline-flex items-center gap-1.5',
              feedback.kind === 'success' ? 'text-emerald-500' : 'text-destructive',
            )}
          >
            {feedback.kind === 'success' ? (
              <Check className="size-3" />
            ) : (
              <X className="size-3" />
            )}
            {feedback.message}
          </span>
        </div>
      )}

      {!loading && detectedCount === 0 && (
        <p className="text-muted-foreground/80 text-[11.5px]">
          No local CLI sessions found. Sign in via your CLI (e.g.{" "}
          <code className="font-mono">codex login</code>) and re-scan.
        </p>
      )}

      {/* refreshKey referenced to silence the unused-var lint while
          keeping the prop available for future imperative re-fetches. */}
      <span className="hidden" data-refresh-key={refreshKey} />
    </div>
  )
}

export function ProvidersSettings() {
  const providers = useRegisteredProviders()
  const [addOpen, setAddOpen] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const configuredCount = providers.filter((p) => p.hasCredential).length
  const callableModels = providerRegistry.listAllModels().length
  const connectedProviders = providers.filter((p) => p.hasCredential)
  const selectedProvider = providers.find((p) => p.provider.id === selectedProviderId)?.provider

  const openAdd = () => {
    setSelectedProviderId(null)
    setAddOpen(true)
  }

  const closeAdd = (open: boolean) => {
    setAddOpen(open)
    if (!open) setSelectedProviderId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Intro */}
      <div className="flex flex-col gap-1">
        <p className="text-foreground text-[13px] font-medium">LLM providers</p>
        <p className="text-muted-foreground text-[12.5px] leading-5">
          Add a provider to make its models available in the chat. Keys are stored locally in
          this browser only. Free models work without a key.
        </p>
        <p className="text-muted-foreground/80 mt-1 text-[12px]">
          {configuredCount} of {providers.length} configured · {callableModels} model
          {callableModels === 1 ? '' : 's'} selectable in the chat
        </p>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <SectionLabel>Connected providers</SectionLabel>
          <Button size="sm" onClick={openAdd} className="h-8">
            <Plus className="size-3.5" />
            Add provider
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          {connectedProviders.map(({ provider }) => (
            <ProviderCard key={provider.id} provider={provider} />
          ))}
          {connectedProviders.length === 0 && (
            <div className="border-border/50 bg-card/20 rounded-xl border border-dashed px-4 py-8 text-center">
              <p className="text-foreground text-[13px] font-medium">No providers connected</p>
              <p className="text-muted-foreground mt-1 text-[12px]">
                Add an API key or sign in with OAuth to make models available in chat.
              </p>
              <Button size="sm" variant="outline" onClick={openAdd} className="mt-4">
                <Plus className="size-3.5" />
                Connect a provider
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={addOpen} onOpenChange={closeAdd}>
        <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle>{selectedProvider ? `Connect ${selectedProvider.name}` : 'Add a provider'}</DialogTitle>
              <DialogDescription className="mt-1">
                {selectedProvider
                  ? 'Credentials stay on this device and can be managed as separate accounts.'
                  : 'Choose a provider to configure an API key or OAuth connection.'}
              </DialogDescription>
            </div>
            <DialogCloseButton />
          </div>

          {selectedProvider ? (
            <div className="mt-5">
              <button
                type="button"
                onClick={() => setSelectedProviderId(null)}
                className="text-muted-foreground hover:text-foreground mb-3 text-[12px]"
              >
                ← Back to providers
              </button>
              <ProviderCard provider={selectedProvider} />
            </div>
          ) : (
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {providers.map(({ provider, hasCredential }) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => setSelectedProviderId(provider.id)}
                  className="border-border/60 bg-card/40 hover:border-primary/50 hover:bg-accent/40 rounded-lg border p-3 text-left transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium">{provider.name}</span>
                    {hasCredential && <Check className="size-3.5 text-emerald-500" />}
                  </div>
                  <span className="text-muted-foreground mt-1 block text-[11px]">
                    {authMethodLabel(provider.authMethod)} · {provider.listModels().length} models
                  </span>
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Separator />

      <DetectedCLISection />
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
