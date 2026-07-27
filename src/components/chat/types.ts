/**
 * Shared types + helpers for the chat layer.
 *
 * The "Message" shape extends the registry's `ChatMessage` with UI-only
 * fields (model name, error details, tool result summary). The helpers
 * translate between UI message and wire message — the agent loop sees
 * only the wire form.
 */

import type { ChatMessage, ContentBlock } from '@/lib/providers'

export type Role = 'user' | 'assistant' | 'system' | 'tool' | 'error'

export interface Message {
  id: string
  role: Role
  content: string
  /**
   * Optional multimodal content blocks (images, etc). When set, this is
   * what gets sent to the model; `content` is the text-only transcript
   * used by the UI. Persisted alongside `content` so the original
   * payload survives reloads.
   */
  contentBlocks?: ContentBlock[]
  /** Internal thinking / reasoning trace. */
  thinking?: string
  model?: string
  streaming?: boolean
  /** Extra context for error messages (stack, request url, etc). */
  errorDetails?: string
  /** Tool calls made by the assistant (one bubble can show many). */
  toolCalls?: Array<{
    id: string
    name: string
    input: unknown
    providerItem?: Record<string, unknown>
  }>
  /** Stateless provider output that must survive task persistence. */
  providerOutputItems?: Array<Record<string, unknown>>
  /** True once the tool call has been executed and the result fed back. */
  toolResolved?: boolean
  /** Short label for the tool result, e.g. "12 files" or "324 bytes". */
  toolResultSummary?: string
  /** True when the tool call errored (vs a normal return). */
  toolError?: boolean
  /** True if the user clicked Stop before the tool finished. */
  toolStopped?: boolean
  /** True when the assistant turn was cut short by the user. */
  stopped?: boolean
  /** True when this tool result comes from an agent delegation. */
  isAgentResult?: boolean
  /** The display name of the agent that produced this result. */
  agentName?: string
  /** DiceBear avatar seed of the agent. */
  agentAvatarSeed?: string
  /**
   * Sub-agent reasoning trace (Anthropic extended thinking, OpenAI o-series
   * reasoning, Gemini thinking, …). Captured live from the delegated task
   * and shown as a collapsible "Thought" block in the timeline.
   */
  agentThinking?: string
}

/**
 * Restore the invariant required by tool-calling APIs: every assistant tool
 * call must be followed by exactly one result before the conversation moves
 * on. Older BrightCode builds could persist only part of a parallel batch.
 */
export function repairIncompleteToolHistory(messages: Message[]): Message[] {
  const repaired: Message[] = []
  let changed = false

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    repaired.push(message)

    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      continue
    }

    const resolvedIds = new Set<string>()
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      const toolMessage = messages[cursor]!
      repaired.push(toolMessage)
      const resolvedId = toolMessage.toolCalls?.[0]?.id
      if (resolvedId) resolvedIds.add(resolvedId)
      cursor += 1
    }

    for (const toolCall of message.toolCalls) {
      if (resolvedIds.has(toolCall.id)) continue
      changed = true
      repaired.push({
        id: `recovered-${message.id}-${toolCall.id}`,
        role: 'tool',
        content:
          'Error: the previous tool execution was interrupted or its result was not persisted. Retry the tool if it is still needed.',
        toolResolved: true,
        toolResultSummary: 'result unavailable — retry if needed',
        toolError: true,
        toolCalls: [toolCall],
      })
    }

    index = cursor - 1
  }

  return changed ? repaired : messages
}

// ── Wire translation (UI Message → ChatMessage for the model) ──────────

export function toChatMessage(m: Message): ChatMessage {
  if (m.role === 'error') {
    return { role: 'user', content: m.content }
  }
  if (m.role === 'tool') {
    return {
      role: 'tool',
      toolCallId: m.toolCalls?.[0]?.id,
      toolName: m.toolCalls?.[0]?.name,
      content: m.content,
    }
  }
  if (m.role === 'user' && m.contentBlocks && m.contentBlocks.length > 0) {
    // Multimodal user message — replay the full content blocks to the
    // model. The format handlers translate per-provider.
    return {
      role: 'user',
      content: m.contentBlocks,
    }
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: [
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...(m.thinking
          ? [{ type: 'thinking' as const, text: m.thinking }]
          : []),
        ...m.toolCalls.map((tc) => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: (tc.input ?? {}) as Record<string, unknown>,
          ...(tc.providerItem ? { providerItem: tc.providerItem } : {}),
        })),
      ],
      providerOutputItems: m.providerOutputItems,
      reasoningContent: m.thinking ?? '',
    }
  }
  return {
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
    providerOutputItems: m.providerOutputItems,
    ...(m.role === 'assistant' ? { reasoningContent: m.thinking ?? '' } : {}),
  }
}

export function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function summarizeToolResult(name: string, result: unknown): string {
  if (name === 'list_files' && Array.isArray(result)) {
    const dirs = result.filter((e: { isDir?: boolean }) => e.isDir).length
    const files = result.filter((e: { isDir?: boolean }) => !e.isDir).length
    return `${dirs} dir${dirs === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}`
  }
  if (name === 'read_file' && typeof result === 'string') {
    return `${result.length} chars`
  }
  if (
    name === 'write_file' &&
    result &&
    typeof result === 'object' &&
    'bytes' in result
  ) {
    return `${(result as { bytes: number }).bytes} bytes written`
  }
  if (
    name === 'edit_file' &&
    result &&
    typeof result === 'object' &&
    'replacements' in result
  ) {
    const r = (result as { replacements: number }).replacements
    return `${r} replacement${r === 1 ? '' : 's'}`
  }
  if (name === 'search_files' && Array.isArray(result)) {
    return `${result.length} match${result.length === 1 ? '' : 'es'}`
  }
  if (name === 'list_skills' && Array.isArray(result)) {
    return `${result.length} skill${result.length === 1 ? '' : 's'}`
  }
  if (
    (name === 'read_skill' || name === 'read_skill_file') &&
    result &&
    typeof result === 'object' &&
    'content' in result &&
    typeof result.content === 'string'
  ) {
    return `${result.content.length} chars`
  }
  if (
    name === 'bash' &&
    result &&
    typeof result === 'object' &&
    'exitCode' in result
  ) {
    const r = result as { exitCode: number; durationMs?: number }
    const ms = r.durationMs ? ` in ${r.durationMs}ms` : ''
    return r.exitCode === 0 ? `exit 0${ms}` : `exit ${r.exitCode}${ms}`
  }
  return 'done'
}

export function formatErrorDetails(err: unknown): string {
  if (err === null || err === undefined) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) {
    const lines: string[] = [
      `Name:    ${err.name}`,
      `Message: ${err.message}`,
    ]
    if (err.stack) {
      lines.push('Stack:')
      lines.push(err.stack)
    }
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause) {
      lines.push('---')
      lines.push('Caused by:')
      lines.push(formatErrorDetails(cause))
    }
    return lines.join('\n')
  }
  try {
    return JSON.stringify(err, null, 2)
  } catch {
    return String(err)
  }
}
