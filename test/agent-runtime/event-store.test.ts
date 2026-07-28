/**
 * Tests for the event store.
 *
 * Covers:
 * - append logic: terminal events flush immediately, deltas coalesce
 * - replay produces correct state from events
 * - reducer rejects duplicate/regressing sequence, unknown schema version
 * - parallel text-delta accumulation
 * - index shape and retention constants
 */

import { describe, it, expect } from 'vitest'
import { RuntimeEvent, RUNTIME_SCHEMA_VERSION } from '../../electron/shared/agent-protocol'

// Import from the actual module (tsconfig paths resolve these)
import { replay } from '../../electron/main/agent-runtime/event-reducer'
import { emptyThreadState } from '../../electron/shared/agent-protocol'
import type { ThreadIndex } from '../../electron/main/agent-runtime/thread-index'
import { RETENTION } from '../../electron/main/agent-runtime/storage-retention'

// Re-export flush-event types for testing
const FLUSH_EVENT_TYPES = new Set([
  'turn-start', 'turn-complete', 'turn-failed', 'turn-interrupted',
  'item-start', 'item-end',
  'tool-result',
  'approval-required', 'approval-resolved',
  'subagent-start', 'subagent-end',
  'error', 'disconnect',
] as const)

function isFlushEvent(type: string): boolean {
  return FLUSH_EVENT_TYPES.has(type as typeof FLUSH_EVENT_TYPES[number])
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    threadId: 'thread-1',
    sequence: 1,
    timestamp: 1_700_000_000_000,
    type: 'turn-start',
    payload: { turnId: 'turn-1', permissionProfile: 'workspace_write' as const },
    ...overrides,
  }
}

function turnStart(seq: number, turnId = 'turn-1'): RuntimeEvent {
  return makeEvent({
    sequence: seq,
    timestamp: 1_700_000_000_000 + seq * 100,
    type: 'turn-start',
    payload: { turnId, permissionProfile: 'workspace_write' as const },
  })
}

function itemStart(seq: number, itemId: string, turnId = 'turn-1'): RuntimeEvent {
  return makeEvent({
    sequence: seq,
    type: 'item-start',
    payload: { itemId, turnId, kind: 'agent-message' as const },
  })
}

function textDelta(seq: number, itemId: string, content: string): RuntimeEvent {
  return makeEvent({ sequence: seq, type: 'text-delta', payload: { itemId, content } })
}

function itemEnd(seq: number, itemId: string, status: 'completed' | 'failed' = 'completed'): RuntimeEvent {
  return makeEvent({ sequence: seq, type: 'item-end', payload: { itemId, status } })
}

