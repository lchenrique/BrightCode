/**
 * Turn scheduler — owns one runtime scheduler per thread.
 *
 * Responsibilities:
 *   - One active turn per thread (other threads may run concurrently).
 *   - Bounded global concurrency (default 4 parallel turns).
 *   - Persist the user item before the provider request is started.
 *   - Queue complete user inputs (including images) when steering is unavailable.
 *   - Propagate a shared abort signal through provider, tools, approvals, processes, MCP, subagents.
 *   - Terminate a turn only when:
 *       a) the model produces no executable output (no tool calls, no text), OR
 *       b) a terminal error occurs, OR
 *       c) the user interrupts, OR
 *       d) the emergency round ceiling (default 64) is reached, OR
 *       e) doom-loop detection triggers (3 identical tool calls).
 *
 * NOT owned here:
 *   - The actual model execution (ProviderService).
 *   - Persistence (EventStore).
 *   - The reducer (event-reducer).
 *   - IPC (Task 5A).
 */

import { randomUUID } from 'crypto'
import {
  type RuntimeEvent,
  RUNTIME_SCHEMA_VERSION,
} from '../../shared/agent-protocol'
import { getEventStore, type EventStore } from './event-store'
import { getProviderService, type ProviderService } from './provider-service'
import type { ChatMessage, IAgentProvider, ProviderCredential } from '../../shared/providers/types'

type ThreadId = string
type TurnId = string

// ── Public configuration ───────────────────────────────────────────────────

export interface TurnSchedulerConfig {
  /** Max parallel turns across all threads. Default 4. */
  maxGlobalConcurrency?: number
  /** Max rounds per turn (emergency ceiling). Default 64. */
  maxRoundsPerTurn?: number
  /** Doom-loop detection: same tool+input repeated N times. Default 3. */
  doomLoopThreshold?: number
  /** AbortSignal passed to every turn. */
  signal?: AbortSignal
}

export interface StartTurnInput {
  threadId: ThreadId
  /** Provider-level identity for the model call. */
  provider: IAgentProvider
  modelId: string
  credential?: ProviderCredential
  /** The new user message that starts this turn. */
  userMessage: ChatMessage
  /** Initial sequence for emitted events. */
  startSequence: number
}

export interface SteerTurnInput {
  threadId: ThreadId
  /** Additional user input while the turn is running. */
  userMessage: ChatMessage
}

export interface InterruptTurnInput {
  threadId: ThreadId
  reason?: 'user' | 'error' | 'abort' | 'tool-timeout' | 'approval-timeout'
}

export interface RuntimeLike {
  /** Append a single event to the underlying event store. */
  appendEvent(threadId: ThreadId, event: RuntimeEvent): Promise<void>
  /** Read the current state for diagnostics. */
  getState(threadId: ThreadId): unknown
}

// ── Scheduler state per thread ─────────────────────────────────────────────

interface TurnState {
  turnId: TurnId
  abortController: AbortController
  /** Sequence of currently-running operation. */
  currentSequence: number
  /** Round counter (one round = one model call + one tool batch). */
  rounds: number
  /** Hash of recent tool calls for doom-loop detection. */
  recentToolSig: string[]
  /** Queued user messages waiting to be steered in. */
  queue: ChatMessage[]
}

// ── Scheduler ──────────────────────────────────────────────────────────────

export interface TurnScheduler {
  /** Start a new turn on a thread. Persists the user item, then runs the loop. */
  startTurn(input: StartTurnInput): Promise<TurnId>
  /** Steer a running turn with an additional user input. */
  steerTurn(input: SteerTurnInput): Promise<void>
  /** Interrupt a running turn. */
  interruptTurn(input: InterruptTurnInput): Promise<void>
  /** Whether a turn is currently active on the given thread. */
  isActive(threadId: ThreadId): boolean
  /** Number of currently active turns across all threads. */
  globalActiveCount(): number
  /** Optional: bind the runtime (Task 5 will inject). */
  bindRuntime(runtime: RuntimeLike): void
}

