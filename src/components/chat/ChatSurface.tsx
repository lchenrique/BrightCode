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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Layers3 } from 'lucide-react'
import { ChatInput, type ModelGroup } from '@/components/home/ChatInput'
import { MessageBubble } from './MessageBubble'
import { AssistantTurn } from './AssistantTurn'
import {
  formatErrorDetails,
  repairIncompleteToolHistory,
  serializeToolResult,
  summarizeToolResult,
  toChatMessage,
  type Message,
} from './types'
import {
  providerRegistry,
  type ChatMessage,
  type ModelInfo,
  type StreamChunk,
} from '@/lib/providers'
import {
  useAvailableModels,
  useAvailableModelsGrouped,
  useDefaultModel,
} from '@/hooks/use-provider-registry'
import { useActiveProject } from '@/hooks/use-projects'
import { useTask, useTasksActions } from '@/hooks/use-tasks'
import { setTaskActivity, clearTaskActivity } from '@/hooks/use-task-activity'
import { tasksStore } from '@/lib/tasks/store'
import {
  buildBrightMemoryPrompt,
  buildSystemPrompt,
} from '@/lib/agents/system-prompt'
import { getAllTools } from '@/lib/agents/tools'
import { agentStore } from '@/lib/agents'
import { runAgent, type AgentTask } from '@/lib/agents/runner'
import { agentTaskId, appendAgentTranscript, type AgentTranscriptMessage } from '@/lib/agents/transcript'
import {
  readLastSelectedModel,
  saveLastSelectedModel,
} from '@/lib/agents/model-preference'
import type { Project } from '@/lib/projects/store'
import { notifyProjectFilesChanged } from '@/lib/projects/file-events'

const MAX_TURNS = 8
const STREAM_UI_FLUSH_MS = 40

function toolInputPath(input: unknown): string | undefined {
  if (
    input &&
    typeof input === 'object' &&
    'path' in input &&
    typeof input.path === 'string' &&
    input.path.trim()
  ) {
    return input.path.trim()
  }
  return undefined
}

function buildLocalCompletion(
  userText: string,
  changedPaths: string[],
  failedTools: number,
): string {
  const portuguese =
    /[áàâãéêíóôõúç]|\b(agora|arquivo|cria|crie|faz|faça|loja|projeto|tenta)\b/i.test(
      userText,
    )

  if (changedPaths.length > 0) {
    const uniquePaths = [...new Set(changedPaths)]
    const heading = portuguese
      ? 'Concluído. Arquivos criados ou atualizados:'
      : 'Completed. Files created or updated:'
    const failureNote =
      failedTools > 0
        ? portuguese
          ? `\n\n${failedTools} ferramenta${failedTools === 1 ? '' : 's'} falhou durante a execução.`
          : `\n\n${failedTools} tool${failedTools === 1 ? '' : 's'} failed during execution.`
        : ''
    return `${heading}\n\n${uniquePaths.map((path) => `- \`${path}\``).join('\n')}${failureNote}`
  }

  if (failedTools > 0) {
    return portuguese
      ? `Não consegui concluir a solicitação: ${failedTools} ferramenta${failedTools === 1 ? '' : 's'} falhou.`
      : `I could not complete the request: ${failedTools} tool${failedTools === 1 ? '' : 's'} failed.`
  }

  return portuguese
    ? 'O modelo encerrou a execução sem enviar uma resposta final. Tente novamente.'
    : 'The model finished without sending a final response. Please try again.'
}

function repairTrailingEmptyAssistant(messages: Message[]): Message[] {
  const last = messages.at(-1)
  if (
    !last ||
    last.role !== 'assistant' ||
    last.content.trim() ||
    (last.toolCalls?.length ?? 0) > 0
  ) {
    return messages
  }

  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  if (latestUserIndex < 0) return messages

  const changedPaths: string[] = []
  let failedTools = 0
  for (const message of messages.slice(latestUserIndex + 1)) {
    if (message.role !== 'tool') continue
    if (message.toolError) failedTools += 1

    const toolCall = message.toolCalls?.[0]
    const changedPath = toolInputPath(toolCall?.input)
    if (
      !message.toolError &&
      changedPath &&
      (toolCall?.name === 'write_file' || toolCall?.name === 'edit_file')
    ) {
      changedPaths.push(changedPath)
    }
  }

  const userText = messages[latestUserIndex]?.content ?? ''
  return messages.map((message) =>
    message.id === last.id
      ? {
          ...message,
          content: buildLocalCompletion(userText, changedPaths, failedTools),
          streaming: false,
        }
      : message,
  )
}

function modelIdFromSelection(selectedModel: string): string {
  const separator = selectedModel.indexOf('/')
  return separator >= 0 ? selectedModel.slice(separator + 1) : selectedModel
}

interface ContextCompaction {
  summary: string
  omittedMessages: number
}

interface ContextWindowStatus {
  afterMessageId: string
  estimatedTokens: number
  contextWindow: number
  usageRatio: number
  compactedMessages: number
  summary?: string
}

interface PreparedConversationContext {
  messages: ChatMessage[]
  estimatedTokens: number
  contextWindow: number
  usageRatio: number
  compaction?: ContextCompaction
}

/**
 * Build a portable model context without changing the visible conversation.
 *
 * Tool-call transcripts are provider-native state. Replaying a GPT Responses
 * tool call into DeepSeek (or vice versa) is both wasteful and, for some
 * gateways, invalid. Text-only user/assistant messages remain portable.
 */
function prepareConversationContext(
  messages: Message[],
  selectedModel: string,
  modelInfo?: ModelInfo,
): PreparedConversationContext {
  const targetModel = modelIdFromSelection(selectedModel)
  const groups: Message[][] = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'error') continue

    if (message.role === 'assistant') {
      const group = [message]
      let cursor = index + 1
      while (cursor < messages.length && messages[cursor]?.role === 'tool') {
        group.push(messages[cursor]!)
        cursor += 1
      }
      index = cursor - 1

      const hasToolState =
        (message.toolCalls?.length ?? 0) > 0 || group.some((item) => item.role === 'tool')
      const sameModel = !message.model || message.model === targetModel
      if (hasToolState && !sameModel) continue
      // Interrupted streams can leave an empty assistant placeholder in
      // persistence. Some OpenAI-compatible gateways reject that message
      // shape outright, so never include it in a future request.
      if (!hasToolState && !message.content.trim()) continue

      groups.push(group)
      continue
    }

    // An orphan tool result cannot be replayed safely.
    if (message.role === 'tool') continue
    groups.push([message])
  }

  // Approximate room for the system prompt and tool schemas. Source code
  // averages fewer characters per token than prose, so use a conservative
  // two characters per context token and cap very large advertised windows.
  const contextWindow = modelInfo?.contextWindow ?? 128_000
  const characterBudget = Math.max(
    40_000,
    Math.min(600_000, Math.floor(contextWindow * 2)),
  )
  const selectedGroups: Message[][] = []
  let usedCharacters = 0
  let firstSelectedIndex = groups.length

  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!
    const groupSize = JSON.stringify(group).length
    const containsLatestUser =
      index === groups.length - 1 && group.some((message) => message.role === 'user')

    if (!containsLatestUser && usedCharacters + groupSize > characterBudget) {
      break
    }

    selectedGroups.push(group)
    usedCharacters += groupSize
    firstSelectedIndex = index
  }

  selectedGroups.reverse()
  const omittedGroups = groups.slice(0, firstSelectedIndex)
  const compaction =
    omittedGroups.length > 0
      ? {
          summary: summarizeCompactedContext(omittedGroups),
          omittedMessages: omittedGroups.flat().length,
        }
      : undefined
  const estimatedTokens = Math.ceil(
    (usedCharacters + (compaction?.summary.length ?? 0)) / 3,
  )

  return {
    messages: selectedGroups.flat().map((message) => toChatMessage(message)),
    estimatedTokens,
    contextWindow,
    usageRatio: Math.min(1, estimatedTokens / contextWindow),
    compaction,
  }
}

function summarizeCompactedContext(groups: Message[][]): string {
  const messages = groups.flat()
  const conversation: string[] = []
  const changedFiles = new Set<string>()
  let failedTools = 0

  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      const path = toolInputPath(toolCall.input)
      if (
        path &&
        (toolCall.name === 'write_file' || toolCall.name === 'edit_file')
      ) {
        changedFiles.add(path)
      }
    }
    if (message.role === 'tool' && message.toolError) failedTools += 1
  }

  const conversationalMessages = messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  )
  const summaryMessages =
    conversationalMessages.length <= 16
      ? conversationalMessages
      : [
          ...conversationalMessages.slice(0, 4),
          ...conversationalMessages.slice(-12),
        ]

  for (const message of summaryMessages) {
    const content = message.content.replace(/\s+/g, ' ').trim()
    if (!content) continue
    const label = message.role === 'user' ? 'User' : 'Assistant'
    conversation.push(`- ${label}: ${truncateContextText(content, 320)}`)
  }

  const sections = [
    'AUTOMATIC CONTEXT COMPACTION',
    'The following is a durable summary of older conversation history. Treat it as prior context and do not claim these details were lost.',
  ]
  if (conversation.length > 0) {
    sections.push('Recent requests and outcomes from the compacted history:', ...conversation)
  }
  if (changedFiles.size > 0) {
    sections.push(
      `Files previously created or edited: ${[...changedFiles].slice(0, 40).join(', ')}`,
    )
  }
  if (failedTools > 0) {
    sections.push(`Earlier compacted history contained ${failedTools} failed tool call(s).`)
  }
  return sections.join('\n')
}

function truncateContextText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1).trimEnd()}…`
}

