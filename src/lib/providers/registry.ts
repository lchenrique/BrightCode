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
  ProviderCredential,
  StreamChunk,
  StreamParams,
} from './types'
import { authStore, type StoredCredential } from './auth/store'

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

  // ── Credentials ───────────────────────────────────────────────────────

  setCredential(providerId: string, credential: ProviderCredential): void {
    // Fire-and-forget: the in-memory cache is updated synchronously by
    // authStore, and the main process broadcasts an `auth:changed` event
    // that triggers a second `emit()` after persistence. Both leads to
    // a re-render, but the second one is a no-op because the snapshot
    // version is already up-to-date.
    void authStore.set(providerId, this.toStored(credential))
    this.emit()
  }

  getCredential(providerId: string): ProviderCredential | undefined {
    const stored = authStore.get(providerId)
    if (!stored) return undefined
    return this.fromStored(stored)
  }

  hasCredential(providerId: string): boolean {
    return authStore.has(providerId)
  }

  removeCredential(providerId: string): void {
    void authStore.remove(providerId)
    this.emit()
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
   */
  async *stream(modelId: string, params: StreamParams): AsyncIterable<StreamChunk> {
    const resolved = this.resolveForModel(modelId)
    if (!resolved) {
      yield {
        type: 'error',
        error: new Error(`No provider found for model "${modelId}". Add a provider in Settings.`),
      }
      return
    }
    // Look up the model in the provider's catalog to check if it requires auth
    const model = resolved.provider.listModels().find((m) => m.id === resolved.model)
    const requiresAuth = model?.requiresAuth !== false // default true

    const credential = requiresAuth ? this.getCredential(resolved.provider.id) : undefined
    if (requiresAuth && !credential) {
      yield {
        type: 'error',
        error: new Error(
          `No credential for provider "${resolved.provider.id}". Add one in Settings.`,
        ),
      }
      return
    }
    yield* resolved.provider.stream({ ...params, model: resolved.model }, credential)
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

  // ── Stored credential shape conversion ────────────────────────────────

  private toStored(c: ProviderCredential): StoredCredential {
    return {
      method: c.method,
      apiKey: c.apiKey,
      accessToken: c.accessToken,
      refreshToken: c.refreshToken,
      expiresAt: c.expiresAt,
      cliSource: c.cliSource,
      cliEmail: c.cliEmail,
    }
  }

  private fromStored(s: StoredCredential): ProviderCredential {
    return {
      method: s.method,
      apiKey: s.apiKey,
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      expiresAt: s.expiresAt,
      cliSource: s.cliSource,
      cliEmail: s.cliEmail,
    }
  }
}

export const providerRegistry = new ProviderRegistry()

// Auto-bind to the auth store so the registry re-emits whenever a
// credential changes from outside (main process broadcast, another tab,
// etc). Safe to call before or after any `register()` — it's just a
// subscription, not a read.
providerRegistry.bindAuthStore()