class TurnSchedulerImpl implements TurnScheduler {
  private readonly config: Required<Omit<TurnSchedulerConfig, 'signal'>>
  private readonly signal: AbortSignal | undefined
  private readonly turns = new Map<ThreadId, TurnState>()
  private eventStore: EventStore = getEventStore()
  private providerService: ProviderService = getProviderService()
  private runtime: RuntimeLike | null = null

  constructor(config: TurnSchedulerConfig = {}) {
    this.config = {
      maxGlobalConcurrency: config.maxGlobalConcurrency ?? 4,
      maxRoundsPerTurn: config.maxRoundsPerTurn ?? 64,
      doomLoopThreshold: config.doomLoopThreshold ?? 3,
    }
    this.signal = config.signal
  }

  bindRuntime(runtime: RuntimeLike): void {
    this.runtime = runtime
  }

  isActive(threadId: ThreadId): boolean {
    return this.turns.has(threadId)
  }

  globalActiveCount(): number {
    return this.turns.size
  }

  async startTurn(input: StartTurnInput): Promise<TurnId> {
    if (this.turns.has(input.threadId)) {
      throw new Error(`Cannot start turn on thread "${input.threadId}": turn already active.`)
    }
    if (this.turns.size >= this.config.maxGlobalConcurrency) {
      throw new Error(
        `Global concurrency limit reached (${this.config.maxGlobalConcurrency}). Wait for a turn to finish.`,
      )
    }

    const turnId = `turn_${randomUUID()}` as TurnId
    const abortController = new AbortController()

    // Link external signal to internal abort.
    if (this.signal) {
      if (this.signal.aborted) abortController.abort(this.signal.reason)
      else this.signal.addEventListener('abort', () => abortController.abort(this.signal?.reason), { once: true })
    }

    const turnState: TurnState = {
      turnId,
      abortController,
      currentSequence: input.startSequence,
      rounds: 0,
      recentToolSig: [],
      queue: [input.userMessage],
    }
    this.turns.set(input.threadId, turnState)

    // A turn must exist before the reducer can accept its items.
    await this.appendEvent(input.threadId, {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      threadId: input.threadId,
      turnId,
      sequence: input.startSequence,
      timestamp: Date.now(),
      type: 'turn-start',
      payload: { turnId, permissionProfile: 'workspace_write' },
    })
    turnState.currentSequence = input.startSequence + 1

    // Persist the complete user item before the provider request starts.
    for (const event of this.buildUserMessageEvents(
      input.threadId,
      turnId,
      input.userMessage,
      turnState.currentSequence,
    )) {
      await this.appendEvent(input.threadId, event)
      turnState.currentSequence = event.sequence + 1
    }

    // Run the loop async — caller does not wait for completion.
    void this.runLoop(input.threadId, turnId, input, turnState)

    return turnId
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    const turn = this.turns.get(input.threadId)
    if (!turn) {
      throw new Error(`Cannot steer thread "${input.threadId}": no active turn.`)
    }
    // If the model is currently streaming, queue for the next round.
    // Otherwise, can be appended immediately (caller decides).
    turn.queue.push(input.userMessage)
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    const turn = this.turns.get(input.threadId)
    if (!turn) {
      // Nothing to interrupt — idempotent.
      return
    }
    turn.abortController.abort(input.reason ?? 'user')
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async runLoop(
    threadId: ThreadId,
    turnId: TurnId,
    input: StartTurnInput,
    turn: TurnState,
  ): Promise<void> {
    try {
      // Take the first user message from the queue.
      const userMessage = turn.queue.shift()
      if (!userMessage) {
        // No input — finish immediately.
        await this.finishTurn(threadId, turnId, turn, 'completed')
        return
      }

      // Run rounds until the model produces no executable output or we hit a ceiling.
      while (turn.rounds < this.config.maxRoundsPerTurn) {
        if (turn.abortController.signal.aborted) {
          await this.finishTurn(threadId, turnId, turn, 'interrupted')
          return
        }

        turn.rounds++

        // Call the provider. The service emits ProviderEvents; we map them
        // to RuntimeEvents and persist.
        const stopReason = await this.runOneRound(threadId, turnId, input, turn, userMessage)

        if (turn.abortController.signal.aborted) {
          await this.finishTurn(threadId, turnId, turn, 'interrupted')
          return
        }

        if (stopReason === 'error') {
          await this.finishTurn(threadId, turnId, turn, 'failed')
          return
        }

        // Doom-loop detection
        if (this.detectDoomLoop(turn)) {
          await this.appendEvent(threadId, {
            schemaVersion: RUNTIME_SCHEMA_VERSION,
            threadId,
            turnId,
            sequence: turn.currentSequence,
            timestamp: Date.now(),
            type: 'error',
            payload: {
              message: `Doom-loop detected: same tool+input repeated ${turn.recentToolSig.length} times.`,
              code: 'doom-loop',
              retryable: false,
            },
          })
          turn.currentSequence++
          await this.finishTurn(threadId, turnId, turn, 'failed')
          return
        }

        // termination: no tool calls in this round
        if (stopReason === 'end_turn' || stopReason === 'stop') {
          await this.finishTurn(threadId, turnId, turn, 'completed')
          return
        }
        if (stopReason === 'max_tokens') {
          await this.finishTurn(threadId, turnId, turn, 'completed')
          return
        }

        // tool_use: continue to next round (caller will dispatch tools).
        // For now, the scheduler does not execute tools — Task 6+ owns that.
        // We treat tool_use as a stop point for the scheduler loop; the
        // actual tool execution + subsequent model call is a future task.
        await this.finishTurn(threadId, turnId, turn, 'completed')
        return
      }

      // Hit the emergency ceiling.
      await this.appendEvent(threadId, {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId,
        turnId,
        sequence: turn.currentSequence,
        timestamp: Date.now(),
        type: 'error',
        payload: {
          message: `Turn hit emergency ceiling: ${this.config.maxRoundsPerTurn} rounds.`,
          code: 'round-limit',
          retryable: false,
        },
      })
      turn.currentSequence++
      await this.finishTurn(threadId, turnId, turn, 'failed')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.appendEvent(threadId, {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId,
        turnId,
        sequence: turn.currentSequence,
        timestamp: Date.now(),
        type: 'error',
        payload: { message, retryable: false },
      })
      turn.currentSequence++
      await this.finishTurn(threadId, turnId, turn, 'failed')
    } finally {
      this.turns.delete(threadId)
    }
  }

  /**
   * Run one round: emit item-start for the agent message, stream provider
   * events, emit item-end + message_end. Returns the stop reason.
   */
  private async runOneRound(
    threadId: ThreadId,
    turnId: TurnId,
    input: StartTurnInput,
    turn: TurnState,
    userMessage: ChatMessage,
  ): Promise<'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'error'> {
    const itemId = `item_${randomUUID()}`
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'error' = 'end_turn'
    let toolSeen = false
    let reasoningItemId: string | null = null
    let lastToolSignature: string | null = null

    // Emit item-start for the agent message that will be filled by the stream.
    await this.appendEvent(threadId, {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      threadId,
      turnId,
      sequence: turn.currentSequence,
      timestamp: Date.now(),
      type: 'item-start',
      payload: { itemId, turnId, kind: 'agent-message' },
    })
    turn.currentSequence++

    try {
      for await (const providerEvent of this.providerService.run({
        threadId,
        turnId,
        startSequence: turn.currentSequence,
        provider: input.provider,
        params: {
          model: input.modelId,
          messages: [userMessage],
        },
        credential: input.credential,
        signal: turn.abortController.signal,
      })) {
        if (providerEvent.type === 'message_start') continue

        if (providerEvent.type === 'thinking_delta') {
          if (!reasoningItemId) {
            reasoningItemId = `item_${randomUUID()}`
            await this.appendEvent(threadId, {
              schemaVersion: RUNTIME_SCHEMA_VERSION,
              threadId,
              turnId,
              sequence: turn.currentSequence++,
              timestamp: providerEvent.timestamp,
              type: 'item-start',
              payload: { itemId: reasoningItemId, turnId, kind: 'reasoning' },
            })
          }
          await this.appendEvent(threadId, {
            schemaVersion: RUNTIME_SCHEMA_VERSION,
            threadId,
            turnId,
            sequence: turn.currentSequence++,
            timestamp: providerEvent.timestamp,
            type: 'reasoning-delta',
            payload: {
              itemId: reasoningItemId,
              content: providerEvent.payload.text ?? '',
            },
          })
          continue
        }

        const runtimeEvents = this.providerEventToRuntime(
          providerEvent,
          { threadId, turnId, itemId },
          turn.currentSequence,
        )
        for (const ev of runtimeEvents) {
          await this.appendEvent(threadId, ev)
          turn.currentSequence = ev.sequence + 1
        }

        if (providerEvent.type === 'message_end') {
          stopReason = providerEvent.payload.stopReason ?? 'end_turn'
        }
        if (providerEvent.type === 'error') stopReason = 'error'
        if (providerEvent.type === 'tool_use_start') {
          toolSeen = true
          lastToolSignature = providerEvent.payload.toolName ?? ''
        }
        if (providerEvent.type === 'tool_use_delta' && lastToolSignature) {
          lastToolSignature += `:${JSON.stringify(providerEvent.payload.toolInput ?? {})}`
        }
      }
    } catch (err) {
      // Provider thrown — emit error event and fail the turn.
      const message = err instanceof Error ? err.message : String(err)
      await this.appendEvent(threadId, {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId,
        turnId,
        sequence: turn.currentSequence,
        timestamp: Date.now(),
        type: 'error',
        payload: { message, retryable: false },
      })
      turn.currentSequence++
      stopReason = 'error'
    }

    if (reasoningItemId) {
      await this.appendEvent(threadId, {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId,
        turnId,
        sequence: turn.currentSequence++,
        timestamp: Date.now(),
        type: 'item-end',
        payload: {
          itemId: reasoningItemId,
          status: turn.abortController.signal.aborted ? 'interrupted' : 'completed',
        },
      })
    }

    // Emit item-end.
    await this.appendEvent(threadId, {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      threadId,
      turnId,
      sequence: turn.currentSequence,
      timestamp: Date.now(),
      type: 'item-end',
      payload: {
        itemId,
        status: turn.abortController.signal.aborted
          ? 'interrupted'
          : stopReason === 'error'
            ? 'failed'
            : 'completed',
      },
    })
    turn.currentSequence++

    // Record tool sig for doom-loop detection.
    if (toolSeen && lastToolSignature) {
      turn.recentToolSig.push(lastToolSignature)
      if (turn.recentToolSig.length > this.config.doomLoopThreshold) turn.recentToolSig.shift()
    }

    return toolSeen ? 'tool_use' : stopReason
  }

