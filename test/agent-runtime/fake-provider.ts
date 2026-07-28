/**
 * Deterministic fake provider for testing the agent runtime.
 *
 * Emits realistic model event sequences without any real API calls:
 * - Text and reasoning deltas
 * - Fragmented tool-call input JSON
 * - Parallel tool calls
 * - Usage snapshots
 * - Transient errors and disconnects
 *
 * All sequences are seeded so the same test input always produces the same
 * output. Events conform to the `RuntimeEvent` protocol in
 * `electron/shared/agent-protocol.ts` — replayed through the reducer they
 * produce a valid `ThreadState`.
 */

import type {
  RuntimeEvent,
  RuntimeEventType,
  ThreadState,
} from '../../electron/shared/agent-protocol'
import { RUNTIME_SCHEMA_VERSION } from '../../electron/shared/agent-protocol'

// ── Seeded PRNG (xorshift32) ────────────────────────────────────────────────

class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /** Returns a float in [0, 1). */
  next(): number {
    // eslint-disable-next-line no-bitwise
    this.state ^= this.state << 13
    // eslint-disable-next-line no-bitwise
    this.state ^= this.state >> 17
    // eslint-disable-next-line no-bitwise
    this.state ^= this.state << 5
    return (this.state >>> 0) / 0x100000000
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max)
  }
}

// ── Event builder helpers ────────────────────────────────────────────────────

let _seq = 0
function nextSeq() {
  return ++_seq
}

function makeEvent<T extends RuntimeEventType>(
  threadId: string,
  type: T,
  payload: RuntimeEvent[typeof type],
  overrides: Partial<Pick<RuntimeEvent, 'turnId' | 'itemId'>> = {},
): RuntimeEvent<T> {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    threadId,
    sequence: nextSeq(),
    timestamp: Date.now(),
    type,
    payload,
    ...overrides,
  } as RuntimeEvent<T>
}

// ── Scenario definitions ─────────────────────────────────────────────────────

export type Scenario =
  | 'simple-text'
  | 'tool-call'
  | 'reasoning-then-tool'
  | 'parallel-tools'
  | 'fragmented-tool-input'
  | 'transient-error'
  | 'disconnect'
  | 'mixed-usage'
  | 'turn-complete'
  | 'empty'

export interface FakeProviderOptions {
  scenario: Scenario
  threadId?: string
  seed?: number
  fragmentSize?: number
  errorAfter?: number
  disconnectAfter?: number
}

export interface FakeItem {
  events: RuntimeEvent[]
  finalState: Partial<ThreadState>
  error?: string
  disconnected?: boolean
}

// ── Per-event emitters ──────────────────────────────────────────────────────

function emitTextDelta(
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
  fragmentSize: number,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  for (const chunk of chunks(text, fragmentSize)) {
    events.push(
      makeEvent(threadId, 'text-delta', { itemId, content: chunk }, { turnId, itemId }),
    )
  }
  return events
}

function emitReasoningDelta(
  threadId: string,
  turnId: string,
  itemId: string,
  thought: string,
): RuntimeEvent[] {
  return [
    makeEvent(threadId, 'reasoning-start', { itemId, content: '' }, { turnId, itemId }),
    makeEvent(threadId, 'reasoning-delta', { itemId, content: thought }, { turnId, itemId }),
    makeEvent(threadId, 'reasoning-end', { itemId, content: '' }, { turnId, itemId }),
  ]
}

function emitToolCall(
  threadId: string,
  turnId: string,
  toolName: string,
  args: Record<string, unknown>,
): RuntimeEvent[] {
  const itemId = `item-tool-${toolName}-${nextSeq()}`
  const events: RuntimeEvent[] = []

  events.push(
    makeEvent(
      threadId,
      'tool-call-start',
      { itemId, turnId, name: toolName, input: {} },
      { turnId, itemId },
    ),
  )

  const inputStr = JSON.stringify(args)
  for (const frag of inputStr.split('')) {
    events.push(
      makeEvent(
        threadId,
        'tool-call-delta',
        { itemId, turnId, inputFragment: frag },
        { turnId, itemId },
      ),
    )
  }

  events.push(
    makeEvent(
      threadId,
      'tool-call-end',
      { itemId, turnId, name: toolName, input: args },
      { turnId, itemId },
    ),
  )

  return events
}

