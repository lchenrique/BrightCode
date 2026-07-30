/**
 * ProviderService — runs model streams in the main process.
 *
 * Replaces the renderer-owned `providerRegistry.stream()` loop. The
 * runtime (Task 5) calls this from the main process; the service:
 *   1. Resolves the catalog (model → provider) from the renderer's
 *      registry projections (forwarded via IPC during the V1→V2 migration).
 *   2. Builds the request using the provider's wire-format handler.
 *   3. Streams the response, parsing SSE and translating it to
 *      normalized `ProviderEvent`s.
 *   4. Emits usage, errors, and stop reasons.
 *
 * The service owns:
 *   - The fetch loop (no CORS, no `window`).
 *   - The AbortController for cancellation.
 *   - Credential lookup (via the auth store, not the renderer).
 *
 * The service does NOT own:
 *   - The credential storage (auth store).
 *   - The actual provider catalog (renderer registry, IPC-projected).
 *   - The runtime event store (Task 3).
 *
 * Migration strategy (lock-in):
 *   - Phase 1: this service wraps the existing wire-format handlers.
 *     The renderer registers providers; the main process projects them
 *     via `registry-sync` IPC.
 *   - Phase 2: providers move to the main process. The renderer becomes
 *     a read-only catalog projection.
 */

import {
  type FormatContext,
  type FormatHandler,
  type IAgentProvider,
  type ProviderEvent,
  type StreamChunk,
  type StreamParams,
} from '../../shared/providers/types'
import { openaiChatHandler } from '../../../src/lib/providers/formats/openai-chat'
import { anthropicMessagesHandler } from '../../../src/lib/providers/formats/anthropic-messages'
import { geminiNativeHandler } from '../../../src/lib/providers/formats/gemini-native'
import { parseSSE, type SSEEvent } from '../../../src/lib/providers/formats/sse-parser'
import { isAuthRejection, isConnectivityError } from '../../shared/provider-connection-config'

// ── Format handler map ────────────────────────────────────────────────────

/**
 * Look up the wire-format handler for an `apiFormat` id. The map is
 * initialised once at module load; new formats require a code change
 * (no runtime registration — keeps the dependency direction explicit).
 */
const HANDLERS: Record<string, FormatHandler> = {
  'openai-chat': openaiChatHandler,
  'openai-responses': openaiChatHandler, // legacy alias; same wire shape
  'anthropic-messages': anthropicMessagesHandler,
  'gemini-native': geminiNativeHandler,
}

/** Get the format handler for a provider. Throws if unknown. */
function getHandler(provider: IAgentProvider): FormatHandler {
  const handler = HANDLERS[provider.apiFormat]
  if (!handler) {
    throw new Error(
      `No format handler for provider "${provider.id}" (apiFormat=${provider.apiFormat}).`,
    )
  }
  return handler
}

// ── Public service API ────────────────────────────────────────────────────

export interface ProviderServiceOptions {
  /** Per-request timeout in ms. Default 5 minutes. */
  timeoutMs?: number
  /** Max retries before a transient error becomes terminal. Default 2. */
  maxRetries?: number
}

export interface RunProviderStreamInput {
  threadId: string
  turnId: string
  /** Starting sequence number for emitted events. */
  startSequence: number
  provider: IAgentProvider
  params: StreamParams
  credential?: import('../../shared/providers/types').ProviderCredential
  /** Optional signal from the runtime that aborts the whole turn. */
  signal?: AbortSignal
}

export interface ProviderService {
  /**
   * Run a streaming provider call. Yields normalized `ProviderEvent`s.
   * The runtime consumes these, feeds them through the reducer, and
   * persists them to the event store.
   *
   * Cancellation:
   *   - `signal.aborted` → stops the fetch and yields no further events.
   *   - Provider-level errors are yielded as `type: 'error'` events;
   *     the runtime decides whether to terminate the turn.
   *
   * Retries:
   *   - Only retryable transient errors (network, 5xx) are retried.
   *   - Auth rejections (401, 403) are non-retryable — config issue.
   *   - Rate limits (429) retry once with backoff.
   */
  run(input: RunProviderStreamInput): AsyncGenerator<ProviderEvent>
}

class ProviderServiceImpl implements ProviderService {
  private readonly options: ProviderServiceOptions

  constructor(options: ProviderServiceOptions = {}) {
    this.options = options
  }

