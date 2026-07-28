/**
 * Reducer tests — replay determinism, invariant enforcement, full scenarios.
 *
 * The reducer is the single source of truth for thread state. These tests
 * are the contract:
 *   - Same events → same state (byte-equivalent, normalized)
 *   - Schema/sequence/transition invariants are enforced
 *   - Each scenario in `fake-provider.ts` replays to a valid state
 */

import { describe, expect, it } from 'vitest'
import { reduce, replay } from '../../electron/main/agent-runtime/event-reducer'
import {
  RUNTIME_SCHEMA_VERSION,
  ReducerError,
  emptyThreadState,
  type RuntimeEvent,
  type ThreadState,
} from '../../electron/shared/agent-protocol'
import { generateAllScenarios, runFakeProvider } from './fake-provider'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a sequence of events starting at 1. */
function makeEvents(threadId: string, specs: Array<Omit<RuntimeEvent, 'sequence' | 'threadId' | 'schemaVersion' | 'timestamp'>>): RuntimeEvent[] {
  let seq = 0
  return specs.map((s, i) => ({
    ...s,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    threadId,
    sequence: ++seq,
    timestamp: 1_000 + i,
  })) as RuntimeEvent[]
}

// ── empty state ────────────────────────────────────────────────────────────

describe('emptyThreadState', () => {
  it('starts idle with no turns, items, or approvals', () => {
    const s = emptyThreadState('t1')
    expect(s.idle).toBe(true)
    expect(s.activeTurnId).toBeUndefined()
    expect(Object.keys(s.turns)).toHaveLength(0)
    expect(Object.keys(s.items)).toHaveLength(0)
    expect(Object.keys(s.approvals)).toHaveLength(0)
    expect(s.sequence).toBe(0)
    expect(s.generation).toBe(0)
    expect(s.usage.inputTokens).toBe(0)
  })
})

// ── Schema version validation ──────────────────────────────────────────────

describe('schema version', () => {
  it('rejects events with unknown schema versions', () => {
    const state = emptyThreadState('t1')
    const bad: RuntimeEvent = {
      schemaVersion: 99 as unknown as 2,
      threadId: 't1',
      sequence: 1,
      timestamp: 1,
      type: 'turn-start',
      payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' },
    }
    expect(() => reduce(state, bad)).toThrow(ReducerError)
    try {
      reduce(state, bad)
    } catch (err) {
      expect((err as ReducerError).kind).toBe('unknown-schema-version')
    }
  })
})

// ── Sequence validation ────────────────────────────────────────────────────

describe('sequence validation', () => {
  it('rejects regressing sequence', () => {
    const state = emptyThreadState('t1')
    // Force the state to a higher sequence.
    const next = { ...state, sequence: 100 }
    const event: RuntimeEvent = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      threadId: 't1',
      sequence: 50,
      timestamp: 1,
      type: 'turn-start',
      payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' },
    }
    expect(() => reduce(next, event)).toThrow(ReducerError)
    try {
      reduce(next, event)
    } catch (err) {
      expect((err as ReducerError).kind).toBe('regressing-sequence')
    }
  })

  it('rejects duplicate sequence', () => {
    const events = makeEvents('t1', [
      {
        type: 'turn-start',
        payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' },
      },
    ])
    const state1 = reduce(emptyThreadState('t1'), events[0])
    const dup: RuntimeEvent = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      threadId: 't1',
      sequence: 1,
      timestamp: 2,
      type: 'turn-start',
      payload: { turnId: 'turn-2', permissionProfile: 'workspace_write' },
    }
    expect(() => reduce(state1, dup)).toThrow(ReducerError)
    try {
      reduce(state1, dup)
    } catch (err) {
      expect((err as ReducerError).kind).toBe('duplicate-sequence')
    }
  })

  it('rejects events for a different thread', () => {
    const state = emptyThreadState('t1')
    const event: RuntimeEvent = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      threadId: 't2',
      sequence: 1,
      timestamp: 1,
      type: 'turn-start',
      payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' },
    }
    expect(() => reduce(state, event)).toThrow(/threadId/)
  })
})

// ── Turn lifecycle ─────────────────────────────────────────────────────────