function emitParallelTools(threadId: string, turnId: string): RuntimeEvent[] {
  return [
    ...emitToolCall(threadId, turnId, 'Read', { file_path: '/src/index.ts' }),
    ...emitToolCall(threadId, turnId, 'Grep', { pattern: 'TODO', path: '/src' }),
  ]
}

function emitUsage(
  threadId: string,
  turnId: string,
  cached = false,
): RuntimeEvent {
  return makeEvent(
    threadId,
    'usage',
    {
      inputTokens: 120,
      outputTokens: 340,
      cachedTokens: cached ? 90 : 0,
      costUSD: cached ? 0.00018 : 0.00123,
    },
    { turnId },
  )
}

function emitError(threadId: string, message: string): RuntimeEvent {
  return makeEvent(threadId, 'error', { message, code: 'PROVIDER_ERROR', retryable: true })
}

function emitUserMessage(threadId: string, turnId: string, text: string): RuntimeEvent[] {
  const itemId = `item-user-${nextSeq()}`
  return [
    makeEvent(
      threadId,
      'item-start',
      { itemId, turnId, kind: 'user-message', role: 'user', content: { text } },
      { turnId, itemId },
    ),
    makeEvent(
      threadId,
      'item-end',
      { itemId, status: 'completed' },
      { turnId, itemId },
    ),
  ]
}

/** Emit an agent-message item-start and return both the events and the itemId. */
function emitAgentMessageStart(threadId: string, turnId: string): { events: RuntimeEvent[]; itemId: string } {
  const itemId = `item-msg-ai-${nextSeq()}`
  const event = makeEvent(
    threadId,
    'item-start',
    { itemId, turnId, kind: 'agent-message', role: 'assistant', content: { text: '' } },
    { turnId, itemId },
  )
  return { events: [event], itemId }
}

/** Emit a reasoning item-start and return both the events and the itemId. */
function emitReasoningStart(threadId: string, turnId: string): { events: RuntimeEvent[]; itemId: string } {
  const itemId = `item-reasoning-${nextSeq()}`
  const event = makeEvent(
    threadId,
    'item-start',
    { itemId, turnId, kind: 'reasoning', content: { text: '' } },
    { turnId, itemId },
  )
  return { events: [event], itemId }
}

// ── Main runner ─────────────────────────────────────────────────────────────