export interface ChatSurfaceProps {
  /** Optional task id — when set, loads and persists messages via IPC. */
  taskId?: string
  /** Optional project — when set, gets injected into the system prompt. */
  project?: Project | null
  /** Override the model picker (e.g. pin a specific model). */
  selectedModelOverride?: string
  /** Override the entire system prompt (e.g. agent persona). */
  systemPromptOverride?: string
  /** Restrict available tools to this subset (by name). */
  toolFilter?: string[]
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
   * If set on mount, the chat auto-sends this payload (text + images)
   * exactly once. Used by TaskView to "carry over" the first message
   * the user typed in the welcome screen — without it, the user would
   * have to retype the same message in the task view. A ref guard
   * prevents the auto-send from re-firing if `initialMessage` reference
   * changes during re-renders.
   */
  initialMessage?: {
    text: string
    images: Array<{ id: string; data: string; mediaType: string; name: string; size: number }>
  } | null
  /**
   * Fired once after the initial auto-send completes. Lets the parent
   * clear the pending message from the store / state.
   */
  onInitialMessageSent?: () => void
  /**
   * Opens the chat of a peer agent (a Teams agent). Wired by the parent
   * view so the "Open conversation" button inside the delegation card
   * navigates to the peer's transcript.
   */
  onOpenAgentConversation?: (agentId: string) => void
  /**
   * When this ChatSurface is rendering an agent session, this is the
   * taskId of the session the user is currently looking at. Peer
   * conversations recorded by the orchestrator (Bright) are written
   * to this taskId instead of the legacy `agent-<id>` slot, so the
   * transcript lands in the session the user will reopen.
   */
  agentSessionTaskId?: string
}