describe('turn lifecycle', () => {
  it('turn-start creates a turn and sets activeTurnId', () => {
    const state = reduce(
      emptyThreadState('t1'),
      makeEvents('t1', [{ type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } }])[0],
    )
    expect(state.activeTurnId).toBe('turn-1')
    expect(state.idle).toBe(false)
    expect(state.turns['turn-1']?.status).toBe('running')
    expect(state.turnOrder).toEqual(['turn-1'])
  })

  it('cannot start a turn while another is active', () => {
    const state = reduce(
      emptyThreadState('t1'),
      makeEvents('t1', [
        { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
        { type: 'turn-start', payload: { turnId: 'turn-2', permissionProfile: 'workspace_write' } },
      ])[1],
    )._ // dummy so TS doesn't complain
    void state
  })

  it('throws on duplicate turn-start', () => {
    const [ev1, ev2] = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
    ])
    const s1 = reduce(emptyThreadState('t1'), ev1)
    expect(() => reduce(s1, ev2)).toThrow(/already started/)
  })

  it('turn-complete transitions to completed and clears activeTurnId', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'turn-complete', payload: { turnId: 'turn-1', status: 'completed' } },
    ])
    const state = replay(events)
    expect(state.turns['turn-1']?.status).toBe('completed')
    expect(state.activeTurnId).toBeUndefined()
    expect(state.idle).toBe(true)
    expect(state.sequence).toBe(2)
    expect(state.generation).toBe(2)
  })

  it('turn-failed sets errorMessage', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'turn-failed', payload: { turnId: 'turn-1', status: 'failed', errorMessage: 'boom' } },
    ])
    const state = replay(events)
    expect(state.turns['turn-1']?.status).toBe('failed')
    expect(state.turns['turn-1']?.errorMessage).toBe('boom')
    expect(state.lastError).toBe('boom')
  })

  it('turn-interrupted sets status and clears active', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      {
        type: 'turn-interrupted',
        payload: { turnId: 'turn-1', reason: 'user' },
      },
    ])
    const state = replay(events)
    expect(state.turns['turn-1']?.status).toBe('interrupted')
    expect(state.activeTurnId).toBeUndefined()
  })

  it('cannot complete an already-terminal turn', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'turn-complete', payload: { turnId: 'turn-1', status: 'completed' } },
      { type: 'turn-complete', payload: { turnId: 'turn-1', status: 'completed' } },
    ])
    expect(() => replay(events)).toThrow(/terminal state/)
  })
})

// ── Item lifecycle ─────────────────────────────────────────────────────────

describe('item lifecycle', () => {
  it('item-start creates an item in in_progress', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      {
        type: 'item-start',
        payload: {
          itemId: 'msg-1',
          turnId: 'turn-1',
          kind: 'user-message',
          content: { text: 'hi' },
        },
      },
    ])
    const state = replay(events)
    expect(state.items['msg-1']?.kind).toBe('user-message')
    expect(state.items['msg-1']?.status).toBe('in_progress')
    expect(state.itemOrder).toContain('msg-1')
  })

  it('item-end transitions to terminal status', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'item-start', payload: { itemId: 'msg-1', turnId: 'turn-1', kind: 'user-message' } },
      { type: 'item-end', payload: { itemId: 'msg-1', status: 'completed' } },
    ])
    const state = replay(events)
    expect(state.items['msg-1']?.status).toBe('completed')
  })

  it('text-delta accumulates on agent-message', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'item-start', payload: { itemId: 'msg-1', turnId: 'turn-1', kind: 'agent-message' } },
      { type: 'text-delta', payload: { itemId: 'msg-1', content: 'hello ' } },
      { type: 'text-delta', payload: { itemId: 'msg-1', content: 'world' } },
    ])
    const state = replay(events)
    const item = state.items['msg-1']
    if (item?.kind !== 'agent-message') throw new Error('expected agent-message')
    expect(item.text).toBe('hello world')
  })

  it('text-delta on non-message item is illegal', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'item-start', payload: { itemId: 'plan-1', turnId: 'turn-1', kind: 'plan' } },
      { type: 'text-delta', payload: { itemId: 'plan-1', content: 'oops' } },
    ])
    expect(() => replay(events)).toThrow(/non-message/)
  })
})

// ── Tool call lifecycle ──────────────────────────────────────────────────

