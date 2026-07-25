/**
 * ChatSurface — the chat headless component.
 *
 * Owns the conversation state and the agent loop:
 *   1. Stream the model
 *   2. If the model calls tools, run them in the main process
 *   3. Feed results back and keep streaming
 *   4. Repeat until `stopReason !== 'tool_use'`
 *
 * Does NOT own the layout — the parent decides where the message list
 * and input live. The `WelcomeScreen` and `ProjectView` both wrap this
 * with their own layout (centered vs split with progress panel).
 *
 * The `onToolCall` callback lets the parent react to each tool call —
 * ProjectView uses it to drive the "Edited N files" card.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatInput, type ModelGroup } from '@/components/home/ChatInput'
import { MessageBubble } from './MessageBubble'
import { AssistantTurn } from './AssistantTurn'
import {
  formatErrorDetails,
  serializeToolResult,
  summarizeToolResult,
  toChatMessage,
  type Message,
} from './types'
import {
  providerRegistry,
  type ChatMessage,
  type StreamChunk,
} from '@/lib/providers'
import {
  useAvailableModels,
  useAvailableModelsGrouped,
  useDefaultModel,
} from '@/hooks/use-provider-registry'
import { useActiveProject } from '@/hooks/use-projects'
import { buildSystemPrompt } from '@/lib/agents/system-prompt'
import { AGENT_TOOLS } from '@/lib/agents/tools'
import type { Project } from '@/lib/projects/store'

const MAX_TURNS = 8

export interface ChatSurfaceProps {
  /** Optional task id — when set, loads and persists messages via IPC. */
  taskId?: string
  /** Optional project — when set, gets injected into the system prompt. */
  project?: Project | null
  /** Override the model picker (e.g. pin a specific model). */
  selectedModelOverride?: string
  /**
   * Fired once per tool_use_start. Used by the project view to track
   * which files were edited for the "Edited N files" card.
   */
  onToolCall?: (tc: { id: string; name: string; input: unknown }) => void
  /**
   * Fired once per tool result. The project view uses this to clear
   * the "running" indicator.
   */
  onToolResult?: (
    tc: { id: string; name: string },
    outcome: { ok: boolean; result?: unknown; error?: string },
  ) => void
  /**
   * If set on mount, the chat auto-sends this message exactly once.
   * Used by TaskView to "carry over" the first message the user typed
   * in the welcome screen — without it, the user would have to retype
   * the same message in the task view. A ref guard prevents the auto-
   * send from re-firing if `initialMessage` reference changes during
   * re-renders.
   */
  initialMessage?: string | null
  /**
   * Fired once after the initial auto-send completes. Lets the parent
   * clear the pending message from the store / state.
   */
  onInitialMessageSent?: () => void
}

