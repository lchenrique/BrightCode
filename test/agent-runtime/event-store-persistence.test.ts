import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../../electron/shared/agent-protocol'
import { RUNTIME_SCHEMA_VERSION } from '../../electron/shared/agent-protocol'
import {
  _resetEventStore,
  getEventStore,
} from '../../electron/main/agent-runtime/event-store'

const userData = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => userData.path },
}))

function event(
  sequence: number,
  type: RuntimeEvent['type'],
  payload: RuntimeEvent['payload'],
): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    threadId: 'persist-thread',
    turnId: 'turn-1',
    sequence,
    timestamp: 1_700_000_000_000 + sequence,
    type,
    payload,
  } as RuntimeEvent
}

describe('event-store persistence', () => {
  beforeEach(async () => {
    userData.path = await mkdtemp(join(tmpdir(), 'brightcode-event-store-'))
    _resetEventStore()
  })

  afterEach(async () => {
    _resetEventStore()
    await rm(userData.path, { recursive: true, force: true })
  })

  it('serializes concurrent deltas before terminal events', async () => {
    const store = getEventStore()
    await store.open('persist-thread')
    await store.append('persist-thread', event(1, 'turn-start', {
      turnId: 'turn-1',
      permissionProfile: 'workspace_write',
    }))
    await store.append('persist-thread', event(2, 'item-start', {
      itemId: 'item-1',
      turnId: 'turn-1',
      kind: 'agent-message',
    }))
    await Promise.all([
      store.append('persist-thread', event(3, 'text-delta', {
        itemId: 'item-1',
        content: 'hello ',
      })),
      store.append('persist-thread', event(4, 'text-delta', {
        itemId: 'item-1',
        content: 'world',
      })),
    ])
    await store.append('persist-thread', event(5, 'item-end', {
      itemId: 'item-1',
      status: 'completed',
    }))
    await store.append('persist-thread', event(6, 'turn-complete', {
      turnId: 'turn-1',
      status: 'completed',
    }))

    const events = await store.getEvents('persist-thread')
    expect(events.map((runtimeEvent) => runtimeEvent.sequence)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('persists crash-recovery terminal events exactly once', async () => {
    let store = getEventStore()
    await store.open('persist-thread')
    await store.append('persist-thread', event(1, 'turn-start', {
      turnId: 'turn-1',
      permissionProfile: 'workspace_write',
    }))
    await store.append('persist-thread', event(2, 'item-start', {
      itemId: 'item-1',
      turnId: 'turn-1',
      kind: 'agent-message',
    }))
    await store.append('persist-thread', event(3, 'text-delta', {
      itemId: 'item-1',
      content: 'partial',
    }))
    await store.flush('persist-thread')

    _resetEventStore()
    store = getEventStore()
    const recovered = await store.open('persist-thread')
    expect(recovered.events.map((runtimeEvent) => runtimeEvent.type)).toEqual([
      'turn-start',
      'item-start',
      'text-delta',
      'item-end',
      'turn-interrupted',
    ])

    _resetEventStore()
    store = getEventStore()
    const reopened = await store.open('persist-thread')
    expect(reopened.events.map((runtimeEvent) => runtimeEvent.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  it('throws and does not persist reducer-rejected events', async () => {
    const store = getEventStore()
    await store.open('persist-thread')
    const start = event(1, 'turn-start', {
      turnId: 'turn-1',
      permissionProfile: 'workspace_write',
    })
    await store.append('persist-thread', start)
    await expect(store.append('persist-thread', start)).rejects.toThrow('Rejected runtime event')
    expect(await store.getEvents('persist-thread')).toEqual([start])
  })
})
