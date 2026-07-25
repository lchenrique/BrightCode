/**
 * Anthropic `/v1/messages` format adapter.
 *
 * Wire format:
 *   request:  POST {baseURL}/v1/messages
 *             { model, messages, max_tokens, system?, stream: true, tools? }
 *             headers: x-api-key: <key>
 *                      anthropic-version: 2023-06-01
 *   response: SSE — events have `event:` and `data:`:
 *             - message_start: { message: { model, usage: { input_tokens } } }
 *             - content_block_start: { index, content_block: { type, ... } }
 *             - content_block_delta: { index, delta: { type, text | thinking | input_json_delta } }
 *             - content_block_stop:  { index }
 *             - message_delta: { delta: { stop_reason, stop_sequence? }, usage: { output_tokens } }
 *             - message_stop: {}
 *             - error: { error: { type, message } }
 *
 * Content block types: `text`, `thinking`, `tool_use`, `redacted_thinking`.
 *
 * Used by: Anthropic direct, MiniMax (Anthropic-style endpoint at
 * api.minimax.io/anthropic), OpenCode Go (for the Anthropic-style models
 * like minimax-m3).
 */

import type {
  ChatMessage,
  ContentBlock,
  FormatContext,
  FormatHandler,
  ProviderCredential,
  StreamChunk,
  StreamParams,
} from '../types'
import { classifyHttpError } from './openai-chat'
import { ProviderAuthError } from '../types'
import type { SSEEvent } from './sse-parser'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

// ─── Wire types ───────────────────────────────────────────────────────────

type AnthropicEvent =
  | { type: 'message_start'; message: { model: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text' | 'thinking' | 'tool_use'; id?: string; name?: string; text?: string; thinking?: string; input?: unknown } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta' | 'thinking_delta' | 'input_json_delta'; text?: string; thinking?: string; partial_json?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string; stop_sequence?: string | null }; usage?: { output_tokens?: number } }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } }

function mapMessagesToAnthropic(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'system') continue // system goes in top-level field
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content })
      } else {
        const blocks = m.content as ContentBlock[]
        out.push({
          role: 'user',
          content: blocks.map((b) => {
            if (b.type === 'text') return { type: 'text', text: b.text }
            if (b.type === 'image') return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } }
            if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError }
            return null
          }).filter(Boolean),
        })
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        out.push({ role: 'assistant', content: m.content })
      } else {
        const blocks = m.content as ContentBlock[]
        out.push({
          role: 'assistant',
          content: blocks.map((b) => {
            if (b.type === 'text') return { type: 'text', text: b.text }
            if (b.type === 'thinking') return { type: 'thinking', thinking: b.text, ...(b.signature ? { signature: b.signature } : {}) }
            if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }
            return null
          }).filter(Boolean),
        })
      }
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: typeof m.content === 'string' ? m.content : '',
            ...(m.toolName ? { tool_name: m.toolName } : {}),
          },
        ],
      })
    }
  }
  return out
}

function anthropicAuthHeaders(credential: ProviderCredential | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
  if (!credential) {
    // No-auth path — only valid for free models on a provider that allows
    // it. Anthropic itself doesn't allow this, but we leave the door open
    // for adapters that proxy through a free tier.
    return headers
  }
  if (credential.method === 'api_key' && credential.apiKey) {
    headers['x-api-key'] = credential.apiKey
    // Anthropic rejects when both are present; set a placeholder auth
    headers['Authorization'] = 'placeholder'
  } else if (credential.accessToken) {
    headers['Authorization'] = `Bearer ${credential.accessToken}`
  }
  return headers
}

