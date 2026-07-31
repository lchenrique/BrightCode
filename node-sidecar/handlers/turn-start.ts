import { randomUUID } from 'node:crypto'
import { RUNTIME_SCHEMA_VERSION, type RuntimeEvent } from '../shared/agent-protocol.js'
import { publish } from './events.js'
import { appendHistory } from './history-read.js'
import { threads } from './thread-create.js'

export interface TurnStartInput {
  threadId: string
  prompt: string
  modelId?: string
  accountId?: string
  images?: Array<{ kind: 'url' | 'base64'; value: string }>
}

export interface PendingTurn {
  threadId: string
  turnId: string
}

export const pendingTurns = new Map<string, PendingTurn>()

export function turnStart(input: TurnStartInput): { turnId: string } {
  const state = threads.get(input.threadId)
  if (!state) throw new Error(`Unknown thread: ${input.threadId}`)
  if (pendingTurns.has(input.threadId)) {
    throw new Error(`Thread already has an active turn: ${input.threadId}`)
  }

  const turnId = `turn_${randomUUID()}`
  const itemId = `item_${randomUUID()}`
  state.turns[turnId] = {
    turnId,
    status: 'running',
    startedAt: Date.now(),
    permissionProfile: 'workspace_write',
  }
  state.turnOrder.push(turnId)
  state.items[itemId] = {
    itemId,
    turnId,
    kind: 'user-message',
    status: 'completed',
    text: input.prompt,
    imageRefs: input.images?.map((image) => image.value),
  }
  state.itemOrder.push(itemId)
  state.activeTurnId = turnId
  state.idle = false
  state.sequence += 1
  state.generation += 1

  const event: RuntimeEvent<'turn-start'> = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    threadId: input.threadId,
    turnId,
    itemId,
    sequence: state.sequence,
    timestamp: Date.now(),
    type: 'turn-start',
    payload: {
      turnId,
      itemId,
      modelId: input.modelId,
      accountId: input.accountId,
    },
  }
  appendHistory(event)
  publish(input.threadId, { event, state })
  pendingTurns.set(input.threadId, { threadId: input.threadId, turnId })
  return { turnId }
}
