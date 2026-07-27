/**
 * Agent runner — executes a delegated task as a conversation loop and yields
 * progress events back to the orchestrator.
 *
 * When the orchestrator calls a delegate_* tool, this function:
 *   1. Loads the agent definition from the store
 *   2. Builds the agent's system prompt + task context
 *   3. Filters tools to the agent's allowed subset
 *   4. Runs a conversation loop via providerRegistry.stream()
 *   5. Executes tool calls and feeds results back into the loop
 *   6. Yields AgentProgress events for streaming UI updates
 */

import type { ChatMessage, StreamChunk, ToolDefinition } from '@/lib/providers/types'
import { providerRegistry } from '@/lib/providers/registry'
import { agentStore, type AgentDefinition } from './store'
import { AGENT_TOOLS } from './tools'

export interface AgentTask {
  agentId: string
  task: string
  context?: string
}

export interface AgentProgress {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'text' | 'done' | 'error'
  agentId: string
  agentName: string
  text?: string
  toolName?: string
  toolInput?: unknown
  toolResult?: string
  error?: string
  /** Optional: the model's own reasoning trace (Anthropic extended thinking,
   *  OpenAI o-series reasoning, Gemini 2.5 thinking, etc). The orchestrator
   *  surfaces this in the delegated task's timeline so the user can see why
   *  the sub-agent made each call. */
  thinking?: string
}

interface ToolCall {
  id: string
  name: string
  input: unknown
  providerItem?: Record<string, unknown>
}

function executeTool(
  name: string,
  input: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!api) {
    return Promise.resolve({ ok: false, error: 'Not running in Electron — tools unavailable' })
  }
  return api.tools.execute(
    name as Parameters<typeof api.tools.execute>[0],
    input as never,
  ) as Promise<{ ok: boolean; result?: unknown; error?: string }>
}

function buildMessages(
  agent: AgentDefinition,
  task: string,
  context?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = []

  if (agent.systemPrompt) {
    messages.push({ role: 'system', content: agent.systemPrompt })
  }

  const userContent = context
    ? `Context: ${context}\n\nTask: ${task}`
    : task

  messages.push({ role: 'user', content: userContent })

  return messages
}

function filterTools(allowedNames: string[]): ToolDefinition[] {
  const set = new Set(allowedNames)
  return AGENT_TOOLS.filter((t) => set.has(t.name))
}

function toolResultToMessage(
  toolId: string,
  toolName: string,
  ok: boolean,
  result: unknown,
  error?: string,
): ChatMessage {
  const content = ok
    ? typeof result === 'string'
      ? result
      : JSON.stringify(result, null, 2)
    : `Error: ${error ?? 'unknown error'}`

  return {
    role: 'tool',
    toolCallId: toolId,
    toolName,
    content,
  }
}

