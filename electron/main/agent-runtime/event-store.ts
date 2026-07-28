/**
 * Append-only JSONL event store for Agent Runtime threads.
 *
 * Each thread lives at `userData/agent-runtime/v2/threads/<threadId>.jsonl`.
 * One JSON line per RuntimeEvent, one event per write (no buffering of events,
 * but reads are chunked).
 *
 * Storage invariants (per architecture plan):
 * - `item.start`, approvals, tool effects, and terminal events → flushed immediately
 * - Text/reasoning deltas → coalesced into checkpoints at most every 200 ms
 * - On recovery: non-terminal turns and items are marked interrupted, partial output preserved
 * - Auto-compaction: inactive log > 10 MiB OR > 50,000 events → compact to item snapshots
 * - Unknown newer schema version → open read-only
 *
 * The EventStore is owned by the main process. All writes go through it.
 */

import { appendFile, mkdir } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface, type ReadLineOptions } from 'readline'
import { join, dirname } from 'path'
import { RuntimeEvent, RUNTIME_SCHEMA_VERSION, ThreadState, emptyThreadState } from '../../shared/agent-protocol'
import { reduce, replay } from './event-reducer'
import { writeThreadIndex, type ThreadIndex, listThreadIds } from './thread-index'
import { runMigrations } from './migrations'

/** The directory inside userData where thread logs live. */
export const THREADS_DIR = 'agent-runtime/v2/threads'

/** Coalescing window for text/reasoning deltas (ms). */
const CHECKPOINT_COALESCE_MS = 200

/** Events that must be flushed to disk immediately (not coalesced). */
const FLUSH_EVENT_TYPES = new Set([
  'turn-start', 'turn-complete', 'turn-failed', 'turn-interrupted',
  'item-start', 'item-end',
  'tool-result',
  'approval-required', 'approval-resolved',
  'subagent-start', 'subagent-end',
  'error', 'disconnect',
])

function isFlushEvent(type: string): boolean {
  return FLUSH_EVENT_TYPES.has(type)
}

/** Get the userData path from the main process. Lazy import to avoid circular deps. */
async function getUserDataPath(): Promise<string> {
  const { app } = await import('electron')
  return app.getPath('userData')
}

