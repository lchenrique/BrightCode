import { RUNTIME_SCHEMA_VERSION, type RuntimeEvent } from '../shared/agent-protocol.js'
import { publish } from './events.js'
import { appendHistory } from './history-read.js'
import { threads } from './thread-create.js'
import { pendingTurns } from './turn-start.js'

export interface TurnInterruptInput {
  threadId: string
  turnId?: string
}

export function turnInterrupt({ threadId, turnId }: TurnInterruptInput): { ok: true } {
  const pending = pendingTurns.get(threadId)
  if (!pending || (turnId && pending.turnId !== turnId)) return { ok: true }

  pendingTurns.delete(threadId)
  const state = threads.get(threadId)
  if (!state) return { ok: true }
  const turn = state.turns[pending.turnId]
  if (turn) {
    turn.status = 'interrupted'
    turn.completedAt = Date.now()
  }
  delete state.activeTurnId
  state.sequence += 1
  state.generation += 1
  state.idle = true
  const event: RuntimeEvent<'turn-interrupted'> = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    threadId,
    turnId: pending.turnId,
    sequence: state.sequence,
    timestamp: Date.now(),
    type: 'turn-interrupted',
    payload: { turnId: pending.turnId, reason: 'user' },
  }
  appendHistory(event)
  publish(threadId, { event, state })
  return { ok: true }
}
