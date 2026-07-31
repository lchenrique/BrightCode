/**
 * Generic provider factory.
 *
 * Given a wire format (openai-chat, anthropic-messages, gemini-native, …)
 * and provider metadata, produces a complete `IAgentProvider` instance.
 * Concrete provider modules (openai.ts, anthropic.ts, opencode-zen.ts, …)
 * just call this with their specific config — no per-provider
 * stream-parsing code is duplicated.
 *
 * ## Dual-mode streaming
 *
 * In the Electron wrapper, the actual fetch happens in the **main process**
 * via `provider:stream` IPC — see `electron/main/provider-proxy.ts`. This
 * sidesteps CORS, lets the renderer stay oblivious to OS keyrings, and
 * gives us a single chokepoint for logging/auditing.
 *
 * In plain browser dev (no Electron), we fall back to the local `fetch`
 * so the UI can still be developed and tested without a desktop runtime.
 */

import type {
  ApiFormat,
  IAgentProvider,
  ModelInfo,
  ProviderCredential,
  StreamChunk,
  StreamParams,
} from './types'
import { anthropicMessagesHandler } from './formats/anthropic-messages'
import { classifyHttpError, openaiChatHandler } from './formats/openai-chat'
import { geminiNativeHandler } from './formats/gemini-native'
import { parseSSE } from './formats/sse-parser'

export interface CreateProviderConfig {
  id: string
  name: string
  baseURL: string
  apiFormat: ApiFormat
  defaultAuthMethod?: 'api_key' | 'oauth' | 'cli_detected'
  staticModels: ModelInfo[]
  /**
   * Optional override of the credential lookup id. When set, the registry
   * resolves credentials from this id instead of `id`. Use when two
   * providers share a single API key (e.g. the OpenAI-chat and Anthropic-
   * message subsets of OpenCode Go both consume the same Go key).
   */
  credentialProviderId?: string
  /** Optional: pass a custom format handler instead of a built-in one. */
  customFormatHandler?: typeof openaiChatHandler
  /** Per-request model id prefix (e.g. 'opencode-go/' for OpenCode Go). */
  modelPrefix?: string
  /** Optional header overrides per request. */
  extraHeaders?: Record<string, string>
  /**
   * Headers used only when streaming without a stored credential.
   * OpenCode Zen's free tier authenticates with Bearer "public".
   */
  unauthenticatedHeaders?: Record<string, string>
  /** When true, the stream call is `non-streaming` then re-emitted as one chunk. */
  fakeStreaming?: boolean
}

const FORMAT_HANDLERS: Record<ApiFormat, typeof openaiChatHandler | undefined> = {
  'openai-chat': openaiChatHandler,
  'openai-responses': undefined, // TODO Phase 2+
  'anthropic-messages': anthropicMessagesHandler,
  'gemini-native': geminiNativeHandler,
  custom: undefined,
}

const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

function asChunks(value: StreamChunk | StreamChunk[] | null): StreamChunk[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

export function createProvider(config: CreateProviderConfig): IAgentProvider {
  const formatHandler = config.customFormatHandler ?? FORMAT_HANDLERS[config.apiFormat]
  if (!formatHandler) {
    throw new Error(
      `Provider "${config.id}": no handler for apiFormat "${config.apiFormat}". ` +
        `Pass customFormatHandler for advanced cases.`,
    )
  }

  const provider: IAgentProvider = {
    id: config.id,
    credentialProviderId: config.credentialProviderId ?? config.id,
    name: config.name,
    baseURL: config.baseURL,
    authMethod: config.defaultAuthMethod ?? 'api_key',
    apiFormat: config.apiFormat,
    listModels: () => config.staticModels,

    async *stream(params: StreamParams, credential?: ProviderCredential): AsyncIterable<StreamChunk> {
      // Prefix model id if needed (e.g. 'opencode-go/kimi-k2.6')
      const effectiveParams: StreamParams =
        config.modelPrefix && !params.model.includes('/')
          ? { ...params, model: `${config.modelPrefix}${params.model}` }
          : params

      // ── Electron path: stream via the main-process proxy ──
      if (isElectron && window.electronAPI?.providerStream) {
        const { url, init } = formatHandler.buildRequest(
          effectiveParams,
          credential,
          config.baseURL,
        )
        const headers: Record<string, string> = {}
        if (init.headers) {
          const h = new Headers(init.headers as HeadersInit)
          h.forEach((v, k) => {
            headers[k] = v
          })
        }
        for (const [key, value] of Object.entries(config.extraHeaders ?? {})) {
          headers[key] = value
        }
        if (!credential) {
          for (const [key, value] of Object.entries(
            config.unauthenticatedHeaders ?? {},
          )) {
            headers[key] = value
          }
        }
        const body = typeof init.body === 'string' ? init.body : ''

        const handle = window.electronAPI.providerStream({
          providerId: config.id,
          apiFormat: config.apiFormat,
          url,
          method: typeof init.method === 'string' ? init.method : 'POST',
          headers,
          body: body ?? '',
        })
        // Wire AbortSignal → handle.cancel so the renderer Stop button
        // actually interrupts the upstream provider instead of just
        // discarding the queue.
        effectiveParams.signal?.addEventListener('abort', () => handle.cancel(), { once: true })
        // IMPORTANT: one context per stream. The handler accumulates
        // tool-call args, stop reason, model name, etc across chunks.
        // Re-creating the context per chunk silently drops every delta
        // after the first — see the tool_use_start/delta pattern.
        const context = formatHandler.createContext()
        try {
          for await (const { raw } of handle.chunks) {
            const event = { event: 'message', data: raw }
            for (const chunk of asChunks(context.processEvent(event))) {
              yield chunk
            }
          }
        } catch (err) {
          yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
          return
        }
        for (const tail of asChunks(context.finalize())) {
          yield tail
        }
        // Always emit exactly one message_end
        yield context.emitMessageEnd()
        return
      }

      // ── Browser path: fetch locally (used for plain web dev) ──
      const { url, init } = formatHandler.buildRequest(effectiveParams, credential, config.baseURL)
      if (config.extraHeaders) {
        const merged = new Headers(init.headers as HeadersInit | undefined)
        for (const [k, v] of Object.entries(config.extraHeaders)) {
          merged.set(k, v)
        }
        init.headers = merged
      }
      if (!credential && config.unauthenticatedHeaders) {
        const merged = new Headers(init.headers as HeadersInit | undefined)
        for (const [k, v] of Object.entries(config.unauthenticatedHeaders)) {
          merged.set(k, v)
        }
        init.headers = merged
      }

      const response = await fetch(url, init)
      if (!response.ok) {
        throw classifyHttpError(response.status, config.id)
      }
      if (!response.body) {
        throw new Error(`${config.id}: no response body for streaming request`)
      }

      const context = formatHandler.createContext()
      try {
        for await (const event of parseSSE(response.body, effectiveParams.signal)) {
          for (const chunk of asChunks(context.processEvent(event))) {
            yield chunk
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          yield { type: 'error', error: err }
        } else {
          throw err
        }
      }

      for (const tail of asChunks(context.finalize())) {
        yield tail
      }
      yield context.emitMessageEnd()
    },

    async validateCredential(credential: ProviderCredential): Promise<boolean> {
      try {
        const probeParams: StreamParams = {
          model: config.staticModels[0]?.id ?? 'probe',
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 1,
        }
        const it = provider.stream(probeParams, credential)
        for await (const chunk of it) {
          if (chunk.type === 'error') return false
          if (chunk.type === 'message_end' || chunk.type === 'text_delta') return true
        }
        return true
      } catch {
        return false
      }
    },
  }

  return provider
}
