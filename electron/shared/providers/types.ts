/**
 * Provider types — re-exports from the renderer-side provider module.
 *
 * This is the main-process view of the provider abstraction. The types
 * are pure (no `window`, no React). The main process imports them for
 * type-checking and runtime use; the renderer keeps the canonical
 * implementations for now (during the V1 → V2 migration).
 *
 * Edge cases this module handles:
 *   - Re-exports only the types/runtime needed by the main process.
 *   - The credential types are kept here so the auth store and the
 *     provider service can talk to each other without circular imports.
 *   - We do NOT import the renderer's `UseProviderStream` hooks.
 *
 * Future: the renderer imports these as `from 'electron/shared/providers'`
 * — the source of truth then lives here, not in `src/lib/providers`.
 */

export type {
  AuthMethod,
  CLISource,
  ProviderCredential,
  ProviderAccount,
  ModelInfo,
  StreamChunk,
  StreamParams,
  ChatMessage,
  ContentBlock,
  ChatMessageRole,
  ThinkingLevel,
  ToolDefinition,
  ToolParameterSchema,
  ApiFormat,
  IAgentProvider,
  FormatHandler,
  FormatContext,
} from '../../../src/lib/providers/types'

export {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderContextOverflowError,
} from '../../../src/lib/providers/types'

/** What the provider service emits to the runtime. */
export type ProviderEventType =
  | 'message_start'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_delta'
  | 'tool_use_end'
  | 'message_end'
  | 'error'

/** A normalized event from the provider service. Maps to RuntimeEvent later. */
export interface ProviderEvent {
  type: ProviderEventType
  threadId: string
  turnId: string
  itemId?: string
  /** Monotonic per-thread (matches RuntimeEvent.sequence). */
  sequence: number
  timestamp: number
  payload: {
    text?: string
    toolName?: string
    toolInput?: unknown
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'error'
    model?: string
    usage?: {
      input: number
      output: number
      cacheRead?: number
      cacheWrite?: number
    }
    error?: { message: string; code?: string; retryable?: boolean }
  }
}

/** Identity of a running provider call. */
export interface ProviderCallId {
  providerId: string
  modelId: string
  accountId?: string
}
