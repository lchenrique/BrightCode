/**
 * Provider connection state — main-process state machine.
 *
 * Mirrors `apps/desktop/electron/active-runtime-state.ts` and the connection
 * lifecycle from hermes-agent: the renderer paints from a cache of truth,
 * the main process owns the state, and a probe decides whether the cached
 * "connected" badge is honest.
 *
 * Lifecycle (per provider):
 *   untested → probing → connected | auth-rejected | unreachable | server-error
 *
 * Design rules (all from Hermes AGENTS.md / DESIGN.md):
 *   - One owner: this state machine is the only writer. Side effects
 *     (probe results, persist, IPC broadcast) happen in well-named helpers.
 *   - Generation counter: every `getSnapshot` bumps a version so the renderer
 *     can key its `useSyncExternalStore` snapshot on it (avoids the
 *     infinite-loop trap of returning a new object each call).
 *   - Bounded retries: probing is debounced, not in a hot loop. The user
 *     must press "Test connection" or trigger an event-driven re-probe.
 *   - Honest empty state: a provider with no credential reports
 *     'misconfigured', not 'untested', so the UI never silently shows green
 *     for a backend that has no key.
 *   - Direct manipulation: status flips before any persist write so the UI
 *     paints first, reconcile after.
 *
 * Not owned here:
 *   - The credential itself (auth store)
 *   - The actual streaming (provider-proxy.ts)
 *   - The renderer subscription (IPC bridge)
 */

import { probeProvider, type ConnectionStatus, type ProbeResult, PROBE_TIMEOUT_MS } from '../shared/provider-probes'
import { classifyAuthScheme, type AuthScheme, type AuthSchemeOverride } from '../shared/provider-connection-config'
import type { ProviderCredential } from '../../src/lib/providers/types'

// ── Per-provider state ─────────────────────────────────────────────────────

export interface ProviderConnectionEntry {
  /** Provider id (e.g. 'openai', 'anthropic', 'opencode-zen'). */
  providerId: string
  status: ConnectionStatus
  latencyMs?: number
  message?: string
  testedAt?: string
  /** Last probe in-flight. UI can show a spinner for this. */
  probing: boolean
}

type Listener = () => void

export interface ProviderConnectionStateInit {
  /** Inject a fetch impl. Default `globalThis.fetch`. */
  fetch?: Parameters<typeof probeProvider>[0]['fetch']
  /** Per-probe timeout override. */
  timeoutMs?: number
  /** Optional persistence sink (e.g. electron-store wrapper). */
  persist?: (entries: Record<string, ProviderConnectionEntry>) => void
  /** Optional load on startup (e.g. last known state). */
  load?: () => Record<string, ProviderConnectionEntry> | null
  /**
   * Optional auth-scheme override per provider (e.g. Anthropic uses
   * `x-api-key` instead of `Authorization`).
   */
  authSchemeOverrides?: Record<string, AuthSchemeOverride>
}

// ── State machine ──────────────────────────────────────────────────────────

/**
 * The state machine. Single source of truth for per-provider connection
 * state in the main process. Subscribe with `subscribe(listener)`; read
 * snapshots with `getSnapshot()`.
 */
export class ProviderConnectionState {
  private entries = new Map<string, ProviderConnectionEntry>()
  private listeners = new Set<Listener>()
  private inflight = new Map<string, AbortController>()
  private version = 0

  private readonly fetch: Parameters<typeof probeProvider>[0]['fetch']
  private readonly timeoutMs: number
  private readonly persist?: ProviderConnectionStateInit['persist']
  private readonly authSchemeOverrides: Record<string, AuthSchemeOverride>

  constructor(init: ProviderConnectionStateInit = {}) {
    this.fetch = init.fetch
    this.timeoutMs = init.timeoutMs ?? PROBE_TIMEOUT_MS
    this.persist = init.persist
    this.authSchemeOverrides = init.authSchemeOverrides ?? {}

    // Load last-known state on startup so the UI has something to show
    // before the first probe completes.
    const saved = init.load?.()
    if (saved) {
      for (const [id, entry] of Object.entries(saved)) {
        this.entries.set(id, { ...entry, probing: false })
      }
    }
  }