  private detectDoomLoop(turn: TurnState): boolean {
    if (turn.recentToolSig.length < this.config.doomLoopThreshold) return false
    const last = turn.recentToolSig[turn.recentToolSig.length - 1]
    return turn.recentToolSig.slice(-this.config.doomLoopThreshold).every((s) => s === last)
  }

  private async finishTurn(
    threadId: ThreadId,
    turnId: TurnId,
    turn: TurnState,
    status: 'completed' | 'interrupted' | 'failed',
  ): Promise<void> {
    if (status === 'interrupted') {
      await this.appendEvent(threadId, {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId,
        turnId,
        sequence: turn.currentSequence,
        timestamp: Date.now(),
        type: 'turn-interrupted',
        payload: { turnId, reason: 'user' },
      })
    } else {
      await this.appendEvent(threadId, {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId,
        turnId,
        sequence: turn.currentSequence,
        timestamp: Date.now(),
        type: status === 'completed' ? 'turn-complete' : 'turn-failed',
        payload: {
          turnId,
          status: status === 'completed' ? 'completed' : 'failed',
        },
      })
    }
    turn.currentSequence++
  }

  private async appendEvent(threadId: ThreadId, event: RuntimeEvent): Promise<void> {
    if (this.runtime) {
      await this.runtime.appendEvent(threadId, event)
    } else {
      await this.eventStore.append(threadId, event)
    }
  }