function mapStopReason(reason: string | undefined): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' {
  switch (reason) {
    case 'end_turn':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    default:
      return 'stop'
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────

export const anthropicMessagesHandler: FormatHandler = {
  buildRequest(params: StreamParams, credential: ProviderCredential | undefined, baseURL: string) {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: mapMessagesToAnthropic(params.messages),
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
    }
    if (params.systemPrompt) {
      body.system = params.systemPrompt
    }
    if (params.temperature !== undefined) {
      body.temperature = params.temperature
    }
    if (params.thinking && params.thinking !== 'off') {
      // Anthropic extended thinking — requires max_tokens > thinking budget
      body.thinking = {
        type: 'enabled',
        budget_tokens: Math.max(1024, Math.floor((params.maxTokens ?? DEFAULT_MAX_TOKENS) * 0.5)),
      }
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
      body.tool_choice =
        params.toolChoice === 'none'
          ? { type: 'none' }
          : typeof params.toolChoice === 'object' && params.toolChoice?.name
            ? { type: 'tool', name: params.toolChoice.name }
            : { type: 'auto' }
    }

    return {
      url: `${baseURL.replace(/\/$/, '')}/v1/messages`,
      init: {
        method: 'POST',
        headers: anthropicAuthHeaders(credential),
        body: JSON.stringify(body),
        signal: params.signal,
      },
    }
  },

  createContext(): FormatContext {
    let finalModel = ''
    let finalUsage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined
    let finalStopReason: string | undefined

    // Per-content-block state for tool_use argument accumulation
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>()

    function processEvent(event: SSEEvent): StreamChunk | null {
      if (!event.event) return null
      let parsed: AnthropicEvent
      try {
        parsed = JSON.parse(event.data) as AnthropicEvent
      } catch {
        return null
      }

      switch (parsed.type) {
        case 'message_start':
          finalModel = parsed.message.model
          if (parsed.message.usage) {
            finalUsage = {
              input: parsed.message.usage.input_tokens ?? 0,
              output: 0,
              cacheRead: parsed.message.usage.cache_read_input_tokens,
              cacheWrite: parsed.message.usage.cache_creation_input_tokens,
            }
          }
          return null

        case 'content_block_start': {
          const block = parsed.content_block
          if (block.type === 'tool_use' && block.id && block.name) {
            toolBlocks.set(parsed.index, { id: block.id, name: block.name, args: '' })
            return { type: 'tool_use_start', id: block.id, name: block.name }
          }
          if (block.type === 'thinking' && block.thinking) {
            return { type: 'thinking_delta', text: block.thinking }
          }
          return null
        }

        case 'content_block_delta': {
          const delta = parsed.delta
          if (delta.type === 'text_delta' && delta.text) {
            return { type: 'text_delta', text: delta.text }
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            return { type: 'thinking_delta', text: delta.thinking }
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            const buf = toolBlocks.get(parsed.index)
            if (buf) {
              buf.args += delta.partial_json
              let parsedArgs: unknown = buf.args
              try {
                parsedArgs = JSON.parse(buf.args)
              } catch {
                // partial — emit raw
              }
              return { type: 'tool_use_delta', id: buf.id, input: parsedArgs }
            }
          }
          return null
        }

        case 'content_block_stop': {
          const buf = toolBlocks.get(parsed.index)
          if (buf) {
            return { type: 'tool_use_end', id: buf.id }
          }
          return null
        }

        case 'message_delta': {
          if (parsed.delta.stop_reason) finalStopReason = parsed.delta.stop_reason
          if (parsed.usage?.output_tokens !== undefined) {
            finalUsage = { ...(finalUsage ?? { input: 0, output: 0 }), output: parsed.usage.output_tokens }
          }
          return null
        }

        case 'message_stop':
          return null

        case 'ping':
          return null

        case 'error':
          return { type: 'error', error: new ProviderAuthError(parsed.error.message, 'anthropic') }

        default:
          return null
      }
    }

    function finalize(): StreamChunk | null {
      return null
    }

    function emitMessageEnd(): StreamChunk {
      return {
        type: 'message_end',
        stopReason: mapStopReason(finalStopReason),
        usage: finalUsage,
        model: finalModel,
      }
    }

    return { processEvent, finalize, emitMessageEnd }
  },
}

export { classifyHttpError }