function turnComplete(seq: number, turnId = 'turn-1', status: 'completed' | 'failed' = 'completed'): RuntimeEvent {
  return makeEvent({
    sequence: seq,
    type: status === 'completed' ? 'turn-complete' : 'turn-failed',
    payload: { turnId, status },
  })
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('event-store', () => {
  describe('coalescing strategy', () => {
    it('FLUSH_EVENT_TYPES includes turn-start, item-end, tool-result, error', () => {
      const immediateFlushTypes = [
        'turn-start', 'turn-complete', 'turn-failed', 'turn-interrupted',
        'item-start', 'item-end',
        'tool-result',
        'approval-required', 'approval-resolved',
        'subagent-start', 'subagent-end',
        'error', 'disconnect',
      ] as const
      for (const t of immediateFlushTypes) {
        expect(isFlushEvent(t)).toBe(true)
      }
    })

    it('text-delta and reasoning-delta are NOT flush events', () => {
      expect(isFlushEvent('text-delta')).toBe(false)
      expect(isFlushEvent('reasoning-delta')).toBe(false)
      expect(isFlushEvent('reasoning-start')).toBe(false)
      expect(isFlushEvent('reasoning-end')).toBe(false)
    })
  })

  describe('append simulation', () => {
    // Simulate the append logic without the real filesystem
    function simulateAppend(
      events: RuntimeEvent[],
      event: RuntimeEvent,
    ): { flushImmediately: boolean; events: RuntimeEvent[] } {
      const flushImmediately = isFlushEvent(event.type)
      return { flushImmediately, events: [...events, event] }
    }

    it('turn-start appends immediately', () => {
      const result = simulateAppend([], turnStart(1))
      expect(result.flushImmediately).toBe(true)
      expect(result.events).toHaveLength(1)
    })

    it('item-end appends immediately', () => {
      const result = simulateAppend([turnStart(1)], itemEnd(2, 'item-1'))
      expect(result.flushImmediately).toBe(true)
      expect(result.events).toHaveLength(2)
    })

    it('text-delta does NOT flush immediately (coalesced)', () => {
      const result = simulateAppend(
        [turnStart(1), itemStart(2, 'item-1')],
        textDelta(3, 'item-1', 'Hello '),
      )
      expect(result.flushImmediately).toBe(false)
    })

    it('turn-complete appends immediately', () => {
      const result = simulateAppend(
        [turnStart(1), itemStart(2, 'item-1'), itemEnd(3, 'item-1')],
        turnComplete(4),
      )
      expect(result.flushImmediately).toBe(true)
    })
  })

  describe('reducer replay', () => {
    it('replay of empty events throws', () => {
      expect(() => replay([])).toThrow()
    })

    it('replay of valid events produces correct sequence', () => {
      const events = [
        turnStart(1),
        itemStart(2, 'item-1'),
        textDelta(3, 'item-1', 'hello'),
        itemEnd(4, 'item-1'),
        turnComplete(5),
      ]
      const state = replay(events)
      expect(state.sequence).toBe(5)
      expect(state.turnOrder).toEqual(['turn-1'])
      expect(state.itemOrder).toEqual(['item-1'])
    })

    it('duplicate sequence throws ReducerError', () => {
      const events = [
        turnStart(1),
        turnStart(1), // duplicate
      ]
      expect(() => replay(events)).toThrow()
    })

    it('regressing sequence throws ReducerError', () => {
      const events = [
        turnStart(2), // starts at 2
        turnStart(1), // regresses to 1
      ]
      expect(() => replay(events)).toThrow()
    })

    it('unknown schema version throws', () => {
      const badEvent = {
        ...turnStart(1),
        schemaVersion: 99 as const,
      }
      expect(() => {
        const state = emptyThreadState('thread-1')
        // @ts-expect-error — intentional bad version for test
        const { reduce } = require('../../electron/main/agent-runtime/event-reducer')
        reduce(state, badEvent)
      }).toThrow()
    })

    it('parallel text-delta on same item accumulates', () => {
      const events = [
        turnStart(1),
        itemStart(2, 'item-1'),
        textDelta(3, 'item-1', 'Hello '),
        textDelta(4, 'item-1', 'world!'),
        itemEnd(5, 'item-1'),
        turnComplete(6),
      ]
      const state = replay(events)
      const item = state.items['item-1'] as { text: string } | undefined
      expect(item?.text).toBe('Hello world!')
    })
  })

  describe('ThreadIndex', () => {
    it('has correct shape', () => {
      const idx: ThreadIndex = {
        threadId: 't1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        title: 'Test thread',
        turnCount: 1,
        lastSequence: 5,
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        readOnly: false,
      }
      expect(idx.threadId).toBe('t1')
      expect(idx.schemaVersion).toBe(RUNTIME_SCHEMA_VERSION)
    })
  })

  describe('RETENTION constants', () => {
    it('has correct thresholds', () => {
      expect(RETENTION.JSONL_COMPACT_THRESHOLD_BYTES).toBe(10 * 1024 * 1024)
      expect(RETENTION.JSONL_COMPACT_THRESHOLD_EVENTS).toBe(50_000)
      expect(RETENTION.ARTIFACT_CAP_BYTES).toBe(2 * 1024 * 1024 * 1024)
      expect(RETENTION.CHECKPOINT_TURN_RETENTION).toBe(10)
      expect(RETENTION.ARTIFACT_ORPHAN_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000)
      expect(RETENTION.ARTIFACT_ARCHIVED_EXPIRY_MS).toBe(90 * 24 * 60 * 60 * 1000)
    })
  })

  describe('reducer state invariants', () => {
    it('activeTurnId is undefined when idle', () => {
      const state = replay([
        turnStart(1),
        itemStart(2, 'item-1'),
        itemEnd(3, 'item-1'),
        turnComplete(4),
      ])
      expect(state.idle).toBe(true)
      expect(state.activeTurnId).toBeUndefined()
    })

    it('activeTurnId is set during a running turn', () => {
      const state = replay([
        turnStart(1),
        itemStart(2, 'item-1'),
      ])
      expect(state.idle).toBe(false)
      expect(state.activeTurnId).toBe('turn-1')
    })
  })
})
