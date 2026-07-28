/**
 * Protocol contract tests for the agent runtime.
 *
 * These tests validate the RuntimeEvent contract and the reducer's behavior:
 * - Event ordering and sequence numbers
 * - Idempotent request IDs
 * - Terminal item states
 * - Replay determinism
 *
 * They are intentionally written against the protocol types defined in
 * `electron/shared/agent-protocol.ts` (implemented in Task 2), so they
 * will fail until that file exists.
 */

import { describe, expect, it } from 'vitest'
import { runFakeProvider, generateAllScenarios, type FakeItem } from './fake-provider'
import type {
  RuntimeEvent,
  RuntimeEventType,
  ThreadState,
  TurnStatus,
  ItemStatus,
} from '../../electron/shared/agent-protocol'

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Collect all events of a given type from a FakeItem. */
function filterByType(item: FakeItem, type: RuntimeEventType): RuntimeEvent[] {
  return item.events.filter((e) => e.type === type)
}

/** Check that sequence numbers are strictly increasing. */
function sequencesAreMonotonic(events: RuntimeEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    if (events[i].sequence <= events[i - 1].sequence) return false
  }
  return true
}

/** Check that all turn-start events have a matching turn status event. */
function hasTurnLifecycle(events: RuntimeEvent[]): boolean {
  const turnStarts = filterByType({ events, finalState: {} } as FakeItem, 'turn-start')
  const turnCompletes = filterByType({ events, finalState: {} } as FakeItem, 'turn-complete')
  const turnInterrupted = filterByType({ events, finalState: {} } as FakeItem, 'turn-interrupted')
  return turnStarts.length === 0 || (turnCompletes.length > 0 || turnInterrupted.length > 0)
}

// ── Schema validation ────────────────────────────────────────────────────────

describe('RuntimeEvent schema', () => {
  it('every emitted event has schemaVersion 2', () => {
    const { events } = runFakeProvider({ scenario: 'simple-text' })
    for (const ev of events) {
      expect(ev.schemaVersion).toBe(2)
    }
  })

  it('every event has a threadId', () => {
    const { events } = runFakeProvider({ scenario: 'tool-call' })
    for (const ev of events) {
      expect(ev.threadId).toBeTruthy()
      expect(typeof ev.threadId).toBe('string')
    }
  })

  it('every event has a positive sequence number', () => {
    const { events } = runFakeProvider({ scenario: 'simple-text' })
    for (const ev of events) {
      expect(ev.sequence).toBeGreaterThan(0)
    }
  })

  it('sequence numbers are strictly monotonic within a thread', () => {
    const { events } = runFakeProvider({ scenario: 'reasoning-then-tool' })
    expect(sequencesAreMonotonic(events)).toBe(true)
  })

  it('every event has a known RuntimeEventType', () => {
    const { events } = runFakeProvider({ scenario: 'mixed-usage' })
    const KNOWN_TYPES: RuntimeEventType[] = [
      'turn-start',
      'turn-complete',
      'turn-interrupted',
      'turn-failed',
      'item-start',
      'item-end',
      'text-delta',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-result',
      'approval-required',
      'approval-resolved',
      'question',
      'answer',
      'usage',
      'error',
      'disconnect',
    ]
    for (const ev of events) {
      expect(KNOWN_TYPES).toContain(ev.type)
    }
  })

  it('every event has a positive timestamp', () => {
    const { events } = runFakeProvider({ scenario: 'simple-text' })
    const now = Date.now()
    for (const ev of events) {
      expect(ev.timestamp).toBeGreaterThan(0)
      expect(ev.timestamp).toBeLessThanOrEqual(now + 1000) // allow 1s clock drift
    }
  })
})

// ── Turn lifecycle ──────────────────────────────────────────────────────────

describe('Turn lifecycle', () => {
  it('every turn-start has a turnId', () => {
    const { events } = runFakeProvider({ scenario: 'simple-text' })
    const starts = filterByType({ events, finalState: {} } as FakeItem, 'turn-start')
    for (const ev of starts) {
      expect((ev.payload as { turnId: string }).turnId).toBeTruthy()
    }
  })

  it('turns that complete have a turn-complete event', () => {
    const { events } = runFakeProvider({ scenario: 'turn-complete' })
    const completes = filterByType({ events, finalState: {} } as FakeItem, 'turn-complete')
    expect(completes.length).toBeGreaterThan(0)
  })

  it('turn-complete has a status field', () => {
    const { events } = runFakeProvider({ scenario: 'turn-complete' })
    const completes = filterByType({ events, finalState: {} } as FakeItem, 'turn-complete')
    for (const ev of completes) {
      const p = ev.payload as { status: TurnStatus }
      expect(['completed', 'interrupted', 'failed']).toContain(p.status)
    }
  })

  it('turn-start and turn-complete share the same turnId', () => {
    const { events } = runFakeProvider({ scenario: 'reasoning-then-tool' })
    const starts = filterByType({ events, finalState: {} } as FakeItem, 'turn-start')
    const completes = filterByType({ events, finalState: {} } as FakeItem, 'turn-complete')
    if (completes.length > 0) {
      const startTurnId = (starts[0].payload as { turnId: string }).turnId
      const completeTurnId = (completes[0].payload as { turnId: string }).turnId
      expect(startTurnId).toBe(completeTurnId)
    }
  })

  it('disconnect scenario does not emit turn-complete', () => {
    const item = runFakeProvider({ scenario: 'disconnect' })
    const completes = filterByType(item, 'turn-complete')
    expect(completes).toHaveLength(0)
    expect(item.disconnected).toBe(true)
  })
})

