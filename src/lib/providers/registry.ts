/**
 * ProviderRegistry — the single source of truth for which providers
 * BrightCode knows about, and which credentials the user has configured.
 *
 * The UI talks to the registry, not to individual providers. When you want
 * to send a message, you call `registry.stream(providerId, modelId, params)`.
 * The registry resolves the provider, attaches the user's stored credential,
 * and yields the stream.
 */

import type {
  IAgentProvider,
  ModelInfo,
  ProviderAccount,
  ProviderCredential,
  StreamChunk,
  StreamParams,
} from './types'
import { accountStore } from './auth/account-store'
import { authStore } from './auth/store'
import { usageStore } from './usage/store'
import type { UsageRecord } from './usage/types'

export type RegistryListener = () => void

class ProviderRegistry {
  private providers = new Map<string, IAgentProvider>()
  private listeners = new Set<RegistryListener>()
  /**
   * Bumped on every mutation. UI hooks use this to key their snapshot
   * cache so they can return a stable reference across renders (required
   * by `useSyncExternalStore` — returning a new object each call causes
   * an infinite re-render loop).
   */
  private version = 0

  /** Returns a monotonically increasing version number. Bumped on every emit. */
  getVersion(): number {
    return this.version
  }

  // ── Provider registration ──────────────────────────────────────────────

  register(provider: IAgentProvider): void {
    if (this.providers.has(provider.id)) {
      console.warn(`[ProviderRegistry] overwriting provider "${provider.id}"`)
    }
    this.providers.set(provider.id, provider)
    this.emit()
  }

  registerAll(providers: IAgentProvider[]): void {
    for (const p of providers) this.providers.set(p.id, p)
    this.emit()
  }

  unregister(id: string): void {
    this.providers.delete(id)
    this.emit()
  }

  // ── Provider lookup ───────────────────────────────────────────────────

  get(id: string): IAgentProvider | undefined {
    return this.providers.get(id)
  }

  list(): IAgentProvider[] {
    return Array.from(this.providers.values())
  }

  /**
   * Resolve a model id to a concrete provider.
   *
   * Accepts either:
   *   - `'gpt-5'` (model id only) — searches all providers' `listModels()`
   *   - `'openai/gpt-5'` (provider/model) — picks provider directly
   */
  resolveForModel(modelId: string): { provider: IAgentProvider; model: string } | undefined {
    if (modelId.includes('/')) {
      const [providerId, model] = modelId.split('/', 2)
      const provider = this.providers.get(providerId)
      if (provider) return { provider, model }
    }
    for (const provider of this.providers.values()) {
      if (provider.listModels().some((m) => m.id === modelId)) {
        return { provider, model: modelId }
      }
    }
    return undefined
  }

  // ── Credentials (backward compat — delegates to AccountStore) ────────

  setCredential(providerId: string, credential: ProviderCredential): void {
    const existing = accountStore.getAccount(providerId, 'default')
    const account: ProviderAccount = {
      id: 'default',
      providerId,
      label: existing?.label ?? 'Default',
      email: credential.cliEmail,
      authMethod: credential.method,
      apiKey: credential.apiKey,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAt,
      cliSource: credential.cliSource,
      cliEmail: credential.cliEmail,
      metadata: credential.metadata,
      enabled: true,
      lastUsedAt: Date.now(),
      createdAt: existing?.createdAt ?? Date.now(),
    }
    void accountStore.addAccount(providerId, account)
    this.emit()
  }

  /**
   * Resolve the credential lookup id for a provider. When the provider
   * declares `credentialProviderId`, the registry reads/writes the
   * shared bucket under that id (used when two providers share one API
   * key, e.g. opencode-go and opencode-go-anthropic). Otherwise the
   * provider's own id is used.
   */
  private credIdFor(providerId: string): string {
    return this.providers.get(providerId)?.credentialProviderId ?? providerId
  }

  getCredential(providerId: string): ProviderCredential | undefined {
    const credId = this.credIdFor(providerId)
    const account = accountStore.getActiveAccount(credId)
    if (!account) return undefined
    return this.fromStored(account)
  }

  hasCredential(providerId: string): boolean {
    return accountStore.listAccounts(this.credIdFor(providerId)).length > 0
  }

  removeCredential(providerId: string): void {
    const credId = this.credIdFor(providerId)
    const accounts = accountStore.listAccounts(credId)
    for (const acc of accounts) {
      void accountStore.removeAccount(credId, acc.id)
    }
    this.emit()
  }

  // ── Multi-account ────────────────────────────────────────────────────

  listAccounts(providerId: string): ProviderAccount[] {
    return accountStore.listAccounts(this.credIdFor(providerId))
  }

  setActiveAccount(providerId: string, accountId: string): void {
    void accountStore.setActiveAccount(this.credIdFor(providerId), accountId)
    this.emit()
  }

  getActiveAccount(providerId: string): ProviderAccount | undefined {
    return accountStore.getActiveAccount(this.credIdFor(providerId))
  }

  // ── Models ────────────────────────────────────────────────────────────