export function ChatSurface({
  taskId,
  project,
  selectedModelOverride,
  onToolCall,
  onToolResult,
  initialMessage,
  onInitialMessageSent,
}: ChatSurfaceProps) {
  // Reactive model catalog from the registry
  const available = useAvailableModels()
  const grouped = useAvailableModelsGrouped()
  const defaultModel = useDefaultModel()
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [thinking, setThinking] = useState(true)
  const [authMode, setAuthMode] = useState<'full' | 'read'>('full')
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  // The project is read fresh from the sidebar on each submit; we also
  // accept it as a prop override so callers can pin a specific project.
  const sidebarProject = useActiveProject()
  const effectiveProject = project ?? sidebarProject

  const [isLoaded, setIsLoaded] = useState(!taskId)

  // ── Auto-scroll to bottom ───────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 140
  }

  const scrollToBottom = (instant = false) => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: instant ? 'instant' : 'smooth',
    })
  }

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom(isStreaming)
    }
  }, [messages, isStreaming])

  // Load stored messages when mounting or changing task id
  useEffect(() => {
    if (taskId && typeof window !== 'undefined' && window.electronAPI?.tasks) {
      setIsLoaded(false)
      void window.electronAPI.tasks.getMessages<Message>(taskId).then((loaded) => {
        if (Array.isArray(loaded) && loaded.length > 0) {
          setMessages(loaded)
        }
        setIsLoaded(true)
      })
    } else {
      setIsLoaded(true)
    }
  }, [taskId])

  // Save messages to persistent store when changed
  useEffect(() => {
    if (taskId && messages.length > 0 && typeof window !== 'undefined' && window.electronAPI?.tasks) {
      void window.electronAPI.tasks.saveMessages(taskId, messages)
    }
  }, [taskId, messages])

  // Translate the registry's grouped shape into the shape the ChatInput wants
  const modelGroups = useMemo<ModelGroup[]>(
    () =>
      grouped.map((g) => ({
        providerId: g.provider.id,
        providerName: g.provider.name,
        hasCredential: g.hasCredential,
        models: g.models,
      })),
    [grouped],
  )

  // Keep selection valid when the catalog changes. Functional update + no
  // `selectedModel` in deps so we don't bounce.
  useEffect(() => {
    setSelectedModel((prev) => {
      if (selectedModelOverride) return selectedModelOverride
      if (prev && available.some((m) => `${m.provider}/${m.id}` === prev)) return prev
      if (defaultModel) return `${defaultModel.provider}/${defaultModel.id}`
      return prev
    })
  }, [available, defaultModel, selectedModelOverride])

  const hasAnyModel = available.length > 0

  // ── Agent loop ──────────────────────────────────────────────────────

  const messagesRef = useRef<Message[]>([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  function getAssistantText(id: string): string {
    return messagesRef.current.find((m) => m.id === id)?.content ?? ''
  }

  // Auto-send the initial message exactly once. The ref guard means
  // re-renders that pass the same `initialMessage` won't re-trigger
  // the send. We also wait for `selectedModel` to be populated and for
  // saved task messages to finish loading from disk (`isLoaded`).
  const initialSentRef = useRef(false)
  useEffect(() => {
    if (!isLoaded) return
    if (initialSentRef.current) return
    if (!initialMessage) return
    if (!selectedModel) return
    if (messages.length > 0) return
    if (isStreaming) return
    initialSentRef.current = true
    onInitialMessageSent?.()
    void handleSubmit(initialMessage)
  }, [isLoaded, initialMessage, selectedModel, messages.length, isStreaming])

  const applyChunk = (
    id: string,
    chunk: StreamChunk,
    buffers: {
      toolCalls: Array<{ id: string; name: string; input: unknown }>
      toolInputs: Map<string, string>
    },
  ) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m
        switch (chunk.type) {
          case 'text_delta':
            return { ...m, content: m.content + chunk.text }
          case 'thinking_delta':
            return { ...m, content: m.content + chunk.text }
          case 'tool_use_start':
            if (!buffers.toolCalls.some((x) => x.id === chunk.id)) {
              buffers.toolCalls.push({ id: chunk.id, name: chunk.name, input: {} })
              onToolCall?.({ id: chunk.id, name: chunk.name, input: {} })
            }
            return m
          case 'tool_use_delta': {
            const tc = buffers.toolCalls.find((x) => x.id === chunk.id)
            const prevArgs = buffers.toolInputs.get(chunk.id) ?? ''
            const next = typeof chunk.input === 'string' ? chunk.input : prevArgs
            buffers.toolInputs.set(chunk.id, next)
            if (tc) tc.input = chunk.input ?? tc.input
            return m
          }
          case 'tool_use_end': {
            const tc = buffers.toolCalls.find((x) => x.id === chunk.id)
            const raw = buffers.toolInputs.get(chunk.id)
            if (tc && raw) {
              try {
                tc.input = JSON.parse(raw)
              } catch {
                // leave as-is
              }
            }
            return m
          }
          case 'message_end':
            return { ...m, model: chunk.model }
          case 'error':
            return {
              ...m,
              role: 'error',
              content: m.content + (chunk.error.message ?? 'unknown error'),
              streaming: false,
            }
          default:
            return m
        }
      }),
    )
  }

  const handleSubmit = async (text: string) => {
    if (isStreaming) return
    if (!selectedModel) return

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    }

    const baseMessages = [...messagesRef.current, userMsg]
    setMessages(baseMessages)
    setIsStreaming(true)

    const convo: ChatMessage[] = baseMessages.map((m) => toChatMessage(m))

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const assistantId = crypto.randomUUID()
        const assistantMsg: Message = {
          id: assistantId,
          role: 'assistant',
          content: '',
          streaming: true,
        }
        setMessages((prev) => [...prev, assistantMsg])

        const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
        const toolInputs = new Map<string, string>()
        let stopReason: string = 'end_turn'
        let assistantModel = ''

        for await (const chunk of providerRegistry.stream(selectedModel, {
          model: selectedModel,
          messages: convo,
          systemPrompt: buildSystemPrompt({ project: effectiveProject }),
          tools: AGENT_TOOLS,
          thinking: thinking ? 'medium' : 'off',
          maxTokens: 4096,
          temperature: 0.7,
        })) {
          applyChunk(assistantId, chunk, { toolCalls, toolInputs })
          if (chunk.type === 'message_end') {
            stopReason = chunk.stopReason
            assistantModel = chunk.model
          }
        }

        convo.push({
          role: 'assistant',
          content:
            toolCalls.length > 0
              ? ([
                  ...(getAssistantText(assistantId)
                    ? [{ type: 'text' as const, text: getAssistantText(assistantId) }]
                    : []),
                  ...toolCalls.map((tc) => ({
                    type: 'tool_use' as const,
                    id: tc.id,
                    name: tc.name,
                    input: (tc.input ?? {}) as Record<string, unknown>,
                  })),
                ] as Array<
                  | { type: 'text'; text: string }
                  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
                >)
              : (getAssistantText(assistantId) || ''),
        })

        if (toolCalls.length === 0 || stopReason !== 'tool_use') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, model: assistantModel || m.model }
                : m,
            ),
          )
          break
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, toolCalls, streaming: false, model: assistantModel || m.model }
              : m,
          ),
        )

        for (const tc of toolCalls) {
          const toolResultId = crypto.randomUUID()
          const exec = await window.electronAPI?.tools.execute(
            tc.name as Parameters<
              NonNullable<typeof window.electronAPI>['tools']['execute']
            >[0],
            tc.input as never,
          )
          const ok = exec?.ok === true
          const result = ok ? exec.result : null
          const error =
            !ok && exec && exec.ok === false ? exec.error : 'unknown error'
          const summary = ok ? summarizeToolResult(tc.name, result) : (error ?? 'error')

          onToolResult?.({ id: tc.id, name: tc.name }, { ok, result, error })

          setMessages((prev) => [
            ...prev,
            {
              id: toolResultId,
              role: 'tool',
              content: ok ? serializeToolResult(result) : `Error: ${error}`,
              toolResolved: true,
              toolResultSummary: summary,
              toolError: !ok,
              toolCalls: [{ id: tc.id, name: tc.name, input: tc.input }],
            },
          ])

          convo.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: ok ? serializeToolResult(result) : `Error: ${error}`,
          })
        }
      }
    } catch (err) {
      const detail = {
        model: selectedModel,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cause: err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined,
      }
      console.error('[chat] stream failed', detail)
      window.electronAPI?.log('error', ['[chat] stream failed', detail])
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'error',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          errorDetails: formatErrorDetails(err),
        },
      ])
    } finally {
      setIsStreaming(false)
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Message list — owns the scroll */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {messages.length === 0 ? (
            <ChatEmptyState />
          ) : (
            <MessageList messages={messages} isStreaming={isStreaming} />
          )}
        </div>
      </div>

      {/* Input pinned at bottom */}
      <div className="shrink-0 px-6 pt-2 pb-4">
        <div className="mx-auto max-w-3xl">
          <ChatInput
            onSend={handleSubmit}
            disabled={isStreaming || !hasAnyModel}
            thinking={thinking}
            onThinkingChange={setThinking}
            authMode={authMode}
            onAuthModeChange={setAuthMode}
            modelGroups={modelGroups}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            emptyModelMessage="No models — open Settings"
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Groups the flat message list into the shape the user actually sees:
 *  - `user`     — rendered directly
 *  - `assistant` + trailing `tool` messages — rendered as a single
 *                  AssistantTurn (collapsible "Thought N" header +
 *                  vertical tool timeline)
 *  - `tool` with no preceding assistant (shouldn't happen but defend
 *                  against it) — rendered as a plain MessageBubble
 *  - `error`    — rendered as a MessageBubble
 *  - `system`   — rendered as a MessageBubble
 *
 * Doing the grouping here (vs. in the agent loop) keeps the state shape
 * flat and easy to persist later.
 */
function MessageList({
  messages,
  isStreaming,
}: {
  messages: Message[]
  isStreaming: boolean
}) {
  const items: Array<
    | { kind: 'msg'; message: Message; compact?: boolean }
    | { kind: 'turn'; assistant: Message; tools: Message[]; streaming: boolean }
  > = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant') {
      const tools: Message[] = []
      let j = i + 1
      while (j < messages.length && messages[j]!.role === 'tool') {
        tools.push(messages[j]!)
        j++
      }
      // The currently-streaming assistant message is the one we just
      // appended; the Agent loop only sets `streaming: false` after
      // tool execution finishes. So if streaming is true and the
      // assistant has no tool calls yet, we still want the spinner.
      const hasToolCalls = (m.toolCalls?.length ?? 0) > 0
      const streaming =
        isStreaming && (!!m.streaming || !hasToolCalls)

      // ALWAYS render the turn for an assistant message — even for a
      // pure text reply, the "Thought N time(s)" header represents the
      // agent's processing and must stay visible after the response
      // finishes. Wrapping a finished text-only reply in a turn was
      // hiding the response inside a collapsible thing the user had
      // to click to read.
      items.push({ kind: 'turn', assistant: m, tools, streaming })

      // The text response goes OUTSIDE the turn, as a compact bubble
      // immediately below. This matches the design intent: the turn
      // represents thinking + tool execution, the text is the agent's
      // final answer. They are conceptually different and shouldn't
      // be visually fused. The `compact` flag tells MessageBubble to
      // skip the model-name label and tool-call list (those are owned
      // by the turn).
      if (m.content || m.streaming) {
        items.push({ kind: 'msg', message: m, compact: true })
      }

      i = j - 1
    } else {
      items.push({ kind: 'msg', message: m })
    }
  }

  return (
    <>
      {items.map((it) => {
        if (it.kind === 'msg') {
          return (
            <MessageBubble
              key={it.message.id + (it.compact ? ':reply' : '')}
              message={it.message}
              compact={it.compact}
            />
          )
        }
        return (
          <AssistantTurn
            key={it.assistant.id}
            assistant={it.assistant}
            toolMessages={it.tools}
            streaming={it.streaming}
          />
        )
      })}
    </>
  )
}

function ChatEmptyState() {
  return (
    <div className="text-muted-foreground/80 flex flex-col items-center gap-2 py-12 text-center text-[13px]">
      <p>Send a message to get started.</p>
    </div>
  )
}
