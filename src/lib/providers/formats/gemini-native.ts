/**
 * Gemini "native" format — used by Google Generative Language API and
 * Google Cloud Code (Antigravity). Both share a similar wire shape:
 *
 *   Generative Language:
 *     POST {baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={KEY}
 *     request:  { contents: [{ role, parts }], systemInstruction?, generationConfig, tools? }
 *     response: SSE — each event is `data: { candidates: [{ content: { parts: [{ text }] }] }]`
 *
 *   Cloud Code (Antigravity):
 *     POST {baseURL}/v1internal:streamGenerateContent?alt=sse
 *     request:  same shape (but Authorization: Bearer ACCESS_TOKEN)
 *
 * The format handler is responsible for choosing the right URL and auth
 * based on the credential shape (apiKey → Generative Language,
 * accessToken → Cloud Code). The factory already wires apiFormat to
 * this handler, so providers only need to declare the right `apiFormat`
 * and `baseURL` in their config.
 */

import type {
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

// ── Wire types ──────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
  thought?: boolean
  thoughtSignature?: string
}

interface GeminiCandidate {
  content?: { role: string; parts: GeminiPart[] }
  finishReason?: string
  index?: number
}

interface GeminiChunk {
  candidates?: GeminiCandidate[]
  modelVersion?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
  }
}

interface GeminiRequest {
  contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>
  systemInstruction?: { parts: GeminiPart[] }
  generationConfig?: { maxOutputTokens?: number; temperature?: number; topP?: number }
  tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
  toolConfig?: {
    functionCallingConfig: {
      mode: 'AUTO' | 'NONE' | 'ANY'
      allowedFunctionNames?: string[]
    }
  }
}

// ── Request building ────────────────────────────────────────────────────

function blockToPart(b: ContentBlock, toolName?: string): GeminiPart | null {
  switch (b.type) {
    case 'text':
      return { text: b.text }
    case 'image':
      // Inline base64 image. Gemini expects `{ inlineData: { mimeType, data } }`.
      return { inlineData: { mimeType: b.mediaType, data: b.data } }
    case 'tool_use':
      return b.providerItem?.functionCall
        ? {
            functionCall: b.providerItem.functionCall as GeminiPart['functionCall'],
            ...(typeof b.providerItem.thoughtSignature === 'string'
              ? { thoughtSignature: b.providerItem.thoughtSignature }
              : {}),
          }
        : {
            functionCall: {
              id: b.id,
              name: b.name,
              args: (b.input as Record<string, unknown>) ?? {},
            },
          }
    case 'tool_result':
      return {
        functionResponse: {
          id: b.toolUseId,
          name: b.toolName ?? toolName ?? 'tool',
          response: { result: b.content, isError: b.isError ?? false },
        },
      }
    case 'thinking':
      return { thought: true, text: b.text }
    default:
      return null
  }
}

function mapMessagesToGemini(messages: StreamParams['messages']): GeminiRequest['contents'] {
  const out: GeminiRequest['contents'] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] =
      typeof m.content === 'string'
        ? [{ text: m.content }]
        : (m.content as ContentBlock[])
            .map((block) => blockToPart(block, m.toolName))
            .filter((p): p is GeminiPart => p !== null)
    if (parts.length > 0) out.push({ role, parts })
  }
  return out
}

function buildRequest(
  params: StreamParams,
  credential: ProviderCredential | undefined,
  baseURL: string,
  model: string,
): { url: string; init: RequestInit } {
  const body: GeminiRequest = {
    contents: mapMessagesToGemini(params.messages),
  }
  if (params.systemPrompt) {
    body.systemInstruction = { parts: [{ text: params.systemPrompt }] }
  }
  body.generationConfig = {
    ...(params.maxTokens ? { maxOutputTokens: params.maxTokens } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
  }
  if (params.tools && params.tools.length > 0 && params.toolChoice !== 'none') {
    body.tools = [{
      functionDeclarations: params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      })),
    }]
    body.toolConfig = {
      functionCallingConfig: typeof params.toolChoice === 'object'
        ? { mode: 'ANY', allowedFunctionNames: [params.toolChoice.name] }
        : { mode: 'AUTO' },
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let url: string
  if (credential?.apiKey) {
    // Generative Language API — key in the query string.
    url = `${baseURL.replace(/\/$/, '')}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(credential.apiKey)}`
  } else if (credential?.accessToken) {
    // Cloud Code (Antigravity) — bearer token.
    headers['Authorization'] = `Bearer ${credential.accessToken}`
    url = `${baseURL.replace(/\/$/, '')}/v1internal:streamGenerateContent?alt=sse`
  } else {
    throw new ProviderAuthError(
      `${baseURL}: no credential (apiKey or accessToken)`,
      'gemini-native',
    )
  }

  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    },
  }
}

// ── Response parsing ────────────────────────────────────────────────────

function mapFinishReason(reason: string | undefined): 'end_turn' | 'max_tokens' | 'error' {
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'OTHER') return 'error'
  return 'end_turn'
}

// ── Handler ─────────────────────────────────────────────────────────────

export const geminiNativeHandler: FormatHandler = {
  buildRequest(
    params: StreamParams,
    credential: ProviderCredential | undefined,
    baseURL: string,
  ): { url: string; init: RequestInit } {
    return buildRequest(params, credential, baseURL, params.model)
  },

  createContext(): FormatContext {
    let finalModel = ''
    let finalUsage:
      | { input: number; output: number; cacheRead?: number; cacheWrite?: number }
      | undefined
    let finalStopReason: string | undefined

    return {
      processEvent(event: { data: string }): StreamChunk | StreamChunk[] | null {
        try {
          const parsed = JSON.parse(event.data) as GeminiChunk
          if (parsed.modelVersion) finalModel = parsed.modelVersion
          if (parsed.usageMetadata) {
            finalUsage = {
              input: parsed.usageMetadata.promptTokenCount ?? 0,
              output: parsed.usageMetadata.candidatesTokenCount ?? 0,
              cacheRead: parsed.usageMetadata.cachedContentTokenCount,
            }
          }
          const candidate = parsed.candidates?.[0]
          if (!candidate) return null

          if (typeof candidate.finishReason === 'string') {
            finalStopReason = candidate.finishReason
          }

          const chunks: StreamChunk[] = []
          for (const part of candidate.content?.parts ?? []) {
            if (part.thought && part.text) {
              chunks.push({ type: 'thinking_delta', text: part.text })
              continue
            }
            if (part.text) {
              chunks.push({ type: 'text_delta', text: part.text })
              continue
            }
            if (part.functionCall) {
              const id = part.functionCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`
              const providerItem = part.thoughtSignature
                ? { functionCall: part.functionCall, thoughtSignature: part.thoughtSignature }
                : undefined
              chunks.push({
                type: 'tool_use_start',
                id,
                name: part.functionCall.name,
                providerItem,
              })
              chunks.push({
                type: 'tool_use_delta',
                id,
                name: part.functionCall.name,
                input: part.functionCall.args ?? {},
                providerItem,
              })
              chunks.push({ type: 'tool_use_end', id })
            }
          }
          return chunks.length > 0 ? chunks : null
        } catch {
          return null
        }
      },

      emitMessageEnd(): StreamChunk {
        return {
          type: 'message_end',
          stopReason: mapFinishReason(finalStopReason),
          ...(finalUsage ? { usage: finalUsage } : {}),
          model: finalModel || 'unknown',
        }
      },

      finalize(): StreamChunk | null {
        return null
      },
    }
  },
}

// Re-export the typed errors for convenience.
export { ProviderAuthError, ProviderContextOverflowError, ProviderRateLimitError }