  private buildUserMessageEvents(
    threadId: ThreadId,
    turnId: TurnId,
    message: ChatMessage,
    sequence: number,
  ): RuntimeEvent[] {
    const itemId = `item_${randomUUID()}`
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = typeof message.content === 'string'
      ? message.content
      : blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
    const imageRefs = blocks
      .filter((block) => block.type === 'image')
      .map((block) => `data:${block.mediaType};base64,${block.data}`)

    return [
      {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId,
        turnId,
        sequence,
        timestamp: Date.now(),
        type: 'item-start',
        payload: {
          itemId,
          turnId,
          kind: 'user-message',
          role: 'user',
          content: { text, imageRefs: imageRefs.length > 0 ? imageRefs : undefined },
        },
      },
      {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId,
        turnId,
        itemId,
        sequence: sequence + 1,
        timestamp: Date.now(),
        type: 'item-end',
        payload: { itemId, status: 'completed' },
      },
    ]
  }

  /** Map a ProviderEvent onto one or more RuntimeEvents. */
  private providerEventToRuntime(
    pe: import('../../shared/providers/types').ProviderEvent,
    ctx: { threadId: ThreadId; turnId: TurnId; itemId: string },
    sequence: number,
  ): RuntimeEvent[] {
    const base = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      timestamp: pe.timestamp,
    }
    switch (pe.type) {
      case 'message_start':
        return [] // already emitted by us
      case 'text_delta':
        return [{
          ...base,
          sequence,
          type: 'text-delta',
          payload: { itemId: ctx.itemId, content: pe.payload.text ?? '' },
        }]
      case 'thinking_delta':
        return [] // handled as a dedicated reasoning item in runOneRound
      case 'tool_use_start':
        return [{
          ...base,
          itemId: pe.itemId,
          sequence,
          type: 'tool-call-start',
          payload: {
            itemId: pe.itemId ?? `item_${randomUUID()}`,
            turnId: ctx.turnId,
            name: pe.payload.toolName ?? '',
          },
        }]
      case 'tool_use_delta':
        return [{
          ...base,
          itemId: pe.itemId,
          sequence,
          type: 'tool-call-delta',
          payload: {
            itemId: pe.itemId ?? '',
            turnId: ctx.turnId,
            inputFragment: JSON.stringify(pe.payload.toolInput ?? {}),
          },
        }]
      case 'tool_use_end':
        return [{
          ...base,
          itemId: pe.itemId,
          sequence,
          type: 'tool-call-end',
          payload: {
            itemId: pe.itemId ?? '',
            turnId: ctx.turnId,
            name: '',
            input: pe.payload.toolInput ?? {},
          },
        }]
      case 'message_end':
        return [] // finishTurn emits the single terminal event
      case 'error':
        return [{
          ...base,
          sequence,
          type: 'error',
          payload: {
            message: pe.payload.error?.message ?? 'Unknown error',
            code: pe.payload.error?.code,
            retryable: pe.payload.error?.retryable,
          },
        }]
    }
  }
}

// ── Singleton export ───────────────────────────────────────────────────────

let _scheduler: TurnScheduler | null = null

export function getTurnScheduler(config?: TurnSchedulerConfig): TurnScheduler {
  if (!_scheduler) _scheduler = new TurnSchedulerImpl(config)
  return _scheduler
}

export function _resetTurnScheduler(): void {
  _scheduler = null
}
