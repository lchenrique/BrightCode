/**
 * Core types for the multi-provider abstraction.
 *
 * Every provider in BrightCode (OpenAI, Anthropic, OpenCode Zen/Go, PayPerQ,
 * MiniMax, Antigravity, …) implements `IAgentProvider`. The ChatInput only
 * ever sees `StreamChunk` and `ModelInfo` — it never touches provider-native
 * schemas. This is the single contract that keeps BrightCode open to any
 * new LLM endpoint without rewriting UI code.
 */

// ─── Auth ──────────────────────────────────────────────────────────────────

export type AuthMethod = 'api_key' | 'oauth' | 'cli_detected'

export type CLISource =
  | 'codex-auth.json'
  | 'codex-keyring'
  | 'claude-credentials'
  | 'claude-keyring'
  | 'gemini-oauth-creds'
  | 'gemini-keyring'
  | 'gcloud-adc'
  | 'antigravity-keyring'
  | 'antigravity-auth.json'

/** @deprecated Use ProviderAccount instead. */
export interface ProviderCredential {
  /** How the credential was obtained — controls how the registry uses it. */
  method: AuthMethod

  // ── API key auth ──
  /** Raw key sent as `Authorization: Bearer <apiKey>` or `x-api-key: <apiKey>`. */
  apiKey?: string

  // ── OAuth / CLI detected (both share token shape) ──
  accessToken?: string
  refreshToken?: string
  /** Epoch ms when the accessToken expires; registry triggers refresh past this. */
  expiresAt?: number

  // ── CLI detection metadata (only for method = 'cli_detected') ──
  cliSource?: CLISource
  /** Email/account associated with the detected CLI login — for display. */
  cliEmail?: string
  /** Provider-specific non-secret values (for example a Cloud Code project id). */
  metadata?: Record<string, unknown>
}

// ─── Multi-account ─────────────────────────────────────────────────────────

export interface ProviderAccount {
  id: string
  providerId: string
  label: string
  email?: string
  authMethod: AuthMethod
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  cliSource?: CLISource
  cliEmail?: string
  /** Provider-specific non-secret values (never use this for tokens). */
  metadata?: Record<string, unknown>
  enabled: boolean
  lastUsedAt?: number
  createdAt: number
}

export interface ProviderState {
  providerId: string
  activeAccountId?: string
  strategy: 'manual' | 'failover' | 'round_robin'
}

export interface SessionProvider {
  providerId: string
  accountId?: string
  modelId: string
}

// ─── Models ────────────────────────────────────────────────────────────────

export interface ModelInfo {
  /** Provider-agnostic id within the provider (e.g. 'gpt-5', 'claude-sonnet-4-5'). */
  id: string
  /** Human label shown in the picker chip. */
  displayName: string
  /** Provider id (must match a registered IAgentProvider.id). */
  provider: string
  /** Optional context window in tokens. */
  contextWindow?: number
  supportsTools?: boolean
  supportsThinking?: boolean
  /**
   * Reasoning levels accepted by this concrete model. Gateways often expose
   * models with different subsets (for example DeepSeek V4 accepts high/max,
   * while Gemini Flash accepts minimal/low/medium/high).
   */
  thinkingLevels?: ThinkingLevel[]
  supportsImages?: boolean
  /** USD per 1M input tokens — shown in the picker if available. */
  inputCost?: number
  /** USD per 1M output tokens. */
  outputCost?: number
  /** Free-tier model (no key needed or no per-token cost). */
  free?: boolean
  /**
   * If true (default), the registry requires a credential before streaming.
   * If false, the model is callable without any auth — the request goes
   * out without an `Authorization` header. Used for OpenCode Zen's free
   * tier (`minimax-m2.5-free`, `big-pickle`, etc.) where the endpoint
   * accepts unauthenticated requests.
   */
  requiresAuth?: boolean
}

// ─── Stream chunks (uniform across providers) ─────────────────────────────

export type StreamChunk =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'tool_use_start'
      id: string
      name: string
      providerItem?: Record<string, unknown>
    }
  | {
      type: 'tool_use_delta'
      id: string
      input: unknown
      name?: string
      providerItem?: Record<string, unknown>
    }
  | { type: 'tool_use_end'; id: string }
  | {
      type: 'provider_output_item'
      provider: 'openai-responses'
      item: Record<string, unknown>
    }
  | {
      type: 'message_end'
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'error'
      usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
      model: string
    }
  | { type: 'error'; error: Error }

// ─── Chat messages (uniform across providers) ─────────────────────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: unknown
      providerItem?: Record<string, unknown>
    }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'thinking'; text: string; signature?: string }

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatMessageRole
  content: string | ContentBlock[]
  /** Required when role === 'tool'. */
  toolCallId?: string
  toolName?: string
  /**
   * Provider-native response items that must be replayed on stateless
   * continuations (for example encrypted Responses API reasoning items).
   */
  providerOutputItems?: Array<Record<string, unknown>>
  /**
   * Interleaved reasoning returned by OpenAI-compatible APIs. DeepSeek
   * requires this value to be replayed on every subsequent tool round.
   */
  reasoningContent?: string
}

