/**
 * Agent runtime — the main-process orchestrator for thread lifecycle.
 *
 * Responsibilities:
 *   - Create, open, resume, fork, archive threads.
 *   - Surface a stable API for the IPC layer (Task 5A).
 *   - Persist every operation through the EventStore (Task 3).
 *   - Use the TurnScheduler (Task 5) to run turns.
 *   - Forward ProviderEvents (Task 4) into RuntimeEvents via the scheduler.
 *
 * NOT owned here:
 *   - The actual model execution (ProviderService).
 *   - The reducer (event-reducer).
 *   - Subscription / IPC plumbing (Task 5A).
 */

import { randomUUID } from 'crypto'
import { type RuntimeEvent } from '../../shared/agent-protocol'
import { getEventStore, type EventStore } from './event-store'
import { getTurnScheduler, type TurnScheduler, type StartTurnInput } from './turn-scheduler'

type ThreadId = string
type TurnId = string

// ── Public API ─────────────────────────────────────────────────────────────

export interface CreateThreadInput {
  /** Optional id; generated if absent. */
  id?: ThreadId
  /** Optional title for the UI. */
  title?: string
  /** Optional project id (for org / future features). */
  projectId?: string
  /** Optional initial user message — starts a turn immediately. */
  initialUserMessage?: import('../../shared/providers/types').ChatMessage
  /** Provider to use for the initial turn. */
  provider?: import('../../shared/providers/types').IAgentProvider
  modelId?: string
  credential?: import('../../shared/providers/types').ProviderCredential
}

export interface OpenThreadInput {
  threadId: ThreadId
}

export interface ArchiveThreadInput {
  threadId: ThreadId
}

export interface ForkThreadInput {
  /** Source thread to fork from. */
  sourceThreadId: ThreadId
  /** Optional new thread id; generated if absent. */
  newThreadId?: ThreadId
  /** Optional point in the source to fork AT (sequence number). */
  atSequence?: number
}

export interface Runtime {
  // ── Thread lifecycle ────────────────────────────────────────────────────
  createThread(input: CreateThreadInput): Promise<{ threadId: ThreadId }>
  openThread(input: OpenThreadInput): Promise<{ state: unknown; events: RuntimeEvent[] }>
  listThreads(): Promise<ThreadId[]>
  archiveThread(input: ArchiveThreadInput): Promise<void>
  forkThread(input: ForkThreadInput): Promise<{ threadId: ThreadId }>

  // ── Turn operations (delegated to scheduler) ───────────────────────────
  startTurn(input: StartTurnInput): Promise<TurnId>
  steerTurn(input: { threadId: ThreadId; userMessage: import('../../shared/providers/types').ChatMessage }): Promise<void>
  interruptTurn(input: { threadId: ThreadId; reason?: 'user' | 'error' | 'abort' | 'tool-timeout' | 'approval-timeout' }): Promise<void>

  // ── Event subscription (for the IPC layer) ────────────────────────────
  subscribe(threadId: ThreadId, listener: (event: RuntimeEvent) => void): () => void
}

class RuntimeImpl implements Runtime {
  private readonly eventStore: EventStore = getEventStore()
  private readonly scheduler: TurnScheduler = getTurnScheduler()
  private readonly listeners = new Map<ThreadId, Set<(event: RuntimeEvent) => void>>()

  constructor() {
    // Wire scheduler into the event store so every event the scheduler
    // emits is also broadcast to listeners (for the IPC layer).
    this.scheduler.bindRuntime({
      appendEvent: async (threadId, event) => {
        await this.eventStore.append(threadId, event)
        this.broadcast(threadId, event)
      },
      getState: (threadId) => this.eventStore.getState(threadId),
    })
  }

  // ── Thread lifecycle ────────────────────────────────────────────────────

  async createThread(input: CreateThreadInput): Promise<{ threadId: ThreadId }> {
    const threadId = (input.id ?? (`thread_${randomUUID()}`)) as ThreadId

    // Open the thread (creates an empty state if file doesn't exist).
    await this.eventStore.open(threadId)

    // If we have an initial user message, start a turn.
    if (input.initialUserMessage && input.provider && input.modelId) {
      await this.startTurn({
        threadId,
        provider: input.provider,
        modelId: input.modelId,
        credential: input.credential,
        userMessage: input.initialUserMessage,
        startSequence: 1,
      })
    }

    return { threadId }
  }

  async openThread(input: OpenThreadInput): Promise<{ state: unknown; events: RuntimeEvent[] }> {
    const result = await this.eventStore.open(input.threadId)
    return { state: result.state, events: result.events }
  }

  async listThreads(): Promise<ThreadId[]> {
    return this.eventStore.listThreads()
  }

  async archiveThread(input: ArchiveThreadInput): Promise<void> {
    // For now: delete the thread. Future: keep the log but mark it
    // archived in the index so the UI can hide it from the list.
    if (this.scheduler.isActive(input.threadId)) {
      await this.scheduler.interruptTurn({ threadId: input.threadId, reason: 'user' })
    }
    await this.eventStore.deleteThread(input.threadId)
    this.listeners.delete(input.threadId)
  }

  async forkThread(input: ForkThreadInput): Promise<{ threadId: ThreadId }> {
    const source = await this.eventStore.open(input.sourceThreadId)
    const newThreadId = (input.newThreadId ?? (`thread_${randomUUID()}`)) as ThreadId

    // Copy events up to fork point.
    const atSeq = input.atSequence ?? source.events[source.events.length - 1]?.sequence ?? 0
    const eventsToCopy = source.events.filter((e) => e.sequence <= atSeq)

    // Create the new thread (without starting a turn).
    await this.eventStore.open(newThreadId)
    for (const event of eventsToCopy) {
      await this.eventStore.append(newThreadId, event)
    }

    return { threadId: newThreadId }
  }

  // ── Turn operations ─────────────────────────────────────────────────────

  async startTurn(input: StartTurnInput): Promise<TurnId> {
    // Ensure the thread is open.
    await this.eventStore.open(input.threadId)
    const state = this.eventStore.getState(input.threadId)
    const lastSeq = state && typeof state === 'object' && 'sequence' in state
      ? (state as { sequence: number }).sequence
      : 0
    return this.scheduler.startTurn({ ...input, startSequence: lastSeq + 1 })
  }

  async steerTurn(input: { threadId: ThreadId; userMessage: import('../../shared/providers/types').ChatMessage }): Promise<void> {
    await this.scheduler.steerTurn(input)
  }

  async interruptTurn(input: { threadId: ThreadId; reason?: 'user' | 'error' | 'abort' | 'tool-timeout' | 'approval-timeout' }): Promise<void> {
    await this.scheduler.interruptTurn(input)
  }

  // ── Event subscription ──────────────────────────────────────────────────

  subscribe(threadId: ThreadId, listener: (event: RuntimeEvent) => void): () => void {
    let set = this.listeners.get(threadId)
    if (!set) {
      set = new Set()
      this.listeners.set(threadId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) this.listeners.delete(threadId)
    }
  }

  private broadcast(threadId: ThreadId, event: RuntimeEvent): void {
    const set = this.listeners.get(threadId)
    if (!set) return
    for (const l of set) {
      try { l(event) } catch {
        // Listener errors are non-fatal.
      }
    }
  }
}

// ── Singleton export ───────────────────────────────────────────────────────

let _runtime: Runtime | null = null

export function getRuntime(): Runtime {
  if (!_runtime) _runtime = new RuntimeImpl()
  return _runtime
}

export function _resetRuntime(): void {
  _runtime = null
}