  /**
   * Flat list of models the user can actually call. By default this means:
   *   - every model from providers that have a credential, AND
   *   - any model whose `requiresAuth === false` (e.g. OpenCode Zen free
   *     tier), even if its provider is unconfigured.
   *
   * Pass `includeUnauthenticated: true` to also surface paid models from
   * providers without credentials — useful for the Settings page where we
   * want to show what's available once the user adds a key.
   */
  listAllModels(opts?: { includeUnauthenticated?: boolean }): ModelInfo[] {
    const out: ModelInfo[] = []
    for (const provider of this.providers.values()) {
      const hasCred = this.hasCredential(provider.id)
      for (const m of provider.listModels()) {
        const requiresAuth = m.requiresAuth !== false // default true
        const callable = hasCred || !requiresAuth
        if (!callable && !opts?.includeUnauthenticated) continue
        out.push({ ...m, provider: provider.id })
      }
    }
    return out
  }

  /**
   * Same as `listAllModels` but grouped by provider id. Convenient for the
   * chat model picker, which renders a section per provider.
   */
  listAvailableModelsGrouped(opts?: { includeUnauthenticated?: boolean }): {
    provider: IAgentProvider
    hasCredential: boolean
    models: ModelInfo[]
  }[] {
    const out: { provider: IAgentProvider; hasCredential: boolean; models: ModelInfo[] }[] = []
    for (const provider of this.providers.values()) {
      const hasCred = this.hasCredential(provider.id)
      const models = provider.listModels().filter((m) => {
        const requiresAuth = m.requiresAuth !== false
        return hasCred || !requiresAuth || !!opts?.includeUnauthenticated
      })
      if (models.length === 0) continue
      out.push({
        provider,
        hasCredential: hasCred,
        models: models.map((m) => ({ ...m, provider: provider.id })),
      })
    }
    return out
  }

  // ── Streaming (the main entry point) ──────────────────────────────────

  /**
   * Stream a completion via a registered provider. Resolves the model,
   * attaches the credential (if needed), and yields uniform StreamChunks.
   *
   * Models with `requiresAuth: false` (e.g. OpenCode Zen free tier) skip
   * the credential lookup entirely — the request goes out without an
   * `Authorization` header.
   *
   * Optionally pass `accountId` to use a specific account's credential.
   * When omitted uses the active account (or "default").
   */
  async *stream(
    modelId: string,
    params: StreamParams,
    accountId?: string,
  ): AsyncIterable<StreamChunk> {
    const resolved = this.resolveForModel(modelId)
    if (!resolved) {
      yield {
        type: 'error',
        error: new Error(`No provider found for model "${modelId}". Add a provider in Settings.`),
      }
      return
    }
    const model = resolved.provider.listModels().find((m) => m.id === resolved.model)
    const requiresAuth = model?.requiresAuth !== false
    const credId = this.credIdFor(resolved.provider.id)

    let credential: ProviderCredential | undefined
    if (requiresAuth) {
      if (accountId) {
        const account = accountStore.getAccount(credId, accountId)
        credential = account ? this.fromStored(account) : undefined
      } else {
        credential = this.getCredential(resolved.provider.id)
      }
    }
    if (requiresAuth && !credential) {
      yield {
        type: 'error',
        error: new Error(
          `No credential for provider "${resolved.provider.id}". Add one in Settings.`,
        ),
      }
      return
    }

    let usageData: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined

    for await (const chunk of resolved.provider.stream({ ...params, model: resolved.model }, credential)) {
      if (chunk.type === 'message_end' && chunk.usage) {
        usageData = chunk.usage
      }
      yield chunk
    }

    if (usageData && credential) {
      const resolvedAccountId = accountId ?? accountStore.getActiveAccount(credId)?.id
      if (resolvedAccountId) {
        const record: UsageRecord = {
          id: crypto.randomUUID(),
          providerId: resolved.provider.id,
          accountId: resolvedAccountId,
          model: resolved.model,
          inputTokens: usageData.input,
          outputTokens: usageData.output,
          cacheRead: usageData.cacheRead,
          cacheWrite: usageData.cacheWrite,
          estimatedCost: usageStore.estimateCost(resolved.model, usageData.input, usageData.output),
          timestamp: Date.now(),
          source: usageData.input ? 'provider' : 'estimated',
        }
        void usageStore.record(record).catch(() => {})
      }
    }
  }

  // ── Subscription (for UI reactivity) ─────────────────────────────────

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Re-emit when the underlying auth store changes from outside this
   * registry (e.g. the main process broadcasts after a Settings write).
   * Wired automatically when the singleton is created.
   */
  private authUnsubscribe: (() => void) | null = null

  /** Start listening to authStore changes. Idempotent. */
  bindAuthStore(): void {
    if (this.authUnsubscribe) return
    this.authUnsubscribe = authStore.subscribe(() => this.emit())
  }

  /** Stop listening. Useful in tests. */
  unbindAuthStore(): void {
    this.authUnsubscribe?.()
    this.authUnsubscribe = null
  }

  private emit(): void {
    this.version++
    for (const l of this.listeners) l()
  }

  // ── Credential shape conversion ───────────────────────────────────────

  private fromStored(account: ProviderAccount): ProviderCredential {
    return {
      method: account.authMethod,
      apiKey: account.apiKey,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      cliSource: account.cliSource,
      cliEmail: account.cliEmail,
      metadata: account.metadata,
    }
  }
}

export const providerRegistry = new ProviderRegistry()

// Auto-bind to the auth store so the registry re-emits whenever a
// credential changes from outside (main process broadcast, another tab,
// etc). Safe to call before or after any `register()` — it's just a
// subscription, not a read.
providerRegistry.bindAuthStore()