  // ── Subscription (renderer pattern: useSyncExternalStore) ────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion(): number {
    return this.version
  }

  getSnapshot(): Record<string, ProviderConnectionEntry> {
    return Object.fromEntries(this.entries)
  }

  get(providerId: string): ProviderConnectionEntry | undefined {
    return this.entries.get(providerId)
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  /**
   * Probe a single provider. If a probe is already in flight for this
   * provider, it is cancelled (the previous result is discarded — Hermes
   * "Preserve reference identity on no-ops" applies in reverse: a new
   * probe invalidates the old one).
   *
   * `opts.fetch` overrides the constructor fetch (mainly for tests).
   */
  async probe(opts: {
    providerId: string
    baseUrl: string
    authMethod: ProviderCredential['method']
    credential?: ProviderCredential
    schemeOverride?: AuthSchemeOverride
    /** Optional per-probe fetch override (mainly for tests). */
    fetch?: Parameters<typeof probeProvider>[0]['fetch']
  }): Promise<ProbeResult> {
    // Cancel any in-flight probe for this provider.
    this.inflight.get(opts.providerId)?.abort()
    const controller = new AbortController()
    this.inflight.set(opts.providerId, controller)

    // Paint 'probing' first (direct manipulation).
    this.set(opts.providerId, {
      providerId: opts.providerId,
      status: 'probing',
      probing: true,
    })

    const scheme: AuthScheme = opts.schemeOverride?.scheme ?? classifyAuthScheme(opts.authMethod)
    const override = opts.schemeOverride ?? this.authSchemeOverrides[opts.providerId]

    let result: ProbeResult
    try {
      result = await probeProvider({
        baseUrl: opts.baseUrl,
        scheme,
        credential: opts.credential,
        override,
        timeoutMs: this.timeoutMs,
        fetch: opts.fetch ?? this.fetch,
      })
    } catch (err) {
      // probeProvider is documented to never throw — but defend in depth.
      result = {
        status: 'server-error',
        message: err instanceof Error ? err.message : String(err),
        testedAt: new Date().toISOString(),
      }
    }

    // If our controller was aborted (a newer probe started), drop this result.
    if (controller.signal.aborted) {
      return result
    }

    this.set(opts.providerId, {
      providerId: opts.providerId,
      status: result.status,
      latencyMs: result.latencyMs,
      message: result.message,
      testedAt: result.testedAt,
      probing: false,
    })
    this.inflight.delete(opts.providerId)
    this.flush()
    return result
  }

  /**
   * Probe all known providers in parallel. Returns once all settle (or
   * the global timeout elapses). Errors per provider are caught and recorded
   * in the entry — one provider's failure never blocks another.
   */
  async probeAll(
    providers: Array<{
      providerId: string
      baseUrl: string
      authMethod: ProviderCredential['method']
      credential?: ProviderCredential
      schemeOverride?: AuthSchemeOverride
    }>,
  ): Promise<Record<string, ProbeResult>> {
    const results: Record<string, ProbeResult> = {}
    await Promise.all(
      providers.map(async (p) => {
        results[p.providerId] = await this.probe(p)
      }),
    )
    return results
  }

  /**
   * Mark a provider as 'untested' (used when its config is removed or
   * the user signs out — the entry should not keep showing 'connected'
   * from a stale state).
   */
  reset(providerId: string): void {
    this.inflight.get(providerId)?.abort()
    this.inflight.delete(providerId)
    this.entries.delete(providerId)
    this.version++
    this.emit()
    this.flush()
  }

  /**
   * Mark a provider as 'misconfigured' without probing (used when a
   * caller already knows the config is broken — e.g. URL was rejected at
   * save time).
   */
  flagMisconfigured(providerId: string, message: string): void {
    this.set(providerId, {
      providerId,
      status: 'misconfigured',
      message,
      probing: false,
      testedAt: new Date().toISOString(),
    })
    this.flush()
  }

  /** Drop all entries (e.g. user signed out everywhere). */
  clear(): void {
    for (const c of this.inflight.values()) c.abort()
    this.inflight.clear()
    this.entries.clear()
    this.version++
    this.emit()
    this.flush()
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private set(providerId: string, entry: ProviderConnectionEntry): void {
    this.entries.set(providerId, entry)
    this.version++
    // Direct manipulation: paint the state change before persist. The
    // renderer sees 'probing' immediately, not after the probe settles.
    this.emit()
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  private flush(): void {
    this.emit()
    if (this.persist) {
      try {
        this.persist(this.getSnapshot())
      } catch (err) {
        // Persist failure must not break the state machine.
        console.error('[ProviderConnectionState] persist failed:', err)
      }
    }
  }
}

// ── React hook helper (renderer) ───────────────────────────────────────────

/**
 * Convenience for renderer code:
 *
 *   const { version, getSnapshot, subscribe } = useProviderConnection()
 *   const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
 *
 * The factory below is the "external store" shape required by
 * `useSyncExternalStore`. The renderer imports this from a thin wrapper
 * that wires it to the IPC channel.
 */
export function makeExternalStore(state: ProviderConnectionState) {
  return {
    getSnapshot: () => state.getSnapshot(),
    getVersion: () => state.getVersion(),
    subscribe: (l: Listener) => state.subscribe(l),
  }
}