  async *run(input: RunProviderStreamInput): AsyncGenerator<ProviderEvent> {
    if (input.provider.apiFormat === 'custom') {
      yield* this.runCustomProvider(input)
      return
    }

    const opts = {
      timeoutMs: this.options.timeoutMs ?? 5 * 60 * 1000,
      maxRetries: this.options.maxRetries ?? 2,
    }
    const handler = getHandler(input.provider)
    let attempt = 0
    let sequence = input.startSequence

    while (attempt <= opts.maxRetries) {
      if (input.signal?.aborted) return
      const ctx = handler.createContext()
      const request = handler.buildRequest(input.params, input.credential, input.provider.baseURL)

      // Mix provider-injected headers with credential auth headers.
      const headers: Record<string, string> = { ...(request.init.headers as Record<string, string> | undefined) }

      try {
        const response = await fetch(request.url, {
          ...request.init,
          headers,
          signal: input.signal,
        })

        if (!response.ok) {
          const status = response.status
          if (status === 401 || status === 403) {
            // Auth rejection — non-retryable.
            yield {
              type: 'error',
              threadId: input.threadId,
              turnId: input.turnId,
              sequence: sequence++,
              timestamp: Date.now(),
              payload: {
                error: {
                  message: `Auth rejected (HTTP ${status}) — check your ${input.provider.id} key.`,
                  code: 'auth-rejection',
                  retryable: false,
                },
              },
            }
            return
          }
          if (status === 429) {
            // Rate limit — may retry once.
            if (attempt < opts.maxRetries) {
              attempt++
              await this.backoff(attempt, input.signal)
              continue
            }
            yield {
              type: 'error',
              threadId: input.threadId,
              turnId: input.turnId,
              sequence: sequence++,
              timestamp: Date.now(),
              payload: {
                error: {
                  message: `Rate limit (HTTP 429) — back off and try again.`,
                  code: 'rate-limit',
                  retryable: true,
                },
              },
            }
            return
          }
          if (status >= 500) {
            // Server error — retryable.
            if (attempt < opts.maxRetries) {
              attempt++
              await this.backoff(attempt, input.signal)
              continue
            }
            yield {
              type: 'error',
              threadId: input.threadId,
              turnId: input.turnId,
              sequence: sequence++,
              timestamp: Date.now(),
              payload: {
                error: {
                  message: `Server error (HTTP ${status}).`,
                  code: 'server-error',
                  retryable: true,
                },
              },
            }
            return
          }
          // Other 4xx — likely a bad request; surface.
          yield {
            type: 'error',
            threadId: input.threadId,
            turnId: input.turnId,
            sequence: sequence++,
            timestamp: Date.now(),
            payload: {
              error: {
                message: `Request failed (HTTP ${status}).`,
                code: 'http-error',
                retryable: false,
              },
            },
          }
          return
        }

        if (!response.body) {
          yield {
            type: 'error',
            threadId: input.threadId,
            turnId: input.turnId,
            sequence: sequence++,
            timestamp: Date.now(),
            payload: {
              error: { message: 'No response body', code: 'empty-response', retryable: false },
            },
          }
          return
        }

        // Emit message_start
        yield {
          type: 'message_start',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence: sequence++,
          timestamp: Date.now(),
          payload: {},
        }

        // Stream SSE events
        for await (const sseEvent of parseSSE(response.body, input.signal)) {
          const chunks = this.processEvent(ctx, sseEvent)
          for (const chunk of chunks) {
            const event = this.toProviderEvent(chunk, input, sequence)
            if (event) {
              sequence = event.sequence + 1
              yield event
            }
          }
        }

        // Finalize (terminal chunks)
        const finalized = ctx.finalize()
        if (finalized) {
          const chunks = Array.isArray(finalized) ? finalized : [finalized]
          for (const chunk of chunks) {
            const event = this.toProviderEvent(chunk, input, sequence)
            if (event) {
              sequence = event.sequence + 1
              yield event
            }
          }
        }

        // Emit message_end
        const endChunk = ctx.emitMessageEnd()
        const endEvent = this.toProviderEvent(endChunk, input, sequence)
        if (endEvent) {
          sequence = endEvent.sequence + 1
          yield endEvent
        } else {
          // Format didn't provide a message_end — synthesize one.
          yield {
            type: 'message_end',
            threadId: input.threadId,
            turnId: input.turnId,
            sequence: sequence++,
            timestamp: Date.now(),
            payload: {
              stopReason: 'end_turn',
              model: input.params.model,
            },
          }
        }
        return
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // User cancellation — silent.
          return
        }
        if (isAuthRejection(err)) {
          yield {
            type: 'error',
            threadId: input.threadId,
            turnId: input.turnId,
            sequence: sequence++,
            timestamp: Date.now(),
            payload: {
              error: {
                message: err instanceof Error ? err.message : 'Auth rejection',
                code: 'auth-rejection',
                retryable: false,
              },
            },
          }
          return
        }
        if (isConnectivityError(err)) {
          if (attempt < opts.maxRetries) {
            attempt++
            await this.backoff(attempt, input.signal)
            continue
          }
        }
        // Unknown error — surface.
        yield {
          type: 'error',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence: sequence++,
          timestamp: Date.now(),
          payload: {
            error: {
              message: err instanceof Error ? err.message : String(err),
              code: 'unknown',
              retryable: false,
            },
          },
        }
        return
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async *runCustomProvider(
    input: RunProviderStreamInput,
  ): AsyncGenerator<ProviderEvent> {
    let sequence = input.startSequence

    try {
      for await (const chunk of input.provider.stream(
        { ...input.params, signal: input.signal },
        input.credential,
      )) {
        if (input.signal?.aborted) return
        if (chunk.type === 'message_start') {
          yield {
            type: 'message_start',
            threadId: input.threadId,
            turnId: input.turnId,
            sequence: sequence++,
            timestamp: Date.now(),
            payload: {},
          }
          continue
        }
        const event = this.toProviderEvent(chunk, input, sequence)
        if (!event) continue
        sequence = event.sequence + 1
        yield event
      }
    } catch (error) {
      if (input.signal?.aborted) return
      yield {
        type: 'error',
        threadId: input.threadId,
        turnId: input.turnId,
        sequence,
        timestamp: Date.now(),
        payload: {
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: 'custom-provider-error',
            retryable: false,
          },
        },
      }
    }
  }

  private processEvent(ctx: FormatContext, sseEvent: SSEEvent): StreamChunk[] {
    const result = ctx.processEvent(sseEvent)
    if (!result) return []
    return Array.isArray(result) ? result : [result]
  }

  private toProviderEvent(
    chunk: StreamChunk,
    input: RunProviderStreamInput,
    sequence: number,
  ): ProviderEvent | null {
    switch (chunk.type) {
      case 'message_start':
        return null // already emitted by the service
      case 'text_delta':
        return {
          type: 'text_delta',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence,
          timestamp: Date.now(),
          payload: { text: chunk.text },
        }
      case 'thinking_delta':
        return {
          type: 'thinking_delta',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence,
          timestamp: Date.now(),
          payload: { text: chunk.text },
        }
      case 'tool_use_start':
        return {
          type: 'tool_use_start',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence,
          timestamp: Date.now(),
          itemId: chunk.id,
          payload: {
            toolName: chunk.name,
            providerItem: chunk.providerItem,
          },
        }
      case 'tool_use_delta':
        return {
          type: 'tool_use_delta',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence,
          timestamp: Date.now(),
          itemId: chunk.id,
          payload: {
            toolInput: chunk.input,
            toolName: chunk.name,
            providerItem: chunk.providerItem,
          },
        }
      case 'tool_use_end':
        return {
          type: 'tool_use_end',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence,
          timestamp: Date.now(),
          itemId: chunk.id,
          payload: {},
        }
      case 'message_end':
        return {
          type: 'message_end',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence,
          timestamp: Date.now(),
          payload: {
            stopReason: chunk.stopReason,
            model: chunk.model,
            usage: chunk.usage,
          },
        }
      case 'error':
        return {
          type: 'error',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence,
          timestamp: Date.now(),
          payload: {
            error: { message: chunk.error.message, retryable: false },
          },
        }
      case 'provider_output_item':
        return {
          type: 'provider_output_item',
          threadId: input.threadId,
          turnId: input.turnId,
          sequence,
          timestamp: Date.now(),
          payload: {
            provider: chunk.provider,
            providerOutputItem: chunk.item,
          },
        }
    }
  }

  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    const delayMs = Math.min(1000 * 2 ** attempt, 10_000)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, delayMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
  }
}

// ── Singleton export ───────────────────────────────────────────────────────

let _service: ProviderService | null = null

export function getProviderService(options?: ProviderServiceOptions): ProviderService {
  if (!_service) _service = new ProviderServiceImpl(options)
  return _service
}

/** Reset the singleton (tests only). */
export function _resetProviderService(): void {
  _service = null
}
