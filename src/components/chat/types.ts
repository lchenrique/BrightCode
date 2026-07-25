/**
 * Shared types + helpers for the chat layer.
 *
 * The "Message" shape extends the registry's `ChatMessage` with UI-only
 * fields (model name, error details, tool result summary). The helpers
 * translate between UI message and wire message — the agent loop sees
 * only the wire form.
 */

import type { ChatMessage } from '@/lib/providers'

export type Role = 'user' | 'assistant' | 'system' | 'tool' | 'error'

export interface Message {
  id: string
  role: Role
  content: string
  model?: string
  streaming?: boolean
  /** Extra context for error messages (stack, request url, etc). */
  errorDetails?: string
  /** Tool calls made by the assistant (one bubble can show many). */
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
  /** True once the tool call has been executed and the result fed back. */
  toolResolved?: boolean
  /** Short label for the tool result, e.g. "12 files" or "324 bytes". */
  toolResultSummary?: string
  /** True when the tool call errored (vs a normal return). */
  toolError?: boolean
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
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: [
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...m.toolCalls.map((tc) => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: (tc.input ?? {}) as Record<string, unknown>,
        })),
      ],
    }
  }
  return { role: m.role as 'user' | 'assistant' | 'system', content: m.content }
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