export function runFakeProvider(opts: FakeProviderOptions): FakeItem {
  _seq = 0

  const {
    scenario,
    threadId = 'thread-test-1',
    seed = 42,
    fragmentSize = 1,
  } = opts

  const rng = new SeededRandom(seed)
  const events: RuntimeEvent[] = []
  let error: string | undefined
  let disconnected = false
  const turnId = 'turn-1'
  const finalState: Partial<ThreadState> = {}

  switch (scenario) {
    case 'empty': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, ''))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      break
    }

    case 'simple-text': {
      const text = 'Hello, world!'
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'hi'))
      const { events: aiStart, itemId: aiId } = emitAgentMessageStart(threadId, turnId)
      events.push(...aiStart, ...emitTextDelta(threadId, turnId, aiId, text, fragmentSize))
      events.push(
        makeEvent(
          threadId,
          'item-end',
          { itemId: aiId, status: 'completed' },
          { turnId, itemId: aiId },
        ),
      )
      events.push(emitUsage(threadId, turnId))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      break
    }

    case 'reasoning-then-tool': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'help'))
      const { events: rStart, itemId: reasonId } = emitReasoningStart(threadId, turnId)
      events.push(
        ...rStart,
        ...emitReasoningDelta(threadId, turnId, reasonId, "The user wants me to read a file. I'll use the Read tool."),
      )
      // emitReasoningDelta already emits reasoning-start / reasoning-delta /
      // reasoning-end. Reasoning items terminate via the kind-specific signal
      // (no separate `item-end` — the reducer treats reasoning-end as terminal).
      events.push(...emitToolCall(threadId, turnId, 'Read', { file_path: '/src/index.ts' }))
      events.push(...emitToolCall(threadId, turnId, 'Edit', { file_path: '/src/index.ts', old_string: 'foo', new_string: 'bar' }))
      events.push(emitUsage(threadId, turnId))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      break
    }

    case 'tool-call': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'ls'))
      events.push(...emitToolCall(threadId, turnId, 'Bash', { command: 'ls -la', timeout: 30000 }))
      events.push(emitUsage(threadId, turnId))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      break
    }

    case 'parallel-tools': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'check'))
      events.push(...emitParallelTools(threadId, turnId))
      events.push(emitUsage(threadId, turnId))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      break
    }

    case 'fragmented-tool-input': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'grep'))
      events.push(...emitToolCall(threadId, turnId, 'Grep', { pattern: 'TODO', path: '/src', case_sensitive: false }))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      break
    }

    case 'transient-error': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'retry'))
      const { events: aiStartRetry, itemId: aiId } = emitAgentMessageStart(threadId, turnId)
      events.push(...aiStartRetry, ...emitTextDelta(threadId, turnId, aiId, 'Starting... ', fragmentSize))
      events.push(emitError(threadId, 'Transient upstream error — retrying'))
      events.push(...emitTextDelta(threadId, turnId, aiId, 'Retrying... ', fragmentSize))
      events.push(...emitToolCall(threadId, turnId, 'Read', { file_path: '/src/main.ts' }))
      events.push(emitUsage(threadId, turnId))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      break
    }

    case 'disconnect': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'go'))
      const { events: aiStartDisc, itemId: aiId } = emitAgentMessageStart(threadId, turnId)
      events.push(...aiStartDisc, ...emitTextDelta(threadId, turnId, aiId, 'Working... ', fragmentSize))
      events.push(makeEvent(threadId, 'disconnect', { reason: 'network' }, { turnId }))
      disconnected = true
      break
    }

    case 'mixed-usage': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'go'))
      const { events: aiStartMix, itemId: aiId } = emitAgentMessageStart(threadId, turnId)
      events.push(...aiStartMix, ...emitTextDelta(threadId, turnId, aiId, 'Reading the codebase... ', fragmentSize))
      events.push(emitUsage(threadId, turnId, false))
      events.push(...emitToolCall(threadId, turnId, 'Read', { file_path: '/src/index.ts' }))
      events.push(emitUsage(threadId, turnId, true))
      events.push(...emitTextDelta(threadId, turnId, aiId, 'Done!', fragmentSize))
      events.push(emitUsage(threadId, turnId, false))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      break
    }

    case 'turn-complete': {
      events.push(makeEvent(threadId, 'turn-start', { turnId, permissionProfile: 'workspace_write' }, { turnId }))
      events.push(...emitUserMessage(threadId, turnId, 'finish'))
      const { events: aiStartDone, itemId: aiId } = emitAgentMessageStart(threadId, turnId)
      events.push(...aiStartDone, ...emitTextDelta(threadId, turnId, aiId, 'All done.', fragmentSize))
      events.push(
        makeEvent(
          threadId,
          'item-end',
          { itemId: aiId, status: 'completed' },
          { turnId, itemId: aiId },
        ),
      )
      events.push(emitUsage(threadId, turnId))
      events.push(makeEvent(threadId, 'turn-complete', { turnId, status: 'completed' }, { turnId }))
      finalState.activeTurnId = undefined
      break
    }
  }

  void rng // silence "unused" if a future scenario drops it
  return { events, finalState, error, disconnected }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function chunks(text: string, size: number): string[] {
  const result: string[] = []
  for (let i = 0; i < text.length; i += size) {
    result.push(text.slice(i, i + size))
  }
  return result
}

export function generateAllScenarios(): Record<Scenario, FakeItem> {
  const scenarios: Scenario[] = [
    'empty', 'simple-text', 'reasoning-then-tool', 'tool-call',
    'parallel-tools', 'fragmented-tool-input', 'transient-error',
    'disconnect', 'mixed-usage', 'turn-complete',
  ]
  const result = {} as Record<Scenario, FakeItem>
  for (const s of scenarios) {
    result[s] = runFakeProvider({ scenario: s, seed: 123 })
  }
  return result
}