export function ChatSurface({
  taskId,
  project,
  selectedModelOverride,
  systemPromptOverride,
  toolFilter,
  onToolCall,
  onToolResult,
  initialMessage,
  onInitialMessageSent,
  onOpenAgentConversation,
  agentSessionTaskId,
}: ChatSurfaceProps) {
  // Reactive model catalog from the registry
  const available = useAvailableModels()
  const grouped = useAvailableModelsGrouped()
  const defaultModel = useDefaultModel()
  const task = useTask(taskId ?? null)
  const { update: updateTask } = useTasksActions()
  const [selectedModel, setSelectedModel] = useState<string>(
    readLastSelectedModel,
  )
  const [selectedAccountId, setSelectedAccountId] = useState<string>()
  const [isModelSelectionLoaded, setIsModelSelectionLoaded] = useState(
    !taskId,
  )
  const [thinking, setThinking] = useState(true)
  const [authMode, setAuthMode] = useState<'full' | 'read'>('full')
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [contextStatus, setContextStatus] =
    useState<ContextWindowStatus | null>(null)
  // The project is read fresh from the sidebar on each submit; we also
  // accept it as a prop override so callers can pin a specific project.
  const sidebarProject = useActiveProject()
  const effectiveProject = project ?? sidebarProject

  const [isLoaded, setIsLoaded] = useState(!taskId)
  const loadedTaskIdRef = useRef<string | null>(null)
  const pendingMessageSaveRef = useRef<{
    taskId: string
    messages: Message[]
  } | null>(null)
  const messageSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messageSaveQueueRef = useRef<Promise<void>>(Promise.resolve())

  const flushPendingMessageSave = useCallback(() => {
    const pending = pendingMessageSaveRef.current
    const tasksApi =
      typeof window !== 'undefined' ? window.electronAPI?.tasks : undefined
    if (!pending || !tasksApi) return

    pendingMessageSaveRef.current = null
    messageSaveQueueRef.current = messageSaveQueueRef.current
      .catch(() => undefined)
      .then(() => tasksApi.saveMessages(pending.taskId, pending.messages))
      .catch((error) => {
        console.error('[chat] failed to persist messages', error)
      })
  }, [])

  useEffect(() => {
    if (selectedModelOverride) {
      setSelectedModel(selectedModelOverride)
      setIsModelSelectionLoaded(true)
      return
    }
    if (!taskId) {
      setIsModelSelectionLoaded(true)
      return
    }
    if (!task) {
      setIsModelSelectionLoaded(false)
      return
    }

    setSelectedModel(task.selectedModel || readLastSelectedModel())
    setSelectedAccountId(task.selectedAccountId)
    setIsModelSelectionLoaded(true)
  }, [selectedModelOverride, task, taskId])

  // ── Auto-scroll to bottom ───────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 140
  }, [])

  const scrollToBottom = useCallback((instant = false) => {
    if (!scrollRef.current) return
    isAtBottomRef.current = true
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: instant ? 'instant' : 'smooth',
    })
  }, [])

  useLayoutEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom(isStreaming)
    }
  }, [messages, isStreaming, scrollToBottom])

  // Markdown, reasoning and tool summaries can grow after React commits.
  // Keep following those height changes until the user intentionally scrolls
  // upward.
  useEffect(() => {
    const content = scrollContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    let frame: number | null = null
    const scheduleFollow = () => {
      if (!isAtBottomRef.current) return
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        scrollToBottom(true)
      })
    }
    const resizeObserver = new ResizeObserver(scheduleFollow)
    const mutationObserver = new MutationObserver(scheduleFollow)
    resizeObserver.observe(content)
    mutationObserver.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    })

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [scrollToBottom])

  // Load stored messages when mounting or changing task id
  useEffect(() => {
    if (taskId && typeof window !== 'undefined' && window.electronAPI?.tasks) {
      let active = true
      setIsLoaded(false)
      loadedTaskIdRef.current = null
      setContextStatus(null)
      isAtBottomRef.current = true
      setMessages([])
      void window.electronAPI.tasks.getMessages<Message>(taskId).then((loaded) => {
        if (!active) return
        if (Array.isArray(loaded) && loaded.length > 0) {
          setMessages(
            repairTrailingEmptyAssistant(
              repairIncompleteToolHistory(loaded),
            ),
          )
          requestAnimationFrame(() => {
            requestAnimationFrame(() => scrollToBottom(true))
          })
        }
        loadedTaskIdRef.current = taskId
        setIsLoaded(true)
      })
      return () => {
        active = false
      }
    } else {
      loadedTaskIdRef.current = null
      setContextStatus(null)
      setIsLoaded(true)
    }
  }, [scrollToBottom, taskId])

  // Debounce whole-history snapshots and serialize writes. Streaming can
  // update the UI dozens of times per second; older snapshots must never
  // overwrite a complete batch of parallel tool results.
  useEffect(() => {
    if (
      !taskId ||
      !isLoaded ||
      loadedTaskIdRef.current !== taskId ||
      messages.length === 0 ||
      typeof window === 'undefined' ||
      !window.electronAPI?.tasks
    ) {
      return
    }

    pendingMessageSaveRef.current = { taskId, messages }
    if (messageSaveTimerRef.current) {
      clearTimeout(messageSaveTimerRef.current)
    }
    messageSaveTimerRef.current = setTimeout(() => {
      messageSaveTimerRef.current = null
      flushPendingMessageSave()
    }, 150)

    return () => {
      if (messageSaveTimerRef.current) {
        clearTimeout(messageSaveTimerRef.current)
        messageSaveTimerRef.current = null
      }
    }
  }, [flushPendingMessageSave, isLoaded, messages, taskId])

  useEffect(
    () => () => {
      if (messageSaveTimerRef.current) {
        clearTimeout(messageSaveTimerRef.current)
        messageSaveTimerRef.current = null
      }
      flushPendingMessageSave()
    },
    [flushPendingMessageSave, taskId],
  )

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
    if (!isModelSelectionLoaded) return
    setSelectedModel((prev) => {
      if (selectedModelOverride) return selectedModelOverride
      if (prev && available.some((m) => `${m.provider}/${m.id}` === prev)) return prev
      if (defaultModel) return `${defaultModel.provider}/${defaultModel.id}`
      return prev
    })
  }, [
    available,
    defaultModel,
    isModelSelectionLoaded,
    selectedModelOverride,
  ])

  const handleModelChange = useCallback(
    (model: string) => {
      setSelectedModel(model)
      saveLastSelectedModel(model)
      if (taskId) {
        updateTask(taskId, { selectedModel: model })
      }
    },
    [taskId, updateTask],
  )

  const handleAccountChange = useCallback(
    (accountId: string | undefined) => {
      setSelectedAccountId(accountId)
      if (taskId) {
        updateTask(taskId, { selectedAccountId: accountId })
      }
    },
    [taskId, updateTask],
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const hasAnyModel = available.length > 0
  const selectedModelInfo = useMemo(
    () =>
      available.find((model) => `${model.provider}/${model.id}` === selectedModel),
    [available, selectedModel],
  )
  const requestThinkingLevel = useMemo(() => {
    if (!thinking || !selectedModelInfo?.supportsThinking) return 'off' as const
    const levels = selectedModelInfo.thinkingLevels
    if (!levels || levels.length === 0) return 'medium' as const
    if (levels.includes('medium')) return 'medium' as const
    if (levels.includes('high')) return 'high' as const
    return levels[0] ?? 'off'
  }, [selectedModelInfo, thinking])

  // ── Agent loop ──────────────────────────────────────────────────────

  const messagesRef = useRef<Message[]>([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Providers may emit many tiny chunks per second. Paint them in small
  // batches instead of rebuilding the entire transcript once per token.
  const streamingPatchesRef = useRef(
    new Map<string, { content: string; thinking: string }>(),
  )
  const streamingPatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const flushStreamingMessagePatches = useCallback(() => {
    if (streamingPatchTimerRef.current) {
      clearTimeout(streamingPatchTimerRef.current)
      streamingPatchTimerRef.current = null
    }

    const patches = streamingPatchesRef.current
    if (patches.size === 0) return
    streamingPatchesRef.current = new Map()

    setMessages((prev) =>
      prev.map((message) => {
        const patch = patches.get(message.id)
        if (!patch) return message
        return {
          ...message,
          content: message.content + patch.content,
          thinking: (message.thinking ?? '') + patch.thinking,
        }
      }),
    )
  }, [])

  const queueStreamingMessagePatch = useCallback(
    (id: string, patch: { content?: string; thinking?: string }) => {
      const current = streamingPatchesRef.current.get(id) ?? {
        content: '',
        thinking: '',
      }
      current.content += patch.content ?? ''
      current.thinking += patch.thinking ?? ''
      streamingPatchesRef.current.set(id, current)

      if (!streamingPatchTimerRef.current) {
        streamingPatchTimerRef.current = setTimeout(
          flushStreamingMessagePatches,
          STREAM_UI_FLUSH_MS,
        )
      }
    },
    [flushStreamingMessagePatches],
  )

  useEffect(
    () => () => {
      if (streamingPatchTimerRef.current) {
        clearTimeout(streamingPatchTimerRef.current)
        streamingPatchTimerRef.current = null
      }
      streamingPatchesRef.current.clear()
    },
    [],
  )

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, initialMessage, selectedModel, messages.length, isStreaming])

  useEffect(() => {
    if (!isStreaming && queuedMessage) {
      const msg = queuedMessage
      setQueuedMessage(null)
      void handleSubmit({ text: msg, images: [] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, queuedMessage])

  /**
   * Defensive dedupe for the final toolCalls buffer. Some gateways can
   * emit two `tool_use_start` / `tool_use_delta` chunks for the same
   * id; without dedupe, the timeline's `key={tc.id}` would fire a
   * React "duplicate key" warning. First-write-wins so we keep any
   * partial input the earlier event had already accumulated.
   */
  function dedupeToolCalls(
    calls: Array<{
      id: string
      name: string
      input: unknown
      providerItem?: Record<string, unknown>
    }>,
  ): typeof calls {
    const seen = new Set<string>()
    const out: typeof calls = []
    for (const tc of calls) {
      if (seen.has(tc.id)) continue
      seen.add(tc.id)
      out.push(tc)
    }
    return out
  }

  const applyChunk = (
    id: string,
    chunk: StreamChunk,
    buffers: {
      toolCalls: Array<{
        id: string
        name: string
        input: unknown
        providerItem?: Record<string, unknown>
      }>
      toolInputs: Map<string, string>
      providerOutputItems: Array<Record<string, unknown>>
    },
  ) => {
    switch (chunk.type) {
      case 'text_delta':
        queueStreamingMessagePatch(id, { content: chunk.text })
        break
      case 'thinking_delta':
        queueStreamingMessagePatch(id, { thinking: chunk.text })
        break
      case 'tool_use_start':
        if (!buffers.toolCalls.some((x) => x.id === chunk.id)) {
          buffers.toolCalls.push({
            id: chunk.id,
            name: chunk.name,
            input: {},
            providerItem: chunk.providerItem,
          })
          onToolCall?.({ id: chunk.id, name: chunk.name, input: {} })
        }
        break
      case 'tool_use_delta': {
        let tc = buffers.toolCalls.find((x) => x.id === chunk.id)
        if (!tc && chunk.name) {
          tc = {
            id: chunk.id,
            name: chunk.name,
            input: {},
            providerItem: chunk.providerItem,
          }
          buffers.toolCalls.push(tc)
          onToolCall?.(tc)
        }
        const prevArgs = buffers.toolInputs.get(chunk.id) ?? ''
        const next = typeof chunk.input === 'string' ? chunk.input : prevArgs
        buffers.toolInputs.set(chunk.id, next)
        if (tc) {
          tc.input = chunk.input ?? tc.input
          if (chunk.name) tc.name = chunk.name
          if (chunk.providerItem) tc.providerItem = chunk.providerItem
        }
        break
      }
      case 'provider_output_item':
        if (
          !buffers.providerOutputItems.some(
            (item) =>
              item.type === chunk.item.type &&
              typeof item.id === 'string' &&
              item.id === chunk.item.id,
          )
        ) {
          buffers.providerOutputItems.push(chunk.item)
        }
        break
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
        break
      }
      default:
        break
    }
  }

  const handleSubmit = async (
    payload: { text: string; images: import('@/components/home/ChatInput').AttachedImage[] },
  ) => {
    const text = payload.text.trim()
    if (!text && payload.images.length === 0) return
    if (isStreaming) {
      // Only queue the text — images don't survive across stream
      // boundaries (they belong with the user turn that introduced them).
      setQueuedMessage(text)
      return
    }
    if (!selectedModel) return

    saveLastSelectedModel(selectedModel)
    if (taskId && task?.selectedModel !== selectedModel) {
      updateTask(taskId, { selectedModel })
    }

    const controller = new AbortController()
    abortRef.current = controller

    // Build the content blocks (text + images). When the user attached
    // images, we set `contentBlocks` on the message — `toChatMessage`
    // will replay the full array to the model. `content` still holds
    // the plain text for the UI transcript.
    const contentBlocks: import('@/lib/providers').ContentBlock[] | undefined =
      payload.images.length > 0
        ? [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...payload.images.map((img) => ({
              type: 'image' as const,
              data: img.data,
              mediaType: img.mediaType,
            })),
          ]
        : undefined

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      ...(contentBlocks ? { contentBlocks } : {}),
    }

    // Each new turn starts with a clean Progress list. The agent will
    // append steps as tool calls happen.
    if (taskId) tasksStore.clearProgress(taskId)

    const baseMessages = [...messagesRef.current, userMsg]
    isAtBottomRef.current = true
    setMessages(baseMessages)
    setIsStreaming(true)
    if (taskId) setTaskActivity(taskId, 'streaming')

    const preparedContext = prepareConversationContext(
      baseMessages,
      selectedModel,
      selectedModelInfo,
    )
    const convo = preparedContext.messages
    if (
      preparedContext.compaction ||
      preparedContext.usageRatio >= 0.7
    ) {
      setContextStatus({
        afterMessageId: userMsg.id,
        estimatedTokens: preparedContext.estimatedTokens,
        contextWindow: preparedContext.contextWindow,
        usageRatio: preparedContext.usageRatio,
        compactedMessages: preparedContext.compaction?.omittedMessages ?? 0,
        summary: preparedContext.compaction?.summary,
      })
    } else {
      setContextStatus(null)
    }
    const changedPaths: string[] = []
    let failedTools = 0
    let deliveredFinalResponse = false

    try {
      let skillCatalog: Array<{
        selector: string
        name: string
        description: string
        source: string
      }> = []
      try {
        const discovered =
          (await window.electronAPI?.skills.list(effectiveProject?.path)) ?? []
        skillCatalog = discovered.map((skill) => ({
          selector: skill.selector ?? skill.name,
          name: skill.name,
          description: skill.description,
          source: skill.source,
        }))
      } catch (error) {
        window.electronAPI?.log('warn', [
          '[chat] failed to preload skill catalog',
          error instanceof Error ? error.message : String(error),
        ])
      }
      const baseSystemPrompt = systemPromptOverride
        ? effectiveProject
          ? `${systemPromptOverride}\n\n${buildBrightMemoryPrompt()}`
          : systemPromptOverride
        : buildSystemPrompt({
            project: effectiveProject,
            skills: skillCatalog,
          })
      const systemPrompt = preparedContext.compaction
        ? `${baseSystemPrompt}\n\n${preparedContext.compaction.summary}`
        : baseSystemPrompt

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const assistantId = crypto.randomUUID()
        const assistantMsg: Message = {
          id: assistantId,
          role: 'assistant',
          content: '',
          streaming: true,
        }
        setMessages((prev) => [...prev, assistantMsg])

        const toolCalls: Array<{
          id: string
          name: string
          input: unknown
          providerItem?: Record<string, unknown>
        }> = []
        const toolInputs = new Map<string, string>()
        const providerOutputItems: Array<Record<string, unknown>> = []
        let stopReason: string = 'end_turn'
        let assistantModel = ''
        let assistantText = ''
        let assistantThinking = ''

        for await (const chunk of providerRegistry.stream(selectedModel, {
          model: selectedModel,
          messages: convo,
          systemPrompt,
          tools: toolFilter
            ? getAllTools().filter((t) => toolFilter.includes(t.name))
            : getAllTools(),
          thinking: requestThinkingLevel,
          maxTokens: 4096,
          temperature: 0.7,
          signal: controller.signal,
        }, selectedAccountId)) {
          if (chunk.type === 'error') {
            throw chunk.error
          }
          applyChunk(assistantId, chunk, {
            toolCalls,
            toolInputs,
            providerOutputItems,
          })
          if (chunk.type === 'text_delta') {
            assistantText += chunk.text
          }
          if (chunk.type === 'thinking_delta') {
            assistantThinking += chunk.text
          }
          if (chunk.type === 'message_end') {
            stopReason = chunk.stopReason
            assistantModel = chunk.model
            if (chunk.usage?.input) {
              const measuredTokens = chunk.usage.input
              const measuredRatio = Math.min(
                1,
                measuredTokens / preparedContext.contextWindow,
              )
              setContextStatus((current) => {
                if (
                  !current &&
                  !preparedContext.compaction &&
                  measuredRatio < 0.7
                ) {
                  return null
                }
                return {
                  afterMessageId: userMsg.id,
                  estimatedTokens: measuredTokens,
                  contextWindow: preparedContext.contextWindow,
                  usageRatio: measuredRatio,
                  compactedMessages:
                    preparedContext.compaction?.omittedMessages ?? 0,
                  summary: preparedContext.compaction?.summary,
                }
              })
            }
          }
        }
        flushStreamingMessagePatches()

        convo.push({
          role: 'assistant',
          content:
            toolCalls.length > 0
              ? ([
                  ...(assistantText
                    ? [{ type: 'text' as const, text: assistantText }]
                    : []),
                  ...(assistantThinking
                    ? [{ type: 'thinking' as const, text: assistantThinking }]
                    : []),
                  ...toolCalls.map((tc) => ({
                    type: 'tool_use' as const,
                    id: tc.id,
                    name: tc.name,
                    input: (tc.input ?? {}) as Record<string, unknown>,
                    ...(tc.providerItem ? { providerItem: tc.providerItem } : {}),
                  })),
                ] as Array<
                  | { type: 'text'; text: string }
                  | { type: 'thinking'; text: string }
                  | {
                      type: 'tool_use'
                      id: string
                      name: string
                      input: Record<string, unknown>
                      providerItem?: Record<string, unknown>
                    }
                >)
              : assistantText,
          providerOutputItems,
          reasoningContent: assistantThinking,
        })

        if (toolCalls.length === 0 || stopReason !== 'tool_use') {
          const finalText =
            assistantText.trim() ||
            buildLocalCompletion(text, changedPaths, failedTools)
          deliveredFinalResponse = true
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: finalText,
                    providerOutputItems,
                    streaming: false,
                    model: assistantModel || m.model,
                  }
                : m,
            ),
          )
          break
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  // Defensive dedupe: a buggy provider could send two
                  // tool_use_start / tool_use_delta events with the same
                  // id, which would surface as a React "duplicate key"
                  // warning on the timeline. Keep the FIRST occurrence
                  // so we preserve any partial input the first event had
                  // already accumulated.
                  toolCalls: dedupeToolCalls(toolCalls),
                  providerOutputItems,
                  streaming: false,
                  model: assistantModel || m.model,
                }
              : m,
          ),
        )

        // Surface each tool call to the task's progress list so the
        // Environmental Information "Progress" section shows what the
        // agent is doing in real time.
        const stepIds: Array<{ toolId: string; stepId: string }> = []
        for (const tc of toolCalls) {
          const input = (tc.input ?? {}) as Record<string, unknown>
          const detail =
            typeof input.path === 'string'
              ? input.path
              : typeof input.command === 'string'
                ? input.command
                : typeof input.query === 'string'
                  ? input.query
                  : undefined
          if (!taskId) continue
          const stepId = tasksStore.addProgress(taskId, tc.name, detail)
          if (stepId) {
            stepIds.push({ toolId: tc.id, stepId })
            tasksStore.setProgressStatus(taskId, stepId, 'running')
          }
        }

        // Execute a single tool call and return the result. Handles both agent
        // delegations and regular tools.
        async function executeToolCall(
          tc: {
            id: string
            name: string
            input: unknown
            providerItem?: Record<string, unknown>
          },
          signal: AbortSignal,
        ): Promise<{
          uiMessage: Message
          wireMessage: ChatMessage
        } | null> {
          const toolResultId = crypto.randomUUID()
          const isAgentDelegation = tc.name.startsWith('delegate_to_')

          if (isAgentDelegation) {
            const agents = agentStore.list()
            const agent = agents.find(
              (a) =>
                `delegate_to_${a.name.toLowerCase().replace(/\s+/g, '_')}` ===
                tc.name,
            )

            if (!agent) {
              const errorMsg = `Agent "${tc.name}" not found. Create it in Agent Teams first.`
              failedTools += 1
              onToolResult?.(
                { id: tc.id, name: tc.name },
                { ok: false, result: null, error: errorMsg },
              )

              const uiMessage: Message = {
                id: toolResultId,
                role: 'tool',
                content: `Error: ${errorMsg}`,
                toolResolved: true,
                toolResultSummary: errorMsg,
                toolError: true,
                toolCalls: [{ id: tc.id, name: tc.name, input: tc.input }],
              }
              return {
                uiMessage,
                wireMessage: {
                  role: 'tool' as const,
                  toolCallId: tc.id,
                  toolName: tc.name,
                  content: `Error: ${errorMsg}`,
                },
              }
            }

            const taskInput = tc.input as
              | { task?: string; context?: string }
              | undefined
            const task: AgentTask = {
              agentId: agent.id,
              task: taskInput?.task ?? 'No task specified',
              context: taskInput?.context,
            }

            let agentOutput = ''
            let agentThinking = ''
            let agentError = ''

            try {
              for await (const progress of runAgent(task, { signal })) {
                if (progress.type === 'error') {
                  agentError = progress.error ?? 'Agent error'
                  onToolResult?.(
                    { id: tc.id, name: tc.name },
                    { ok: false, result: null, error: agentError },
                  )
                } else if (progress.type === 'text') {
                  agentOutput += progress.text ?? ''
                } else if (progress.type === 'thinking') {
                  agentThinking += progress.thinking ?? ''
                } else if (progress.type === 'done') {
                  onToolResult?.(
                    { id: tc.id, name: tc.name },
                    {
                      ok: progress.type === 'done',
                      result: agentOutput,
                      error: agentError || undefined,
                    },
                  )
                }
              }
            } catch (err) {
              const isAbort =
                (err instanceof DOMException && err.name === 'AbortError') ||
                (err instanceof Error &&
                  err.message.toLowerCase().includes('aborted'))
              if (!isAbort) {
                agentError = err instanceof Error ? err.message : String(err)
                onToolResult?.(
                  { id: tc.id, name: tc.name },
                  { ok: false, result: null, error: agentError },
                )
              }
            }

            const stopped = signal.aborted
            const ok = !agentError && !stopped
            const summary = ok
              ? `Agent ${agent.name} replied — ${agentOutput.length} chars`
              : stopped
                ? `Agent ${agent.name} stopped by user`
                : agentError

            if (!ok) failedTools += 1

            const peerTaskId = agentSessionTaskId ?? agentTaskId(agent)
            try {
              const peerMessages: AgentTranscriptMessage[] = []
              peerMessages.push({
                id: `peer-${crypto.randomUUID()}`,
                role: 'user',
                content: task.task,
                peerName: 'Bright',
                createdAt: Date.now(),
              })
              if (ok || (stopped && agentOutput)) {
                peerMessages.push({
                  id: `peer-${crypto.randomUUID()}`,
                  role: 'assistant',
                  content: agentOutput,
                  model: agent.model,
                  ...(agentThinking ? { thinking: agentThinking } : {}),
                  createdAt: Date.now(),
                })
              } else if (agentError) {
                peerMessages.push({
                  id: `peer-${crypto.randomUUID()}`,
                  role: 'error',
                  content: `Error: ${agentError}`,
                  createdAt: Date.now(),
                })
              }
              await appendAgentTranscript(agent.id, peerMessages)
            } catch (persistError) {
              console.error('[chat] failed to persist agent transcript', persistError)
            }

            const uiMessage: Message = {
              id: toolResultId,
              role: 'tool',
              content: ok
                ? agentOutput
                : stopped
                  ? agentOutput
                    ? `${agentOutput}\n\n_Stopped by user._`
                    : '_Stopped by user before any output was produced._'
                  : `Error: ${agentError}`,
              toolResolved: true,
              toolResultSummary: summary,
              toolError: !!agentError && !stopped,
              toolStopped: stopped,
              toolCalls: [{ id: tc.id, name: tc.name, input: tc.input }],
              isAgentResult: true,
              agentName: agent.name,
              agentAvatarSeed: agent.avatarSeed,
              agentTaskId: peerTaskId,
              ...(agentThinking ? { agentThinking } : {}),
            }

            return {
              uiMessage,
              wireMessage: {
                role: 'tool' as const,
                toolCallId: tc.id,
                toolName: tc.name,
                content: ok ? agentOutput : `Error: ${agentError}`,
              },
            }
          }

          // Regular tool execution
          const exec = await window.electronAPI?.tools.execute(
            tc.name as Parameters<
              NonNullable<typeof window.electronAPI>['tools']['execute']
            >[0],
            tc.input as never,
          )
          const execOk = exec?.ok === true
          const result = execOk ? exec.result : null
          const error =
            !execOk && exec && exec.ok === false ? exec.error : 'unknown error'
          const summary = execOk
            ? summarizeToolResult(tc.name, result)
            : (error ?? 'error')
          const changedPath = toolInputPath(tc.input)

          if (
            execOk &&
            changedPath &&
            (tc.name === 'write_file' || tc.name === 'edit_file')
          ) {
            changedPaths.push(changedPath)
          }
          if (!execOk) {
            failedTools += 1
          }

          onToolResult?.(
            { id: tc.id, name: tc.name },
            { ok: execOk, result, error },
          )
          if (
            execOk &&
            project &&
            (tc.name === 'write_file' || tc.name === 'edit_file')
          ) {
            notifyProjectFilesChanged(project.id, changedPath)
          }

          const uiMessage: Message = {
            id: toolResultId,
            role: 'tool',
            content: execOk
              ? serializeToolResult(result)
              : `Error: ${error}`,
            toolResolved: true,
            toolResultSummary: summary,
            toolError: !execOk,
            toolCalls: [{ id: tc.id, name: tc.name, input: tc.input }],
          }

          return {
            uiMessage,
            wireMessage: {
              role: 'tool' as const,
              toolCallId: tc.id,
              toolName: tc.name,
              content: execOk
                ? serializeToolResult(result)
                : `Error: ${error}`,
            },
          }
        }

        // Split agent delegations (must run sequentially to avoid resource contention)
        // from regular tools (can run in parallel for performance).
        const delegationCalls = toolCalls.filter((tc) => tc.name.startsWith('delegate_to_'))
        const regularCalls = toolCalls.filter((tc) => !tc.name.startsWith('delegate_to_'))

        const toolResults: Array<{
          uiMessage: Message
          wireMessage: ChatMessage
        }> = []

        // Run agent delegations sequentially to avoid concurrent agent state issues.
        for (const tc of delegationCalls) {
          const results = await executeToolCall(tc, controller.signal)
          if (results) toolResults.push(results)
        }

        // Run regular tools in parallel for better performance.
        const regularResults = await Promise.all(
          regularCalls.map(async (tc) => executeToolCall(tc, controller.signal)),
        )
        for (const r of regularResults) {
          if (r) toolResults.push(r)
        }

        // Commit results (outside the parallel tasks so changedPaths updates are safe).
        setMessages((prev) => [
          ...prev,
          ...toolResults.map((result) => result.uiMessage),
        ])
        convo.push(...toolResults.map((result) => result.wireMessage))

        // Mark each step as completed/failed so the EnvInfo "Progress" section
        // reflects the actual outcome.
        const errorByToolId = new Map(
          toolResults
            .filter((r) => r.uiMessage.toolError)
            .map((r) => [r.uiMessage.toolCalls?.[0]?.id ?? '', r]),
        )
        for (const { toolId, stepId } of stepIds) {
          const status = errorByToolId.has(toolId) ? 'failed' : 'completed'
          if (taskId) tasksStore.setProgressStatus(taskId, stepId, status)
        }
      }

      if (!deliveredFinalResponse) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: buildLocalCompletion(text, changedPaths, failedTools),
            streaming: false,
          },
        ])
      }
    } catch (err) {
      flushStreamingMessagePatches()
      const isAbort =
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error &&
          err.message.toLowerCase().includes('aborted'))
      if (!isAbort) {
        const detail = {
          model: selectedModel,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          cause: err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined,
        }
        console.error('[chat] stream failed', detail)
        window.electronAPI?.log('error', ['[chat] stream failed', detail])
        setMessages((prev) => [
          ...prev.filter(
            (message) =>
              !(
                message.streaming &&
                message.role === 'assistant' &&
                !message.content.trim() &&
                (message.toolCalls?.length ?? 0) === 0
              ),
          ),
          {
            id: crypto.randomUUID(),
            role: 'error',
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            errorDetails: formatErrorDetails(err),
          },
        ])
      }
    } finally {
      const wasAborted = controller.signal.aborted
      abortRef.current = null
      setIsStreaming(false)
      if (taskId) clearTaskActivity(taskId)
      setMessages((prev) =>
        prev.map((m) => {
          if (!m.streaming) return m
          // When the user clicks Stop, mark the turn so the UI can show
          // a "Stopped" indicator instead of a generic "Thought N times"
          // and so the partial output is preserved as-is.
          return wasAborted ? { ...m, streaming: false, stopped: true } : { ...m, streaming: false }
        }),
      )
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Message list — owns the scroll */}
      <div
        ref={scrollRef}
        data-chat-scroll
        onScroll={handleScroll}
        onWheel={(event) => {
          if (event.deltaY < 0) isAtBottomRef.current = false
        }}
        className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        <div
          ref={scrollContentRef}
          className="mx-auto flex max-w-3xl flex-col gap-6"
        >
          {messages.length === 0 ? (
            <ChatEmptyState />
          ) : (
            <MessageList
              messages={messages}
              isStreaming={isStreaming}
              contextStatus={contextStatus}
              onOpenAgentConversation={onOpenAgentConversation}
            />
          )}
        </div>
      </div>

      {/* Input pinned at bottom of the chat — flex shrink-0 keeps it
       * at the natural height; the messages area above takes the
       * remaining space (flex-1 + overflow-y-auto). */}
      <div className="shrink-0 px-6 pt-2 pb-4">
        <div className="mx-auto max-w-3xl">
          <ChatInput
            onSend={handleSubmit}
            disabled={!hasAnyModel}
            isStreaming={isStreaming}
            onStop={handleStop}
            onTypingChange={(typing) =>
              setTaskActivity(taskId ?? null, typing ? 'user-typing' : 'idle')
            }
            thinking={thinking}
            onThinkingChange={setThinking}
            authMode={authMode}
            onAuthModeChange={setAuthMode}
            modelGroups={modelGroups}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            selectedAccountId={selectedAccountId}
            onAccountChange={handleAccountChange}
            emptyModelMessage="No models — open Settings"
            supportsImages={selectedModelInfo?.supportsImages !== false}
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
  contextStatus,
  onOpenAgentConversation,
}: {
  messages: Message[]
  isStreaming: boolean
  contextStatus: ContextWindowStatus | null
  onOpenAgentConversation?: (agentId: string) => void
}) {
  const items: Array<
    | { kind: 'msg'; message: Message; compact?: boolean }
    | { kind: 'turn'; assistant: Message; tools: Message[]; streaming: boolean }
    | { kind: 'context'; status: ContextWindowStatus }
  > = []

  // A conversation can contain many finished assistant turns, but only the
  // newest assistant after the latest user message belongs to the active
  // request. Using the global `isStreaming` flag by itself would animate every
  // previous text-only turn because those turns have no tool calls.
  let activeAssistantId: string | undefined
  if (isStreaming) {
    const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
    const latestAssistantIndex = messages.findLastIndex(
      (message) => message.role === 'assistant',
    )
    if (latestAssistantIndex > latestUserIndex) {
      activeAssistantId = messages[latestAssistantIndex]?.id
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant') {
      const tools: Message[] = []
      let j = i + 1
      while (j < messages.length && messages[j]!.role === 'tool') {
        tools.push(messages[j]!)
        j++
      }
      // Keep the status active through both model streaming and tool
      // execution, but never revive completed turns from earlier messages.
      const streaming = isStreaming && m.id === activeAssistantId

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
      if (m.id === contextStatus?.afterMessageId) {
        items.push({ kind: 'context', status: contextStatus })
      }
    }
  }

  return (
    <>
      {items.map((it) => {
        if (it.kind === 'msg') {
          return (
            <div
              key={it.message.id + (it.compact ? ':reply' : '')}
              className="chat-history-item"
            >
              <MessageBubble
                message={it.message}
                compact={it.compact}
                onOpenAgentConversation={onOpenAgentConversation}
              />
            </div>
          )
        }
        if (it.kind === 'context') {
          return (
            <div
              key={`context:${it.status.afterMessageId}`}
              className="chat-history-item"
            >
              <ContextWindowNotice status={it.status} />
            </div>
          )
        }
        return (
          <div key={it.assistant.id} className="chat-history-item">
            <AssistantTurn
              assistant={it.assistant}
              toolMessages={it.tools}
              streaming={it.streaming}
            />
          </div>
        )
      })}
    </>
  )
}