/** Get the threads directory path, creating it if needed. */
async function getThreadsDir(): Promise<string> {
  const userData = await getUserDataPath()
  const dir = join(userData, THREADS_DIR)
  await mkdir(dir, { recursive: true })
  return dir
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface OpenThreadResult {
  /** Reconstructed state (all events replayed). */
  state: ThreadState
  /** True if the log was written by a newer schema version. */
  readOnly: boolean
  /** All events for this thread. */
  events: RuntimeEvent[]
}

export interface EventStore {
  /**
   * Open a thread by id.
   * - Runs pending migrations.
   * - If the file doesn't exist, returns an empty thread state (no-op).
   * - If the file is from a newer schema version, returns events with readOnly=true.
   * - Marks non-terminal turns/items as interrupted on recovery.
   */
  open(threadId: string): Promise<OpenThreadResult>

  /**
   * Append a single event. Flushes immediately for terminal events,
   * coalesces text/reasoning deltas.
   */
  append(threadId: string, event: RuntimeEvent): Promise<void>

  /**
   * Force-flush any pending coalesced deltas for a thread.
   */
  flush(threadId: string): Promise<void>

  /**
   * List all thread ids in the store.
   */
  listThreads(): Promise<string[]>

  /**
   * Delete a thread and its index.
   */
  deleteThread(threadId: string): Promise<void>

  /**
   * Get the current ThreadState for a thread (from memory or replayed).
   */
  getState(threadId: string): ThreadState | undefined

  /**
   * Get events for a thread, optionally paginated by sequence range.
   */
  getEvents(threadId: string, fromSeq?: number): Promise<RuntimeEvent[]>
}

class EventStoreImpl implements EventStore {
  private states = new Map<string, ThreadState>()
  private pendingDeltas = new Map<string, RuntimeEvent[]>()
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private writeQueues = new Map<string, Promise<void>>()

  async open(threadId: string): Promise<OpenThreadResult> {
    const dir = await getThreadsDir()
    const filePath = join(dir, `${threadId}.jsonl`)

    let readOnly = false
    try {
      const result = await runMigrations(filePath)
      readOnly = result.readOnly
    } catch {
      // Migration failed — log is corrupt; open what we can or return empty
    }

    const events = await this.readEventsFromFile(filePath)

    if (events.length === 0) {
      const state = emptyThreadState(threadId)
      this.states.set(threadId, state)
      return { state, readOnly, events: [] }
    }

    // Replay to reconstruct state
    let state: ThreadState
    try {
      state = replay(events)
    } catch {
      // Corrupt log — mark non-terminal as interrupted
      state = this.recoverPartial(events)
    }

    this.states.set(threadId, state)
    if (readOnly) return { state, readOnly, events }

    const recoveryEvents = this.buildRecoveryEvents(state)
    for (const recoveryEvent of recoveryEvents) {
      await this.append(threadId, recoveryEvent)
    }

    return {
      state: this.states.get(threadId) ?? state,
      readOnly,
      events: [...events, ...recoveryEvents],
    }
  }

  async append(threadId: string, event: RuntimeEvent): Promise<void> {
    const currentState = this.states.get(threadId) ?? emptyThreadState(threadId)
    try {
      const nextState = reduce(currentState, event)
      this.states.set(threadId, nextState)
    } catch (cause) {
      throw new Error(
        `Rejected runtime event ${event.type} at sequence ${event.sequence}.`,
        { cause },
      )
    }

    if (isFlushEvent(event.type)) {
      await this.flush(threadId)
      await this.enqueueWrite(threadId, async () => {
        const dir = await getThreadsDir()
        const filePath = join(dir, `${threadId}.jsonl`)
        await this.appendToFile(filePath, event)
        await this.updateIndex(threadId, event.sequence)
      })
    } else {
      const pending = this.pendingDeltas.get(threadId) ?? []
      pending.push(event)
      this.pendingDeltas.set(threadId, pending)

      const existing = this.flushTimers.get(threadId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        void this.flush(threadId).catch(() => {
          // A later explicit flush or append will surface persistent I/O errors.
        })
      }, CHECKPOINT_COALESCE_MS)
      this.flushTimers.set(threadId, timer)
    }
  }

  async flush(threadId: string): Promise<void> {
    const existing = this.flushTimers.get(threadId)
    if (existing) { clearTimeout(existing); this.flushTimers.delete(threadId) }
    const pending = this.pendingDeltas.get(threadId) ?? []
    this.pendingDeltas.delete(threadId)
    await this.enqueueWrite(threadId, async () => {
      if (pending.length === 0) return
      const dir = await getThreadsDir()
      const filePath = join(dir, `${threadId}.jsonl`)
      for (const delta of pending) await this.appendToFile(filePath, delta)
    })
  }

  async listThreads(): Promise<string[]> {
    const dir = await getThreadsDir()
    return listThreadIds(dir)
  }

  async deleteThread(threadId: string): Promise<void> {
    this.states.delete(threadId)
    this.pendingDeltas.delete(threadId)
    const t = this.flushTimers.get(threadId)
    if (t) { clearTimeout(t); this.flushTimers.delete(threadId) }
    await this.enqueueWrite(threadId, async () => {
      const dir = await getThreadsDir()
      const { deleteThreadFiles } = await import('./thread-index')
      await deleteThreadFiles(dir, threadId)
    })
  }

  getState(threadId: string): ThreadState | undefined {
    return this.states.get(threadId)
  }

  async getEvents(threadId: string, fromSeq?: number): Promise<RuntimeEvent[]> {
    await this.flush(threadId)
    const dir = await getThreadsDir()
    const filePath = join(dir, `${threadId}.jsonl`)
    const events = await this.readEventsFromFile(filePath)
    if (fromSeq !== undefined) {
      return events.filter((e) => e.sequence >= fromSeq)
    }
    return events
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async enqueueWrite(threadId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(threadId) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(operation)
    this.writeQueues.set(threadId, queued)
    try {
      await queued
    } finally {
      if (this.writeQueues.get(threadId) === queued) this.writeQueues.delete(threadId)
    }
  }

  private async appendToFile(filePath: string, event: RuntimeEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n'
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, line, 'utf8')
  }

  private async readEventsFromFile(filePath: string): Promise<RuntimeEvent[]> {
    const events: RuntimeEvent[] = []
    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' })
      const rl = createInterface({ input: stream } as ReadLineOptions)
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          events.push(JSON.parse(trimmed) as RuntimeEvent)
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File doesn't exist → empty events
    }
    return events
  }

  private async updateIndex(threadId: string, seq: number): Promise<void> {
    try {
      const dir = await getThreadsDir()
      const state = this.states.get(threadId)
      const idx: ThreadIndex = {
        threadId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        title: `Thread ${threadId}`,
        turnCount: state ? Object.keys(state.turns).length : 0,
        lastSequence: seq,
        activeTurnId: state?.activeTurnId,
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        readOnly: false,
      }
      await writeThreadIndex(dir, idx)
    } catch {
      // Index write failure is non-fatal
    }
  }

  /** Given a list of events where replay threw, recover what's possible. */
  private recoverPartial(events: RuntimeEvent[]): ThreadState {
    // Sort by sequence, drop the last event (the one that caused the error)
    const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
    return replay(sorted.slice(0, -1))
  }

  /** Build durable terminal events for work left active by a process crash. */
  private buildRecoveryEvents(state: ThreadState): RuntimeEvent[] {
    const events: RuntimeEvent[] = []
    let sequence = state.sequence + 1
    const timestamp = Date.now()

    for (const itemId of state.itemOrder) {
      const item = state.items[itemId]
      if (!item || item.status !== 'in_progress') continue
      events.push({
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId: state.threadId,
        turnId: item.turnId,
        itemId,
        sequence: sequence++,
        timestamp,
        type: 'item-end',
        payload: { itemId, status: 'interrupted' },
      })
    }

    for (const turnId of state.turnOrder) {
      const turn = state.turns[turnId]
      if (
        !turn ||
        turn.status === 'completed' ||
        turn.status === 'failed' ||
        turn.status === 'interrupted'
      ) continue
      events.push({
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        threadId: state.threadId,
        turnId,
        sequence: sequence++,
        timestamp,
        type: 'turn-interrupted',
        payload: { turnId, reason: 'error' },
      })
    }

    return events
  }
}

// ── Singleton export ───────────────────────────────────────────────────────

let _store: EventStore | null = null

/** Get the singleton EventStore instance. */
export function getEventStore(): EventStore {
  if (!_store) _store = new EventStoreImpl()
  return _store
}

export function _resetEventStore(): void {
  _store = null
}

/** Async generator that yields lines from a Node.js readable stream. */
export async function* readLines(
  stream: ReturnType<typeof createReadStream>,
): AsyncGenerator<string> {
  const rl = createInterface({ input: stream } as ReadLineOptions)
  for await (const line of rl) {
    yield line
  }
}