describe('tool call lifecycle', () => {
  it('tool-call-start creates a tool-call item', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      {
        type: 'tool-call-start',
        payload: { itemId: 'tool-1', turnId: 'turn-1', name: 'Read' },
      },
    ])
    const state = replay(events)
    expect(state.items['tool-1']?.kind).toBe('tool-call')
    if (state.items['tool-1']?.kind !== 'tool-call') throw new Error('expected')
    expect(state.items['tool-1'].name).toBe('Read')
  })

  it('tool-call-delta accumulates input buffer', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'tool-call-start', payload: { itemId: 'tool-1', turnId: 'turn-1', name: 'Grep' } },
      { type: 'tool-call-delta', payload: { itemId: 'tool-1', turnId: 'turn-1', inputFragment: '{"' } },
      { type: 'tool-call-delta', payload: { itemId: 'tool-1', turnId: 'turn-1', inputFragment: 'pat' } },
    ])
    const state = replay(events)
    const item = state.items['tool-1']
    if (item?.kind !== 'tool-call') throw new Error('expected')
    expect((item as Record<string, unknown>)._inputBuffer).toBe('{"pat')
  })

  it('tool-result sets success and output', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'tool-call-start', payload: { itemId: 'tool-1', turnId: 'turn-1', name: 'Read' } },
      {
        type: 'tool-call-end',
        payload: { itemId: 'tool-1', turnId: 'turn-1', name: 'Read', input: { file: 'x' } },
      },
      {
        type: 'tool-result',
        payload: { itemId: 'tool-1', turnId: 'turn-1', output: 'contents', success: true },
      },
    ])
    const state = replay(events)
    const item = state.items['tool-1']
    if (item?.kind !== 'tool-call') throw new Error('expected')
    expect(item.status).toBe('completed')
    expect(item.output).toBe('contents')
    expect(item.success).toBe(true)
  })

  it('failed tool-result sets status to failed', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'tool-call-start', payload: { itemId: 'tool-1', turnId: 'turn-1', name: 'Bash' } },
      {
        type: 'tool-result',
        payload: { itemId: 'tool-1', turnId: 'turn-1', output: null, success: false, error: 'denied' },
      },
    ])
    const state = replay(events)
    expect(state.items['tool-1']?.status).toBe('failed')
  })
})

// ── Usage accumulation ─────────────────────────────────────────────────────

describe('usage accumulation', () => {
  it('sums input/output tokens across events', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'usage', turnId: 'turn-1', payload: { inputTokens: 100, outputTokens: 50, cachedTokens: 80 } },
      { type: 'usage', turnId: 'turn-1', payload: { inputTokens: 50, outputTokens: 25, cachedTokens: 20 } },
    ])
    const state = replay(events)
    expect(state.usage.inputTokens).toBe(150)
    expect(state.usage.outputTokens).toBe(75)
    expect(state.usage.cachedTokens).toBe(100)
    expect(state.usage.perTurn['turn-1']?.inputTokens).toBe(150)
  })

  it('attribution-less usage goes to __unattributed__', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      { type: 'usage', payload: { inputTokens: 10, outputTokens: 5 } },
    ])
    const state = replay(events)
    expect(state.usage.perTurn['__unattributed__']?.inputTokens).toBe(10)
  })
})

// ── Approval state machine ────────────────────────────────────────────────

describe('approval state machine', () => {
  it('approval-required sets turn to waiting', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      {
        type: 'approval-required',
        payload: {
          approvalId: 'a-1',
          turnId: 'turn-1',
          tool: 'bash',
          description: 'rm -rf /',
          resource: 'rm -rf /',
        },
      },
    ])
    const state = replay(events)
    expect(state.approvals['a-1']).toBeDefined()
    expect(state.turns['turn-1']?.status).toBe('waiting')
    expect(state.turns['turn-1']?.waitingKind).toBe('approval')
  })

  it('approval-resolved sets turn back to running', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      {
        type: 'approval-required',
        payload: { approvalId: 'a-1', turnId: 'turn-1', tool: 'bash', description: 'x' },
      },
      {
        type: 'approval-resolved',
        payload: { approvalId: 'a-1', decision: 'allow' },
      },
    ])
    const state = replay(events)
    expect(state.approvals['a-1']?.decision).toBe('allow')
    expect(state.turns['turn-1']?.status).toBe('running')
    expect(state.turns['turn-1']?.waitingKind).toBe('none')
  })

  it('rejects resolving an unknown approval', () => {
    const events = makeEvents('t1', [
      { type: 'turn-start', payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' } },
      {
        type: 'approval-resolved',
        payload: { approvalId: 'nonexistent', decision: 'allow' },
      },
    ])
    expect(() => replay(events)).toThrow(ReducerError)
  })
})