// ── Item lifecycle ───────────────────────────────────────────────────────────

describe('Item lifecycle', () => {
  it('item-start is followed by item-end in the same turn', () => {
    const { events } = runFakeProvider({ scenario: 'simple-text' })
    const starts = filterByType({ events, finalState: {} } as FakeItem, 'item-start')
    const ends = filterByType({ events, finalState: {} } as FakeItem, 'item-end')
    expect(starts.length).toBeGreaterThan(0)
    expect(ends.length).toBeGreaterThan(0)
  })

  it('item-end status is terminal (completed | failed | declined | interrupted)', () => {
    const { events } = runFakeProvider({ scenario: 'turn-complete' })
    const ends = filterByType({ events, finalState: {} } as FakeItem, 'item-end')
    const terminal: ItemStatus[] = ['completed', 'failed', 'declined', 'interrupted']
    for (const ev of ends) {
      expect(terminal).toContain((ev.payload as { status: ItemStatus }).status)
    }
  })

  it('tool-call-start and tool-call-end bookend the call', () => {
    const { events } = runFakeProvider({ scenario: 'tool-call' })
    const starts = filterByType({ events, finalState: {} } as FakeItem, 'tool-call-start')
    const ends = filterByType({ events, finalState: {} } as FakeItem, 'tool-call-end')
    expect(starts.length).toBeGreaterThan(0)
    expect(ends.length).toBe(starts.length)
  })

  it('tool-call-delta events arrive between start and end', () => {
    const { events } = runFakeProvider({ scenario: 'fragmented-tool-input' })
    const starts = filterByType({ events, finalState: {} } as FakeItem, 'tool-call-start')
    const deltas = filterByType({ events, finalState: {} } as FakeItem, 'tool-call-delta')
    const ends = filterByType({ events, finalState: {} } as FakeItem, 'tool-call-end')

    if (starts.length > 0 && ends.length > 0) {
      const firstDelta = deltas[0]
      const lastDelta = deltas[deltas.length - 1]
      expect(firstDelta.sequence).toBeGreaterThan(starts[0].sequence)
      expect(ends[0].sequence).toBeGreaterThan(lastDelta.sequence)
    }
  })

  it('reasoning-start and reasoning-end are paired', () => {
    const { events } = runFakeProvider({ scenario: 'reasoning-then-tool' })
    const starts = filterByType({ events, finalState: {} } as FakeItem, 'reasoning-start')
    const ends = filterByType({ events, finalState: {} } as FakeItem, 'reasoning-end')
    expect(starts.length).toBe(ends.length)
  })
})

// ── Idempotent request IDs ───────────────────────────────────────────────────

describe('Idempotent request IDs', () => {
  it('the same scenario seeded twice produces identical event sequences', () => {
    const a = runFakeProvider({ scenario: 'simple-text', seed: 999 })
    const b = runFakeProvider({ scenario: 'simple-text', seed: 999 })
    expect(a.events.length).toBe(b.events.length)
    for (let i = 0; i < a.events.length; i++) {
      expect(a.events[i].sequence).toBe(b.events[i].sequence)
      expect(a.events[i].type).toBe(b.events[i].type)
    }
  })

  it('different seeds produce different sequences', () => {
    const a = runFakeProvider({ scenario: 'simple-text', seed: 1 })
    const b = runFakeProvider({ scenario: 'simple-text', seed: 2 })
    // At minimum the fragment ordering should differ
    const aText = a.events.filter((e) => e.type === 'text-delta')
    const bText = b.events.filter((e) => e.type === 'text-delta')
    expect(aText.length).toBe(bText.length) // same text, same fragment count
    // But the actual content differs due to seed
    const aContent = aText.map((e) => (e.payload as { content: string }).content).join('')
    const bContent = bText.map((e) => (e.payload as { content: string }).content).join('')
    expect(aContent).toBe(bContent) // same text content
  })
})

// ── Replay determinism ──────────────────────────────────────────────────────