// ─── Stream parameters ────────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max'

export interface StreamParams {
  /** Either 'gpt-5' (resolved via registry) or 'openai/gpt-5' (explicit). */
  model: string
  messages: ChatMessage[]
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  /** Aborts the in-flight stream. */
  signal?: AbortSignal
  /** Forwarded to providers that support reasoning controls. */
  thinking?: ThinkingLevel
  /** Stable per-conversation id; used as prompt cache key when supported. */
  sessionId?: string
  /**
   * Tools the model may call. Each handler maps this to its native shape
   * (OpenAI `tools`, Anthropic `tools`, Gemini `functionDeclarations`).
   * Tools that need a sandbox (file ops, bash) are executed in the main
   * process; pass only their JSON Schema here.
   */
  tools?: ToolDefinition[]
  /** Force the model to call a specific tool by name. Defaults to 'auto'. */
  toolChoice?: 'auto' | 'none' | { name: string }
}

/**
 * Provider-agnostic tool definition. Each format handler converts to its
 * native shape. `parameters` follows a JSON Schema-like subset that all
 * three providers (OpenAI, Anthropic, Gemini) understand.
 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameterSchema>
    required?: string[]
  }
}

export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object'
  description?: string
  enum?: Array<string | number>
  items?: ToolParameterSchema
  default?: unknown
}

// ─── API format identifiers ───────────────────────────────────────────────

export type ApiFormat =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-native'
  | 'custom'

// ─── The provider contract ────────────────────────────────────────────────

export interface IAgentProvider {
  /** Unique id used by the registry, e.g. 'openai', 'anthropic', 'opencode-zen'. */
  readonly id: string
  /** Human label, e.g. 'OpenAI', 'Anthropic', 'OpenCode Zen'. */
  readonly name: string
  /** Base URL (no trailing slash). */
  readonly baseURL: string
  /** Default auth method advertised in the UI. */
  readonly authMethod: AuthMethod
  /** Which wire format this provider speaks. */
  readonly apiFormat: ApiFormat
  /**
   * Static model catalog. Providers that can fetch a dynamic catalog from
   * the API should still return a sensible fallback here so the picker
   * works offline / before first auth.
   */
  listModels(): ModelInfo[]
  /**
   * Stream a completion. The returned async iterable yields `StreamChunk`
   * in a uniform shape regardless of the underlying provider format.
   * Throws on auth failure or unrecoverable network error; the stream
   * may also yield `{ type: 'error', error }` for stream-level failures.
   *
   * `credential` is optional — models with `requiresAuth: false` (e.g.
   * OpenCode Zen free tier) can be called without one.
   */
  stream(params: StreamParams, credential?: ProviderCredential): AsyncIterable<StreamChunk>
  /**
   * Test whether the credential is valid by issuing a small probe request.
   * Should not throw — return `false` on any failure.
   */
  validateCredential(credential: ProviderCredential): Promise<boolean>
}

// ─── Format handlers (the wire-format abstraction) ───────────────────────

/**
 * A per-stream context that turns raw provider SSE events into uniform
 * `StreamChunk`s. Holds any state needed to accumulate partial deltas
 * (e.g. streamed JSON arguments for tool_use).
 */
export interface FormatContext {
  /**
   * Map a single SSE event into one or more chunks (or null to skip).
   * OpenAI-compatible gateways may batch reasoning, text, and several
   * tool-call deltas in the same SSE event.
   */
  processEvent(
    event: { event?: string; data: string; id?: string },
  ): StreamChunk | StreamChunk[] | null
  /** Optional last-chance hook called once after the stream ends. */
  finalize(): StreamChunk | StreamChunk[] | null
  /** Emit the terminal message_end chunk. Always called once per stream. */
  emitMessageEnd(): StreamChunk
}

/**
 * A `FormatHandler` knows how to talk to one wire format. Multiple providers
 * (OpenAI direct, OpenCode Zen, PayPerQ, …) can share a single handler when
 * they speak the same protocol — only the baseURL and credential change.
 */
export interface FormatHandler {
  /** Build the fetch Request for a streaming chat completion. */
  buildRequest(
    params: StreamParams,
    credential: ProviderCredential | undefined,
    baseURL: string,
  ): { url: string; init: RequestInit }
  /** Create a fresh per-stream context. */
  createContext(): FormatContext
}

// ─── Errors (typed) ───────────────────────────────────────────────────────

export class ProviderAuthError extends Error {
  readonly provider: string
  readonly status?: number
  constructor(message: string, provider: string, status?: number) {
    super(message)
    this.name = 'ProviderAuthError'
    this.provider = provider
    this.status = status
  }
}

export class ProviderRateLimitError extends Error {
  readonly provider: string
  constructor(message: string, provider: string) {
    super(message)
    this.name = 'ProviderRateLimitError'
    this.provider = provider
  }
}

export class ProviderContextOverflowError extends Error {
  readonly provider: string
  constructor(message: string, provider: string) {
    super(message)
    this.name = 'ProviderContextOverflowError'
    this.provider = provider
  }
}
