/**
 * OpenAI `/v1/chat/completions` format adapter.
 *
 * Wire format:
 *   request:  POST {baseURL}/chat/completions
 *             { model, messages, stream: true, ... }
 *             headers: Authorization: Bearer <key>
 *   response: SSE — each event is `data: { choices: [{ delta: { content?, tool_calls? } }] }`
 *             end marker: `data: [DONE]`
 *
 * Used by: OpenAI direct, OpenCode Zen (paid), OpenCode Go (most models),
 * PayPerQ, MiniMax (when configured with /v1/chat/completions endpoint).
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
import {
  ProviderAuthError,
  ProviderContextOverflowError,
  ProviderRateLimitError,
} from '../types'
import { parseSSE, type SSEEvent } from './sse-parser'

// ─── Wire types (subset of what the API returns) ──────────────────────────

export interface OpenAIChatChunk {
  id?: string
  model?: string
  choices?: Array<{
    index: number
    delta?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cached_tokens?: number
  }
}

function authHeaders(credential: ProviderCredential | undefined, extra?: Record<string, string>) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  }
  if (!credential) return headers
  if (credential.method === 'api_key' && credential.apiKey) {
    headers['Authorization'] = `Bearer ${credential.apiKey}`
  } else if (credential.accessToken) {
    headers['Authorization'] = `Bearer ${credential.accessToken}`
  }
  if (credential.method === 'cli_detected' || credential.method === 'oauth' || (credential.accessToken && !credential.apiKey)) {
    headers['originator'] = 'codex_cli_rs'
    headers['User-Agent'] = 'codex_cli_rs/0.136.0'
  }
  return headers
}

function mapFinishReason(reason: string | null | undefined): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'error' {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'error'
    default:
      return 'end_turn'
  }
}

function mapMessagesToOpenAI(
  messages: ChatMessage[],
  interleavedReasoningField?: 'reasoning_content' | 'reasoning' | 'reasoning_details',
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: typeof m.content === 'string' ? m.content : m.content })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : m.content })
      continue
    }
    if (m.role === 'assistant') {
      const rawToolCalls = (m as unknown as { toolCalls?: Array<{ id: string; name: string; input: unknown }> }).toolCalls
      let toolCalls: Array<Record<string, unknown>> | undefined
      if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
        toolCalls = rawToolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
          },
        }))
      } else if (Array.isArray(m.content)) {
        const blocks = m.content as ContentBlock[]
        const extracted = blocks
          .filter((b) => b.type === 'tool_use')
          .map((b) => {
            const tb = b as { type: 'tool_use'; id: string; name: string; input: unknown }
            return {
              id: tb.id,
              type: 'function',
              function: { name: tb.name, arguments: JSON.stringify(tb.input ?? {}) },
            }
          })
        if (extracted.length > 0) toolCalls = extracted
      }

      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as ContentBlock[])
                .filter((b) => b.type === 'text')
                .map((b) => (b as { type: 'text'; text: string }).text)
                .join('')
            : ''
      const reasoningText =
        m.reasoningContent ??
        (Array.isArray(m.content)
          ? (m.content as ContentBlock[])
              .filter((b) => b.type === 'thinking')
              .map((b) => (b as { type: 'thinking'; text: string }).text)
              .join('')
          : '')

      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(interleavedReasoningField
          ? { [interleavedReasoningField]: reasoningText }
          : {}),
      })
      continue
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: (m as unknown as { toolCallId?: string; id?: string }).toolCallId ?? (m as unknown as { id?: string }).id ?? '',
        content: typeof m.content === 'string' ? m.content : '',
      })
    }
  }
  return out
}

// ─── Handler ──────────────────────────────────────────────────────────────

function responseFunctionItemId(callId: string): string {
  const suffix = callId.replace(/^call_/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `fc_${suffix || 'unknown'}`
}

function responsesFunctionCallItem(
  toolCall: Extract<ContentBlock, { type: 'tool_use' }>,
): Record<string, unknown> {
  const providerItem =
    toolCall.providerItem?.type === 'function_call' ? toolCall.providerItem : undefined

  return {
    ...(providerItem ?? {}),
    id:
      typeof providerItem?.id === 'string'
        ? providerItem.id
        : responseFunctionItemId(toolCall.id),
    type: 'function_call',
    call_id: toolCall.id,
    name: toolCall.name,
    arguments:
      typeof toolCall.input === 'string'
        ? toolCall.input
        : JSON.stringify(toolCall.input ?? {}),
  }
}

export const openaiChatHandler: FormatHandler = {
  buildRequest(params: StreamParams, credential: ProviderCredential | undefined, baseURL: string) {
    const isCodexResponsesEndpoint =
      baseURL.includes('chatgpt.com') || baseURL.includes('/responses') || baseURL.includes('codex')

    if (isCodexResponsesEndpoint) {
      const input: Array<Record<string, unknown>> = []
      const knownToolCallIds = new Set<string>()
      const resolvedToolCallIds = new Set<string>()
      const replayedProviderItemIds = new Set<string>()
      let instructions = params.systemPrompt ?? ''

      for (const m of params.messages) {
        if (m.role === 'system') {
          if (!instructions) {
            instructions = typeof m.content === 'string' ? m.content : ''
          } else {
            input.push({
              type: 'message',
              role: 'developer',
              content: typeof m.content === 'string' ? [{ type: 'input_text', text: m.content }] : m.content,
            })
          }
        } else if (m.role === 'user') {
          input.push({
            type: 'message',
            role: 'user',
            content: typeof m.content === 'string' ? [{ type: 'input_text', text: m.content }] : m.content,
          })
        } else if (m.role === 'assistant') {
          for (const providerItem of m.providerOutputItems ?? []) {
            if (providerItem.type === 'reasoning') {
              const providerItemId =
                typeof providerItem.id === 'string' ? providerItem.id : undefined
              if (providerItemId && replayedProviderItemIds.has(providerItemId)) {
                continue
              }
              input.push(providerItem)
              if (providerItemId) replayedProviderItemIds.add(providerItemId)
            }
          }

          const contentBlocks = Array.isArray(m.content) ? m.content : []
          const toolCalls = contentBlocks.filter(
            (block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
              block.type === 'tool_use',
          )
          if (toolCalls.length > 0) {
            for (const tc of toolCalls) {
              if (!tc.id || knownToolCallIds.has(tc.id)) continue
              input.push(responsesFunctionCallItem(tc))
              knownToolCallIds.add(tc.id)
            }
          }
          const assistantText =
            typeof m.content === 'string'
              ? m.content
              : contentBlocks
                  .filter(
                    (block): block is Extract<ContentBlock, { type: 'text' }> =>
                      block.type === 'text',
                  )
                  .map((block) => block.text)
                  .join('')
          if (assistantText.length > 0) {
            input.push({
              type: 'message',
              role: 'assistant',
              phase: toolCalls.length > 0 ? 'commentary' : 'final_answer',
              content: [{ type: 'output_text', text: assistantText }],
            })
          }
        } else if (m.role === 'tool') {
          const toolCallId = (m as unknown as { toolCallId?: string; id?: string }).toolCallId ?? (m as unknown as { id?: string }).id ?? ''
          if (
            !toolCallId ||
            !knownToolCallIds.has(toolCallId) ||
            resolvedToolCallIds.has(toolCallId)
          ) {
            continue
          }
          input.push({
            type: 'function_call_output',
            call_id: toolCallId,
            output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })
          resolvedToolCallIds.add(toolCallId)
        }
      }

      if (input.length === 0) {
        input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello' }],
        })
      }

      const codexBody: Record<string, unknown> = {
        model: params.model,
        input,
        instructions: instructions || 'You are BrightCode, an AI coding assistant.',
        stream: true,
        store: false,
        reasoning: {
          effort:
            params.thinking === 'off'
              ? 'none'
              : params.thinking === 'minimal'
                ? 'low'
                : (params.thinking ?? 'low'),
          summary: 'auto',
        },
        include: ['reasoning.encrypted_content'],
      }

      if (params.tools && params.tools.length > 0) {
        codexBody.tools = params.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }))
      }

      const targetUrl = baseURL.endsWith('/responses')
        ? baseURL
        : `${baseURL.replace(/\/$/, '')}/responses`

      return {
        url: targetUrl,
        init: {
          method: 'POST',
          headers: authHeaders(credential),
          body: JSON.stringify(codexBody),
          signal: params.signal,
        },
      }
    }

    const isDeepSeekV4 = params.model.toLowerCase().includes('deepseek-v4')
    const isDeepSeek = params.model.toLowerCase().includes('deepseek')
    const isReasoningModel =
      (params.thinking && params.thinking !== 'off') ||
      params.model.includes('gpt-5') ||
      params.model.includes('o1') ||
      params.model.includes('o3')

    const body: Record<string, unknown> = {
      model: params.model,
      messages: mapMessagesToOpenAI(
        params.messages,
        isDeepSeek ? 'reasoning_content' : undefined,
      ),
      stream: true,
      store: false,
      ...(params.sessionId ? { user: params.sessionId } : {}),
    }

    if (isReasoningModel || isDeepSeekV4) {
      if (params.maxTokens) {
        body.max_completion_tokens = params.maxTokens
      }
      if (isDeepSeekV4 && params.thinking === 'off') {
        body.reasoning_effort = 'none'
      } else if (params.thinking && params.thinking !== 'off') {
        body.reasoning_effort = params.thinking === 'minimal' ? 'low' : params.thinking
      }
    } else {
      if (params.maxTokens) {
        body.max_tokens = params.maxTokens
      }
      if (params.temperature !== undefined) {
        body.temperature = params.temperature
      }
    }

    if (params.systemPrompt) {
      // Inject at the front
      body.messages = [{ role: 'system', content: params.systemPrompt }, ...(body.messages as Array<unknown>)]
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
      body.tool_choice =
        params.toolChoice === 'none'
          ? 'none'
          : typeof params.toolChoice === 'object' && params.toolChoice?.name
            ? { type: 'function', function: { name: params.toolChoice.name } }
            : 'auto'
    }

    const targetUrl =
      baseURL.endsWith('/chat/completions') || baseURL.endsWith('/responses')
        ? baseURL
        : `${baseURL.replace(/\/$/, '')}/chat/completions`

    return {
      url: targetUrl,
      init: {
        method: 'POST',
        headers: authHeaders(credential),
        body: JSON.stringify(body),
        signal: params.signal,
      },
    }
  },

  createContext(): FormatContext {
    let finalModel = ''
    let finalUsage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined
    let finalStopReason: string | null | undefined
    let reasoningText = ''

    // tool call id → accumulated args string
    const toolArgBuffers = new Map<
      number,
      { id: string; itemId?: string; name: string; args: string }
    >()

    function toReasoningDelta(eventType: string | undefined, text: string): string {
      if (!text) return ''

      if (eventType?.endsWith('.delta')) {
        reasoningText += text
        return text
      }

      // Responses emits the same summary as deltas, a `.done` snapshot,
      // and sometimes once more on the completed reasoning item.
      if (text === reasoningText || reasoningText.endsWith(text)) return ''
      if (text.startsWith(reasoningText)) {
        const suffix = text.slice(reasoningText.length)
        reasoningText = text
        return suffix
      }

      reasoningText += text
      return text
    }

    function processEvent(event: SSEEvent): StreamChunk | StreamChunk[] | null {
      if (event.data === '[DONE]') return null

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return null
      }

      if (typeof parsed['model'] === 'string') finalModel = parsed['model']
      const response = parsed['response'] as Record<string, unknown> | undefined
      if (typeof response?.['model'] === 'string') finalModel = response['model']

      // ── Responses API handling (Codex responses endpoint) ──
      const eventType = typeof parsed['type'] === 'string' ? parsed['type'] : event.event
      const itemType = (parsed['item'] as Record<string, unknown> | undefined)?.type
      const partType = (parsed['part'] as Record<string, unknown> | undefined)?.type

      const isReasoningEvent =
        eventType?.includes('reasoning') ||
        itemType === 'reasoning' ||
        partType === 'reasoning' ||
        partType === 'reasoning_summary' ||
        typeof parsed['reasoning'] === 'string' ||
        typeof parsed['reasoning'] === 'object' ||
        typeof parsed['reasoning_delta'] === 'string' ||
        typeof parsed['reasoning_summary'] === 'string'

      if (isReasoningEvent) {
        let text = ''
        if (typeof parsed['delta'] === 'string') {
          text = parsed['delta']
        } else if (typeof parsed['text'] === 'string') {
          text = parsed['text']
        } else if (typeof parsed['reasoning'] === 'string') {
          text = parsed['reasoning']
        } else if (typeof parsed['reasoning_delta'] === 'string') {
          text = parsed['reasoning_delta']
        } else if (typeof parsed['reasoning_summary'] === 'string') {
          text = parsed['reasoning_summary']
        } else if (typeof parsed['summary'] === 'string') {
          text = parsed['summary']
        } else if (parsed['part'] && typeof (parsed['part'] as Record<string, unknown>)['text'] === 'string') {
          text = (parsed['part'] as Record<string, unknown>)['text'] as string
        } else if (parsed['item'] && typeof (parsed['item'] as Record<string, unknown>)['text'] === 'string') {
          text = (parsed['item'] as Record<string, unknown>)['text'] as string
        }

        const delta = toReasoningDelta(eventType, text)
        if (delta) return { type: 'thinking_delta', text: delta }
        const reasoningItem = parsed['item'] as Record<string, unknown> | undefined
        if (
          eventType === 'response.output_item.done' &&
          reasoningItem?.type === 'reasoning'
        ) {
          return {
            type: 'provider_output_item',
            provider: 'openai-responses',
            item: reasoningItem,
          }
        }
        return null
      }

      // ── Function/Tool call handling for Responses API ──
      const item = parsed['item'] as Record<string, unknown> | undefined
      if (item && item['type'] === 'function_call') {
        const callId = (item['call_id'] as string) || (item['id'] as string) || 'call_0'
        const itemId = (item['id'] as string) || undefined
        const name = (item['name'] as string) || ''
        const argsStr = (item['arguments'] as string) || ''
        const outputIndex =
          typeof parsed['output_index'] === 'number' ? parsed['output_index'] : 0

        if (eventType === 'response.output_item.added') {
          toolArgBuffers.set(outputIndex, { id: callId, itemId, name, args: argsStr })
          return {
            type: 'tool_use_start',
            id: callId,
            name,
            providerItem: item,
          }
        }
        if (eventType === 'response.output_item.done') {
          const existing = toolArgBuffers.get(outputIndex)
          toolArgBuffers.set(outputIndex, {
            id: callId,
            itemId,
            name: name || existing?.name || '',
            args: argsStr || existing?.args || '',
          })
          const completeArgs = argsStr || existing?.args || ''
          let parsedArgs: unknown = completeArgs
          try {
            parsedArgs = JSON.parse(completeArgs)
          } catch {
            // keep raw string
          }
          return {
            type: 'tool_use_delta',
            id: callId,
            name,
            input: parsedArgs,
            providerItem: item,
          }
        }
      }

      if (eventType === 'response.function_call_arguments.delta') {
        const itemId = (parsed['item_id'] as string) || undefined
        const outputIndex =
          typeof parsed['output_index'] === 'number' ? parsed['output_index'] : 0
        const deltaArg = typeof parsed['delta'] === 'string' ? parsed['delta'] : ''
        let buf =
          Array.from(toolArgBuffers.values()).find((candidate) => candidate.itemId === itemId) ??
          toolArgBuffers.get(outputIndex)
        if (!buf) {
          const callId = (parsed['call_id'] as string) || itemId || 'call_0'
          buf = { id: callId, itemId, name: '', args: '' }
          toolArgBuffers.set(outputIndex, buf)
          return { type: 'tool_use_start', id: buf.id, name: '' }
        }
        buf.args += deltaArg
        let parsedArgs: unknown = buf.args
        try {
          parsedArgs = JSON.parse(buf.args)
        } catch {
          // partial json
        }
        return { type: 'tool_use_delta', id: buf.id, name: buf.name, input: parsedArgs }
      }

      if (
        eventType === 'response.output_text.delta' ||
        eventType === 'response.text.delta' ||
        (typeof parsed['delta'] === 'string' && !isReasoningEvent)
      ) {
        const text = typeof parsed['delta'] === 'string' ? parsed['delta'] : (parsed['text'] as string)
        if (text) return { type: 'text_delta', text }
      }

      const choice = (parsed['choices'] as Array<Record<string, unknown>>)?.[0]
      if (parsed['usage'] && typeof parsed['usage'] === 'object') {
        const u = parsed['usage'] as Record<string, number>
        finalUsage = {
          input: u['prompt_tokens'] ?? 0,
          output: u['completion_tokens'] ?? 0,
          cacheRead:
            u['cached_tokens'] ??
            (parsed['usage'] as {
              prompt_tokens_details?: { cached_tokens?: number }
            }).prompt_tokens_details?.cached_tokens,
        }
      }
      if (!choice) {
        return null
      }

      if (typeof choice['finish_reason'] === 'string') {
        finalStopReason = choice['finish_reason']
      }

      const delta = choice['delta'] as
        | {
            content?: string | null
            reasoning?: string | null
            reasoning_content?: string | null
            reasoning_details?: string | null
            tool_calls?: Array<{
              index: number
              id?: string
              type?: 'function'
              function?: { name?: string; arguments?: string }
            }>
          }
        | undefined
      if (!delta) return null

      const out: StreamChunk[] = []
      const reasoningDelta =
        delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_details
      if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
        out.push({ type: 'thinking_delta', text: reasoningDelta })
      }

      // Text content
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        out.push({ type: 'text_delta', text: delta.content })
      }

      // Tool call deltas — OpenAI streams them in pieces, so we accumulate
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          let buf = toolArgBuffers.get(tc.index)
          if (!buf) {
            buf = {
              id: tc.id || `call_${tc.index}`,
              name: tc.function?.name ?? '',
              args: '',
            }
            toolArgBuffers.set(tc.index, buf)
            out.push({ type: 'tool_use_start', id: buf.id, name: buf.name })
          }
          if (tc.function?.name) {
            buf.name = tc.function.name
          }
          if (buf && tc.function?.arguments) {
            buf.args += tc.function.arguments
            let parsedArgs: unknown = buf.args
            try {
              parsedArgs = JSON.parse(buf.args)
            } catch {
              // partial JSON — emit the raw string so UI can show a streaming shell
            }
            out.push({
              type: 'tool_use_delta',
              id: buf.id,
              name: buf.name,
              input: parsedArgs,
            })
          }
        }
      }

      return out.length > 1 ? out : (out[0] ?? null)
    }

    function finalize(): StreamChunk | StreamChunk[] | null {
      const closeChunks = Array.from(toolArgBuffers.values()).map(
        (tool): StreamChunk => ({
          type: 'tool_use_end',
          id: tool.id,
        }),
      )
      return closeChunks.length > 1 ? closeChunks : (closeChunks[0] ?? null)
    }

    function emitMessageEnd(): StreamChunk {
      const computedStopReason =
        toolArgBuffers.size > 0 ? 'tool_use' : mapFinishReason(finalStopReason)
      return {
        type: 'message_end',
        stopReason: computedStopReason,
        usage: finalUsage,
        model: finalModel,
      }
    }

    return { processEvent, finalize, emitMessageEnd }
  },
}

export function classifyHttpError(status: number, provider: string): Error {
  if (status === 401 || status === 403) return new ProviderAuthError(`${provider} auth failed (${status})`, provider, status)
  if (status === 429) return new ProviderRateLimitError(`${provider} rate limited (${status})`, provider)
  if (status === 413 || status === 400) return new ProviderContextOverflowError(`${provider} request too large (${status})`, provider)
  return new Error(`${provider} HTTP ${status}`)
}

// Re-exports for tree-shaking friendliness
export { parseSSE, type SSEEvent }
export { ProviderAuthError, ProviderRateLimitError, ProviderContextOverflowError }