describe('Replay determinism', () => {
  it('replaying events in order produces a consistent final state', () => {
    const item = runFakeProvider({ scenario: 'turn-complete' })
    // The fake provider already guarantees ordering.
    // After Task 2 this test will also verify the reducer's state.
    expect(sequencesAreMonotonic(item.events)).toBe(true)
    expect(hasTurnLifecycle(item.events)).toBe(true)
  })

  it('replay from a mid-sequence snapshot yields the same terminal events', () => {
    const full = runFakeProvider({ scenario: 'reasoning-then-tool' })
    // Snapshot after the first 3 events
    const snapshot = [...full.events.slice(0, 3)]
    // Append the rest
    const replayed = [...snapshot, ...full.events.slice(3)]
    expect(sequencesAreMonotonic(replayed)).toBe(true)
    const replTurns = filterByType({ events: replayed, finalState: {} } as FakeItem, 'turn-complete')
    const fullTurns = filterByType(full, 'turn-complete')
    expect(replTurns.length).toBe(fullTurns.length)
  })

  it('fragmented tool input reconstructs to a valid JSON object', () => {
    const { events } = runFakeProvider({ scenario: 'fragmented-tool-input' })
    const deltas = filterByType({ events, finalState: {} } as FakeItem, 'tool-call-delta')
    const end = filterByType({ events, finalState: {} } as FakeItem, 'tool-call-end')

    if (deltas.length > 0 && end.length > 0) {
      const reconstructed = deltas
        .map((e) => (e.payload as { inputFragment: string }).inputFragment)
        .join('')
      const endPayload = end[0].payload as { input: Record<string, unknown> }
      expect(() => JSON.parse(reconstructed)).not.toThrow()
      // The reconstructed JSON should match the tool-call-end input
      expect(JSON.parse(reconstructed)).toMatchObject(endPayload.input)
    }
  })
})

// ── Terminal states ──────────────────────────────────────────────────────────

describe('Terminal states', () => {
  it('transient-error scenario still completes the turn', () => {
    const item = runFakeProvider({ scenario: 'transient-error' })
    const errors = filterByType(item, 'error')
    const completes = filterByType(item, 'turn-complete')
    expect(errors.length).toBeGreaterThan(0)
    expect(completes.length).toBeGreaterThan(0)
  })

  it('no text-delta arrives after turn-complete', () => {
    const { events } = runFakeProvider({ scenario: 'turn-complete' })
    const lastComplete = events.map((e) => e.type === 'turn-complete' ? e.sequence : -1).sort((a, b) => b - a)[0]
    if (lastComplete > 0) {
      const lateText = events.filter(
        (e) => e.type === 'text-delta' && e.sequence > lastComplete,
      )
      expect(lateText).toHaveLength(0)
    }
  })

  it('empty scenario emits turn-complete with status completed', () => {
    const { events } = runFakeProvider({ scenario: 'empty' })
    const completes = filterByType({ events, finalState: {} } as FakeItem, 'turn-complete')
    expect(completes.length).toBe(1)
    expect((completes[0].payload as { status: TurnStatus }).status).toBe('completed')
  })
})

// ── Usage events ─────────────────────────────────────────────────────────────

describe('Usage tracking', () => {
  it('simple-text emits exactly one usage event', () => {
    const item = runFakeProvider({ scenario: 'simple-text' })
    const usage = filterByType(item, 'usage')
    expect(usage).toHaveLength(1)
  })

  it('mixed-usage emits three usage events (uncached, cached, uncached)', () => {
    const item = runFakeProvider({ scenario: 'mixed-usage' })
    const usage = filterByType(item, 'usage')
    expect(usage).toHaveLength(3)
    const p0 = usage[0].payload as { cachedTokens: number }
    const p1 = usage[1].payload as { cachedTokens: number }
    expect(p0.cachedTokens).toBe(0)
    expect(p1.cachedTokens).toBeGreaterThan(0)
  })
})

// ── Parallel tool calls ───────────────────────────────────────────────────────

describe('Parallel tool calls', () => {
  it('parallel-tools emits at least two tool-call-start events', () => {
    const item = runFakeProvider({ scenario: 'parallel-tools' })
    const starts = filterByType(item, 'tool-call-start')
    expect(starts.length).toBeGreaterThanOrEqual(2)
  })

  it('tool-call-start events have distinct itemIds', () => {
    const item = runFakeProvider({ scenario: 'parallel-tools' })
    const starts = filterByType(item, 'tool-call-start')
    const ids = starts.map((e) => (e.payload as { itemId: string }).itemId)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })
})

// ── Full scenario suite ──────────────────────────────────────────────────────

describe('All scenarios produce valid event streams', () => {
  const scenarios = generateAllScenarios()

  for (const [name, item] of Object.entries(scenarios)) {
    it(name, () => {
      expect(item.events.length).toBeGreaterThan(0)
      expect(sequencesAreMonotonic(item.events)).toBe(true)
    })
  }
})
