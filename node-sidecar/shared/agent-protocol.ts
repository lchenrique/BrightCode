export type TurnStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed'
export type ItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'declined' | 'interrupted'
export type WaitingKind = 'none' | 'approval' | 'question' | 'tool-input'
export type PermissionProfile = 'read_only' | 'workspace_write' | 'full_access'

export const RUNTIME_SCHEMA_VERSION = 2 as const

export type RuntimeEventType =
  | 'turn-start'
  | 'turn-complete'
  | 'turn-interrupted'
  | 'turn-failed'
  | 'item-start'
  | 'item-end'
  | 'text-delta'
  | 'reasoning-start'
  | 'reasoning-delta'
  | 'reasoning-end'
  | 'tool-call-start'
  | 'tool-call-delta'
  | 'tool-call-end'
  | 'tool-result'
  | 'plan-update'
  | 'todo-update'
  | 'subagent-start'
  | 'subagent-end'
  | 'approval-required'
  | 'approval-resolved'
  | 'usage'
  | 'error'
  | 'disconnect'

export interface RuntimeEvent<T extends RuntimeEventType = RuntimeEventType> {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION
  threadId: string
  turnId?: string
  itemId?: string
  sequence: number
  timestamp: number
  type: T
  payload: unknown
}

export interface Turn {
  turnId: string
  status: TurnStatus
  startedAt: number
  completedAt?: number
  waitingKind?: WaitingKind
  permissionProfile: PermissionProfile
  errorMessage?: string
  stopReason?: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUSD: number
  perTurn: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUSD: number }>
}

export interface ThreadState {
  threadId: string
  generation: number
  sequence: number
  turns: Record<string, Turn>
  turnOrder: string[]
  items: Record<string, unknown>
  itemOrder: string[]
  approvals: Record<string, unknown>
  activeTurnId?: string
  usage: Usage
  idle: boolean
  lastError?: string
}

export function emptyThreadState(threadId: string): ThreadState {
  return {
    threadId,
    generation: 0,
    sequence: 0,
    turns: {},
    turnOrder: [],
    items: {},
    itemOrder: [],
    approvals: {},
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUSD: 0, perTurn: {} },
    idle: true,
  }
}
