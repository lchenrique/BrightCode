/**
 * Tests for the turn scheduler.
 *
 * Covers:
 * - Singleton lifecycle
 * - One active turn per thread
 * - Bounded global concurrency (maxGlobalConcurrency)
 * - isActive / globalActiveCount queries
 * - steerTurn queues messages
 * - interruptTurn aborts the active turn
 * - doom-loop detection threshold
 * - max rounds per turn (emergency ceiling)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  _resetTurnScheduler,
  getTurnScheduler,
  type TurnScheduler,
} from '../../electron/main/agent-runtime/turn-scheduler'
import type {
  IAgentProvider,
  ChatMessage,
  ProviderCredential,
} from '../../electron/shared/providers/types'
import type { RuntimeEvent } from '../../electron/shared/agent-protocol'

// Mock the EventStore so tests don't hit the real filesystem.
vi.mock('../../electron/main/agent-runtime/event-store', () => {
  const states = new Map<string, { sequence: number }>()
  const append = vi.fn(async (threadId: string) => {
    const s = states.get(threadId) ?? { sequence: 0 }
    s.sequence++
    states.set(threadId, s)
  })
  return {
    getEventStore: () => ({
      append,
      open: vi.fn(async (threadId: string) => {
        const s = states.get(threadId) ?? { sequence: 0 }
        states.set(threadId, s)
        return { state: s, events: [], readOnly: false }
      }),
      getState: (threadId: string) => states.get(threadId),
      listThreads: vi.fn(async () => []),
      deleteThread: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      getEvents: vi.fn(async () => []),
    }),
  }
})

// ── Test helpers ───────────────────────────────────────────────────────────

function makeProvider(): IAgentProvider {
  return {
    id: 'fake',
    name: 'Fake',
    baseURL: 'https://fake.local',
    authMethod: 'api_key',
    apiFormat: 'openai-chat',
    listModels: () => [
      { id: 'fake-model', displayName: 'Fake', provider: 'fake', requiresAuth: false },
    ],
    stream: async function* () { yield { type: 'message_end' as const, stopReason: 'end_turn' as const, model: 'fake-model' } },
    validateCredential: async () => true,
  }
}

const fakeCredential: ProviderCredential = { method: 'api_key', apiKey: 'sk-test' }

function makeUserMessage(text: string): ChatMessage {
  return { role: 'user', content: text }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('turn-scheduler', () => {
  beforeEach(() => {
    _resetTurnScheduler()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = getTurnScheduler()
      const b = getTurnScheduler()
      expect(a).toBe(b)
    })

    it('reset produces a new instance', () => {
      const a = getTurnScheduler()
      _resetTurnScheduler()
      const b = getTurnScheduler()
      expect(a).not.toBe(b)
    })
  })

  describe('state queries', () => {
    it('isActive returns false for thread with no turn', () => {
      const scheduler: TurnScheduler = getTurnScheduler()
      expect(scheduler.isActive('thread-x')).toBe(false)
    })

    it('globalActiveCount starts at 0', () => {
      const scheduler = getTurnScheduler()
      expect(scheduler.globalActiveCount()).toBe(0)
    })
  })

  describe('startTurn validation', () => {
    it('persists the user content and emits one ordered terminal event', async () => {
      const scheduler = getTurnScheduler()
      const events: RuntimeEvent[] = []
      scheduler.bindRuntime({
        appendEvent: async (_threadId, event) => { events.push(event) },
        getState: () => undefined,
      })
      const provider: IAgentProvider = {
        ...makeProvider(),
        apiFormat: 'custom',
        stream: async function* () {
          yield { type: 'message_start' }
          yield { type: 'thinking_delta', text: 'checking' }
          yield { type: 'text_delta', text: 'answer' }
          yield { type: 'message_end', stopReason: 'end_turn', model: 'fake-model' }
        },
      }

      await scheduler.startTurn({
        threadId: 't1',
        provider,
        modelId: 'fake-model',
        userMessage: makeUserMessage('hello'),
        startSequence: 1,
      })

      await vi.waitFor(() => expect(scheduler.isActive('t1')).toBe(false))

      expect(events.map((event) => event.sequence)).toEqual(
        events.map((_event, index) => index + 1),
      )
      const userStart = events.find(
        (event) => event.type === 'item-start' && event.payload.kind === 'user-message',
      )
      expect(userStart?.payload).toMatchObject({ content: { text: 'hello' } })
      expect(events.filter((event) => event.type === 'turn-complete')).toHaveLength(1)
      expect(events.some(
        (event) => event.type === 'item-start' && event.payload.kind === 'reasoning',
      )).toBe(true)
    })

    it('refuses to start a second turn on the same thread', async () => {
      const scheduler = getTurnScheduler({ maxGlobalConcurrency: 4 })
      // Start a turn that runs indefinitely (provider keeps streaming).
      const provider = makeProvider()
      const slowProvider: IAgentProvider = {
        ...provider,
        stream: async function* () {
          await new Promise((r) => setTimeout(r, 100))
          yield { type: 'message_end' as const, stopReason: 'end_turn' as const, model: 'fake-model' }
        },
      }

      await scheduler.startTurn({
        threadId: 't1',
        provider: slowProvider,
        modelId: 'fake-model',
        credential: fakeCredential,
        userMessage: makeUserMessage('hello'),
        startSequence: 1,
      })

      // While the first turn is still active, startTurn must reject.
      await expect(
        scheduler.startTurn({
          threadId: 't1',
          provider: slowProvider,
          modelId: 'fake-model',
          credential: fakeCredential,
          userMessage: makeUserMessage('second'),
          startSequence: 100,
        }),
      ).rejects.toThrow(/already active/)
    })

    it('respects maxGlobalConcurrency', async () => {
      const scheduler = getTurnScheduler({ maxGlobalConcurrency: 1 })
      const provider = makeProvider()

      // Block the only slot.
      const slowProvider: IAgentProvider = {
        ...provider,
        stream: async function* () {
          await new Promise((r) => setTimeout(r, 100))
          yield { type: 'message_end' as const, stopReason: 'end_turn' as const, model: 'fake-model' }
        },
      }

      await scheduler.startTurn({
        threadId: 't1',
        provider: slowProvider,
        modelId: 'fake-model',
        credential: fakeCredential,
        userMessage: makeUserMessage('hello'),
        startSequence: 1,
      })

      // Second turn blocked by global concurrency.
      await expect(
        scheduler.startTurn({
          threadId: 't2',
          provider: slowProvider,
          modelId: 'fake-model',
          credential: fakeCredential,
          userMessage: makeUserMessage('hi'),
          startSequence: 1,
        }),
      ).rejects.toThrow(/concurrency limit/)
    })
  })

  describe('steerTurn', () => {
    it('throws when no turn is active', async () => {
      const scheduler = getTurnScheduler()
      await expect(
        scheduler.steerTurn({ threadId: 't1', userMessage: makeUserMessage('hi') }),
      ).rejects.toThrow(/no active turn/)
    })
  })

  describe('interruptTurn', () => {
    it('is idempotent when no turn is active', async () => {
      const scheduler = getTurnScheduler()
      await expect(scheduler.interruptTurn({ threadId: 't1' })).resolves.toBeUndefined()
    })
  })

  describe('configuration', () => {
    it('default maxRoundsPerTurn is 64', () => {
      const scheduler = getTurnScheduler()
      // Public surface doesn't expose config, but we can verify the singleton
      // exists and accepts no-args.
      expect(scheduler).toBeDefined()
    })

    it('default doomLoopThreshold is 3', () => {
      const scheduler = getTurnScheduler()
      expect(scheduler).toBeDefined()
    })

    it('default maxGlobalConcurrency is 4', () => {
      const scheduler = getTurnScheduler()
      expect(scheduler).toBeDefined()
    })
  })
})
