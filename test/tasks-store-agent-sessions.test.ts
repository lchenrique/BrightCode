/**
 * Tasks store: Teams-agent sessions.
 *
 * Covers:
 * - create() persists agentId (and only when set)
 * - getTasksByAgent filters + sorts newest-first
 * - getLatestAgentTask returns the newest session for an agent
 */

import { describe, it, expect, beforeEach } from 'vitest'

// Stub Electron IPC. The store calls into window.electronAPI.tasks on init
// and on every mutation. We do not care about IPC roundtrip here — we only
// care about the in-memory state, which is what the sidebar reads.
beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      tasks: {
        list: async () => [],
        create: async () => undefined,
        remove: async () => undefined,
        update: async () => undefined,
        onChanged: () => () => undefined,
      },
    },
  }
})

describe('tasksStore — Teams-agent sessions', () => {
  it('create() stores agentId only when provided', async () => {
    const { tasksStore } = await import('../src/lib/tasks/store')
    const loose = tasksStore.create({ projectId: null, title: 'loose' })
    const owned = tasksStore.create({ projectId: null, title: 'owned', agentId: 'agent-1' })
    expect(loose.agentId).toBeUndefined()
    expect(owned.agentId).toBe('agent-1')
  })

  it('getTasksByAgent returns only that agent, newest first', async () => {
    const { tasksStore } = await import('../src/lib/tasks/store')
    // Create interleaved tasks for two agents so the order would not
    // accidentally be correct by insertion alone.
    const a1 = tasksStore.create({ projectId: null, title: 'A-1', agentId: 'A' })
    const b1 = tasksStore.create({ projectId: null, title: 'B-1', agentId: 'B' })
    const a2 = tasksStore.create({ projectId: null, title: 'A-2', agentId: 'A' })
    const b2 = tasksStore.create({ projectId: null, title: 'B-2', agentId: 'B' })

    const aSessions = tasksStore.getTasksByAgent('A')
    expect(aSessions.map((t) => t.id)).toEqual([a2.id, a1.id])

    const bSessions = tasksStore.getTasksByAgent('B')
    expect(bSessions.map((t) => t.id)).toEqual([b2.id, b1.id])

    // Sanity: the loose task from the previous test (if any) is excluded
    // because it has no agentId. This locks in the "only that agent"
    // half of the contract.
    expect(aSessions.find((t) => t.id === b1.id)).toBeUndefined()
  })

  it('getLatestAgentTask returns the newest session or undefined', async () => {
    const { tasksStore } = await import('../src/lib/tasks/store')
    const first = tasksStore.create({ projectId: null, title: 'first', agentId: 'X' })
    const second = tasksStore.create({ projectId: null, title: 'second', agentId: 'X' })
    expect(tasksStore.getLatestAgentTask('X')?.id).toBe(second.id)
    expect(tasksStore.getLatestAgentTask('no-such-agent')).toBeUndefined()
    expect(first).toBeDefined()
  })
})