function ContextWindowNotice({ status }: { status: ContextWindowStatus }) {
  const usedPercent = Math.max(1, Math.round(status.usageRatio * 100))
  const compacted = status.compactedMessages > 0

  return (
    <div className="border-border/60 bg-card/35 text-muted-foreground mx-1 rounded-lg border px-3 py-2 text-[11.5px]">
      <div className="flex items-center gap-2">
        <Layers3 className="text-primary size-3.5 shrink-0" />
        <span className="font-medium text-foreground/80">
          {compacted ? 'Contexto compactado automaticamente' : 'Janela de contexto alta'}
        </span>
        <span
          className="ml-auto tabular-nums"
          title={`Aproximadamente ${status.estimatedTokens.toLocaleString()} de ${status.contextWindow.toLocaleString()} tokens`}
        >
          {usedPercent}% estimado
        </span>
      </div>
      <p className="mt-1 pl-5 leading-relaxed">
        {compacted
          ? `${status.compactedMessages} mensagens antigas foram resumidas; o histórico visual continua intacto.`
          : 'A compactação automática será aplicada antes de atingir o limite do modelo.'}
      </p>
      {status.summary && (
        <details className="mt-1 pl-5">
          <summary className="hover:text-foreground cursor-pointer select-none">
            Ver resumo preservado
          </summary>
          <pre className="border-border/50 bg-background/50 mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-md border p-2 font-sans text-[11px] leading-relaxed">
            {status.summary}
          </pre>
        </details>
      )}
    </div>
  )
}

function ChatEmptyState() {
  return (
    <div className="text-muted-foreground/80 flex flex-col items-center gap-2 py-12 text-center text-[13px]">
      <p>Send a message to get started.</p>
    </div>
  )
}
