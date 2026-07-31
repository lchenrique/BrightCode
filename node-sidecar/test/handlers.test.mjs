import assert from 'node:assert/strict'
import test from 'node:test'
import { publish, subscribe, unsubscribe } from '../bin/handlers/events.js'
import { historyRead } from '../bin/handlers/history-read.js'
import { threadCreate } from '../bin/handlers/thread-create.js'
import { threadRead } from '../bin/handlers/thread-read.js'
import { turnInterrupt } from '../bin/handlers/turn-interrupt.js'
import { turnStart } from '../bin/handlers/turn-start.js'

test('threadRead returns empty state for unknown thread', () => {
  const state = threadRead({ threadId: 'unknown_thread' })
  assert.equal(state.threadId, 'unknown_thread')
  assert.equal(state.sequence, 0)
  assert.equal(state.idle, true)
})

test('threadRead returns same state after threadCreate', () => {
  const created = threadCreate({ threadId: 'created_thread' })
  assert.strictEqual(threadRead({ threadId: 'created_thread' }), created.thread)
})

test('historyRead returns empty history for new thread', () => {
  assert.deepEqual(historyRead({ threadId: 'history_thread' }), [])
})

test('turnStart returns turnId for valid thread', () => {
  threadCreate({ threadId: 'turn_thread' })
  const result = turnStart({
    threadId: 'turn_thread',
    prompt: 'hello',
    modelId: 'model',
    accountId: 'account',
  })
  assert.match(result.turnId, /^turn_[A-Za-z0-9-]+$/)
  turnInterrupt({ threadId: 'turn_thread', turnId: result.turnId })
})

test('turnInterrupt returns ok', () => {
  assert.deepEqual(turnInterrupt({ threadId: 'turn_thread', turnId: 'turn_missing' }), { ok: true })
})

test('event bus subscribe publish unsubscribe roundtrip', () => {
  const received = []
  subscribe('subscription', 'thread', (envelope) => received.push(envelope))
  const envelope = { event: { type: 'turn-complete' }, state: { threadId: 'thread' } }
  publish('thread', envelope)
  unsubscribe('subscription')
  publish('thread', envelope)
  assert.deepEqual(received, [envelope])
})
