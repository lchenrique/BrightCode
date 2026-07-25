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
import { providerRegistry, type IAgentProvider } from '@/lib/providers'
import {
  useProviderStatus,
  useRegisteredProviders,
} from '@/hooks/use-provider-registry'
import { useAllCLIDetection } from '@/hooks/use-cli-detection'
import type { CLIDetection, DetectedProviderId } from '../../../electron/preload'
import { OAUTH_CONFIGS } from '@/lib/providers/auth/oauth-configs'
import { cn } from '@/lib/utils'

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

function ProviderCard({ provider }: { provider: IAgentProvider }) {
  const { hasCredential, callableModels } = useProviderStatus(provider.id)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'idle' | 'saving' | 'validating' | 'removing' | 'oauth'>('idle')
  const [feedback, setFeedback] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null)

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
          providerRegistry.setCredential(provider.id, {
            method: 'oauth',
            accessToken: res.accessToken,
            refreshToken: res.refreshToken,
            expiresAt: res.expiresAt,
          })
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
        {isApiKey && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <KeyRound className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  hasCredential ? '••••••••  (saved — type to replace)' : 'Paste your API key'
                }
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
              title={hasCredential ? 'Send a probe request' : 'Save a key first'}
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

        {/* OAuth button if supported */}
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

          {hasCredential && (
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
    hint: 'Detects credential in OS keyring (service: antigravity)',
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

  // Always show all 4 known CLIs; mark which were detected.
  const order: DetectedProviderId[] = ['openai', 'anthropic', 'gemini-cli', 'antigravity']
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
  const configuredCount = providers.filter((p) => p.hasCredential).length
  const callableModels = providerRegistry.listAllModels().length

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
        <SectionLabel>Providers</SectionLabel>
        <div className="flex flex-col gap-3">
          {providers.map(({ provider }) => (
            <ProviderCard key={provider.id} provider={provider} />
          ))}
        </div>
      </div>

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