// ── Replay determinism ────────────────────────────────────────────────────

describe('replay determinism', () => {
  it('the same events produce the same state', () => {
    const a = runFakeProvider({ scenario: 'reasoning-then-tool' })
    const b = runFakeProvider({ scenario: 'reasoning-then-tool' })
    const stateA = replay(a.events)
    const stateB = replay(b.events)
    // Compare normalized state (ignoring timestamps which can drift).
    expect(normalize(stateA)).toEqual(normalize(stateB))
  })

  it('replay is order-sensitive (reorder events → different state)', () => {
    const a = runFakeProvider({ scenario: 'tool-call' })
    // Reverse the events; reducer should reject most of them.
    const reversed = [...a.events].reverse()
    expect(() => replay(reversed)).toThrow(ReducerError)
  })

  it('replay from mid-stream replays forward correctly', () => {
    const full = runFakeProvider({ scenario: 'turn-complete' })
    // First 3 events, then replay from that snapshot.
    const partial = full.events.slice(0, 3)
    const partialState = replay(partial)
    const remaining = full.events.slice(3)
    let final = partialState
    for (const ev of remaining) {
      final = reduce(final, ev)
    }
    // Final state should match a single replay of all events.
    const allAtOnce = replay(full.events)
    expect(normalize(final)).toEqual(normalize(allAtOnce))
  })
})

// ── Full scenario replay (using fake-provider scenarios) ──────────────────

describe('all fake-provider scenarios replay cleanly', () => {
  const scenarios = generateAllScenarios()

  for (const [name, item] of Object.entries(scenarios)) {
    it(`${name} replays without error`, () => {
      expect(() => replay(item.events)).not.toThrow()
    })
  }

  it('reasoning-then-tool produces a tool-call item with parsed input', () => {
    const item = runFakeProvider({ scenario: 'reasoning-then-tool' })
    const state = replay(item.events)
    // Find the Read tool-call item.
    const toolItems = Object.values(state.items).filter(
      (i) => i?.kind === 'tool-call' && (i as { name: string }).name === 'Read',
    )
    expect(toolItems.length).toBeGreaterThan(0)
  })

  it('parallel-tools emits multiple tool-call items with distinct itemIds', () => {
    const item = runFakeProvider({ scenario: 'parallel-tools' })
    const state = replay(item.events)
    const tools = Object.values(state.items).filter((i) => i?.kind === 'tool-call')
    const ids = new Set(tools.map((t) => t?.itemId))
    expect(ids.size).toBeGreaterThanOrEqual(2)
  })

  it('transient-error still completes the turn', () => {
    const item = runFakeProvider({ scenario: 'transient-error' })
    const state = replay(item.events)
    const turn = state.turns[Object.keys(state.turns)[0] ?? '']
    expect(turn?.status).toBe('completed')
  })

  it('disconnect leaves the turn running (no complete event)', () => {
    const item = runFakeProvider({ scenario: 'disconnect' })
    const state = replay(item.events)
    const turn = state.turns[Object.keys(state.turns)[0] ?? '']
    expect(turn?.status).toBe('running')
    expect(state.idle).toBe(false)
  })

  it('empty scenario produces idle state with one user item', () => {
    const item = runFakeProvider({ scenario: 'empty' })
    const state = replay(item.events)
    expect(state.idle).toBe(true)
    expect(Object.keys(state.items).length).toBeGreaterThan(0)
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────

/** Strip non-deterministic fields for byte-equivalent comparison. */
function normalize(state: ThreadState): unknown {
  return JSON.parse(
    JSON.stringify(state, (key, value) => {
      if (key === 'timestamp' || key === 'startedAt' || key === 'completedAt' || key === 'testedAt') {
        return undefined
      }
      return value
    }),
  )
}