export async function* runAgent(
  task: AgentTask,
  options?: { signal?: AbortSignal },
): AsyncIterable<AgentProgress> {
  const agent = agentStore.get(task.agentId)

  if (!agent) {
    yield {
      type: 'error',
      agentId: task.agentId,
      agentName: 'unknown',
      error: `Agent "${task.agentId}" not found`,
    }
    return
  }

  if (!agent.enabled) {
    yield {
      type: 'error',
      agentId: agent.id,
      agentName: agent.name,
      error: `Agent "${agent.name}" is disabled`,
    }
    return
  }

  const messages = buildMessages(agent, task.task, task.context)
  const tools = filterTools(agent.tools)
  const model = agent.model

  yield { type: 'thinking', agentId: agent.id, agentName: agent.name }

  let finalText = ''
  let hasError = false

  try {
    // ── Conversation loop ───────────────────────────────────────────────
    for (let round = 0; round < 20; round++) {
      if (options?.signal?.aborted) {
        yield {
          type: 'error',
          agentId: agent.id,
          agentName: agent.name,
          error: 'Aborted',
        }
        return
      }

      const toolCalls: ToolCall[] = []
      const toolInputs = new Map<string, string>()
      let stopReason = 'end_turn'
      let assistantText = ''

      for await (const chunk of providerRegistry.stream(model, {
        model,
        messages,
        tools,
        maxTokens: 4096,
        temperature: 0.7,
        signal: options?.signal,
      }, agent.accountId)) {
        if (options?.signal?.aborted) break

        if (chunk.type === 'error') {
          yield {
            type: 'error',
            agentId: agent.id,
            agentName: agent.name,
            error: chunk.error.message,
          }
          return
        }

        accumulateChunk(chunk, { toolCalls, toolInputs })

        if (chunk.type === 'text_delta') {
          assistantText += chunk.text
          yield {
            type: 'text',
            agentId: agent.id,
            agentName: agent.name,
            text: chunk.text,
          }
        }

        if (chunk.type === 'thinking_delta') {
          // Surface the sub-agent's reasoning trace so the orchestrator
          // can render it in the delegated task timeline.
          yield {
            type: 'thinking',
            agentId: agent.id,
            agentName: agent.name,
            thinking: chunk.text,
          }
        }

        if (chunk.type === 'message_end') {
          stopReason = chunk.stopReason
        }
      }

      if (options?.signal?.aborted) break

      // ── Build assistant message ──────────────────────────────────────
      const assistantContent: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown; providerItem?: Record<string, unknown> }
      > = []

      if (assistantText) {
        assistantContent.push({ type: 'text', text: assistantText })
      }

      for (const tc of toolCalls) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
          ...(tc.providerItem ? { providerItem: tc.providerItem } : {}),
        })
      }

      messages.push({
        role: 'assistant',
        content: assistantContent,
      })

      // ── Stop if no tools or model is done ────────────────────────────
      if (toolCalls.length === 0 || stopReason !== 'tool_use') {
        finalText = assistantText.trim()
        break
      }

      // ── Execute tools ────────────────────────────────────────────────
      for (const tc of toolCalls) {
        yield {
          type: 'tool_start',
          agentId: agent.id,
          agentName: agent.name,
          toolName: tc.name,
          toolInput: tc.input,
        }

        const exec = await executeTool(tc.name, tc.input)
        const ok = exec.ok === true

        yield {
          type: 'tool_end',
          agentId: agent.id,
          agentName: agent.name,
          toolName: tc.name,
          toolResult: ok
            ? typeof exec.result === 'string'
              ? exec.result
              : JSON.stringify(exec.result)
            : exec.error,
        }

        messages.push(
          toolResultToMessage(tc.id, tc.name, ok, exec.result, exec.error),
        )
      }
    }
  } catch (err) {
    hasError = true
    yield {
      type: 'error',
      agentId: agent.id,
      agentName: agent.name,
      error: err instanceof Error ? err.message : String(err),
    }
    return
  }

  if (!hasError) {
    yield {
      type: 'done',
      agentId: agent.id,
      agentName: agent.name,
      text: finalText,
    }
  }
}

// ── Chunk accumulation helper ────────────────────────────────────────────

interface AccumulatorState {
  toolCalls: ToolCall[]
  toolInputs: Map<string, string>
}

function accumulateChunk(chunk: StreamChunk, state: AccumulatorState): void {
  if (chunk.type === 'tool_use_start') {
    state.toolCalls.push({
      id: chunk.id,
      name: chunk.name,
      input: {},
      ...(chunk.providerItem ? { providerItem: chunk.providerItem } : {}),
    })
    return
  }

  if (chunk.type === 'tool_use_delta') {
    const pending = state.toolCalls.find((tc) => tc.id === chunk.id)
    if (pending && chunk.input !== undefined) {
      pending.input = chunk.input
      try {
        state.toolInputs.set(chunk.id, JSON.stringify(chunk.input))
      } catch {
        // Non-serializable input — keep the raw object.
      }
    }
    return
  }

  if (chunk.type === 'tool_use_end') {
    // No additional data to accumulate on tool_use_end.
  }
}
