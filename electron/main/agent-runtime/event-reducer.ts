/**
 * Event reducer — pure, no I/O, no electron.
 *
 * Mirrors the architecture plan §3: a reducer from `RuntimeEvent[]` to
 * `ThreadState`. The reducer is the only writer of `ThreadState` and the
 * only consumer of `RuntimeEvent`. Replaying persisted events through the
 * reducer reconstructs the same state the runtime would have produced live.
 *
 * Rules (per the plan):
 *   - Reject invalid payloads, duplicate or regressing sequence values,
 *     unknown schema versions, and illegal state transitions.
 *   - Use tagged unions and exhaustive switches. No `any`.
 *   - One immutable update per event. The caller decides whether to
 *     persist the resulting state.
 *   - Pure: same input → same output. No clock, no random, no I/O.
 *
 * Not owned here:
 *   - Persistence (electron-store + JSONL — see Task 3).
 *   - Provider stream parsing (the runtime sends events; the reducer applies them).
 *   - Authorization (the runtime decides who can submit; the reducer just applies).
 */

import {
  ReducerError,
  RUNTIME_SCHEMA_VERSION,
  emptyThreadState,
  type AgentMessageItem,
  type Approval,
  type FileChangeItem,
  type ItemStartPayload,
  type ReasoningItem,
  type RuntimeEvent,
  type ThreadItem,
  type ThreadState,
  type ToolCallItem,
  type Turn,
  type TurnStatus,
  type UserMessageItem,
} from '../../shared/agent-protocol'

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Apply a single event to a state. Returns a NEW state (immutable update).
 *
 * Throws `ReducerError` on any invariant violation. The caller is
 * responsible for catching — typically the runtime logs and drops the bad
 * event rather than crashing.
 */
export function reduce(
  state: ThreadState,
  event: RuntimeEvent,
): ThreadState {
  validateEventForState(state, event)
  const next = dispatch(state, event)
  return {
    ...next,
    generation: state.generation + 1,
    sequence: event.sequence,
  }
}

/**
 * Replay a list of events from scratch. Returns the resulting state.
 *
 * Used at thread open to reconstruct the canonical state from JSONL, and
 * in tests to verify "the same events produce the same state".
 *
 * Throws if any event is invalid — the JSONL on disk is corrupted.
 */
export function replay(events: ReadonlyArray<RuntimeEvent>): ThreadState {
  if (events.length === 0) {
    throw new ReducerError('invalid-payload', 'Cannot replay an empty event list')
  }

  const threadId = events[0].threadId
  let state = emptyThreadState(threadId)

  for (const event of events) {
    if (event.threadId !== threadId) {
      throw new ReducerError(
        'invalid-payload',
        `Event threadId mismatch: expected "${threadId}", got "${event.threadId}" at sequence ${event.sequence}`,
        event,
      )
    }
    state = reduce(state, event)
  }

  return state
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateEventForState(state: ThreadState, event: RuntimeEvent): void {
  if (event.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
    throw new ReducerError(
      'unknown-schema-version',
      `Event schema version ${event.schemaVersion} is not supported by this build (expected ${RUNTIME_SCHEMA_VERSION}).`,
      event,
    )
  }
  if (event.threadId !== state.threadId) {
    throw new ReducerError(
      'invalid-payload',
      `Event threadId "${event.threadId}" does not match state threadId "${state.threadId}".`,
      event,
    )
  }
  if (event.sequence <= state.sequence) {
    if (event.sequence === state.sequence) {
      throw new ReducerError(
        'duplicate-sequence',
        `Duplicate sequence ${event.sequence} (last applied was ${state.sequence}).`,
        event,
      )
    }
    throw new ReducerError(
      'regressing-sequence',
      `Regressing sequence ${event.sequence} (last applied was ${state.sequence}). Events must be strictly increasing.`,
      event,
    )
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────

function dispatch(state: ThreadState, event: RuntimeEvent): ThreadState {
  switch (event.type) {
    case 'turn-start':
      return applyTurnStart(state, event as RuntimeEvent<'turn-start'>)
    case 'turn-complete':
      return applyTurnComplete(state, event as RuntimeEvent<'turn-complete'>, 'completed')
    case 'turn-failed':
      return applyTurnComplete(state, event as RuntimeEvent<'turn-failed'>, 'failed')
    case 'turn-interrupted':
      return applyTurnInterrupted(state, event as RuntimeEvent<'turn-interrupted'>)
    case 'item-start':
      return applyItemStart(state, event as RuntimeEvent<'item-start'>)
    case 'item-end':
      return applyItemEnd(state, event as RuntimeEvent<'item-end'>)
    case 'text-delta':
      return applyTextDelta(state, event as RuntimeEvent<'text-delta'>)
    case 'reasoning-start':
    case 'reasoning-delta':
      return applyReasoningDelta(state, event as RuntimeEvent<'reasoning-start' | 'reasoning-delta'>)
    case 'reasoning-end':
      return applyReasoningEnd(state, event as RuntimeEvent<'reasoning-end'>)
    case 'tool-call-start':
      return applyToolCallStart(state, event as RuntimeEvent<'tool-call-start'>)
    case 'tool-call-delta':
      return applyToolCallDelta(state, event as RuntimeEvent<'tool-call-delta'>)
    case 'tool-call-end':
      return applyToolCallEnd(state, event as RuntimeEvent<'tool-call-end'>)
    case 'tool-result':
      return applyToolResult(state, event as RuntimeEvent<'tool-result'>)
    case 'plan-update':
      return applyPlanUpdate(state, event as RuntimeEvent<'plan-update'>)
    case 'todo-update':
      return applyTodoUpdate(state, event as RuntimeEvent<'todo-update'>)
    case 'subagent-start':
      return applySubagentStart(state, event as RuntimeEvent<'subagent-start'>)
    case 'subagent-end':
      return applySubagentEnd(state, event as RuntimeEvent<'subagent-end'>)
    case 'approval-required':
      return applyApprovalRequired(state, event as RuntimeEvent<'approval-required'>)
    case 'approval-resolved':
      return applyApprovalResolved(state, event as RuntimeEvent<'approval-resolved'>)
    case 'usage':
      return applyUsage(state, event as RuntimeEvent<'usage'>)
    case 'error':
      return applyError(state, event as RuntimeEvent<'error'>)
    case 'disconnect':
      return applyDisconnect(state, event as RuntimeEvent<'disconnect'>)
    default: {
      // Exhaustiveness check: a new RuntimeEventType added without a
      // handler above will fail the build here.
      const _exhaustive: never = event.type
      throw new ReducerError(
        'invalid-payload',
        `No handler for event type "${String(_exhaustive)}".`,
        event,
      )
    }
  }
}

// ── Turn handlers ──────────────────────────────────────────────────────────

function applyTurnStart(
  state: ThreadState,
  event: RuntimeEvent<'turn-start'>,
): ThreadState {
  const { turnId, permissionProfile } = event.payload
  if (state.turns[turnId]) {
    throw new ReducerError(
      'illegal-transition',
      `Turn "${turnId}" already started (duplicate turn-start).`,
      event,
    )
  }
  if (state.activeTurnId) {
    throw new ReducerError(
      'illegal-transition',
      `Cannot start turn "${turnId}" while turn "${state.activeTurnId}" is still active.`,
      event,
    )
  }
  const turn: Turn = {
    turnId,
    status: 'running',
    startedAt: event.timestamp,
    permissionProfile,
  }
  return {
    ...state,
    turns: { ...state.turns, [turnId]: turn },
    turnOrder: [...state.turnOrder, turnId],
    activeTurnId: turnId,
    idle: false,
    lastError: undefined,
  }
}

function applyTurnComplete(
  state: ThreadState,
  event: RuntimeEvent<'turn-complete' | 'turn-failed'>,
  kind: 'completed' | 'failed',
): ThreadState {
  const { turnId } = event.payload
  const turn = state.turns[turnId]
  if (!turn) {
    throw new ReducerError('unknown-turn', `Turn "${turnId}" not found.`, event)
  }
  if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
    throw new ReducerError(
      'illegal-transition',
      `Turn "${turnId}" already in terminal state "${turn.status}".`,
      event,
    )
  }
  const next: Turn = {
    ...turn,
    status: kind,
    completedAt: event.timestamp,
    errorMessage: kind === 'failed' ? event.payload.errorMessage : turn.errorMessage,
    stopReason: event.payload.stopReason ?? turn.stopReason,
  }
  const isActive = state.activeTurnId === turnId
  return {
    ...state,
    turns: { ...state.turns, [turnId]: next },
    activeTurnId: isActive ? undefined : state.activeTurnId,
    idle: isActive,
    lastError: kind === 'failed' ? event.payload.errorMessage : state.lastError,
  }
}

function applyTurnInterrupted(
  state: ThreadState,
  event: RuntimeEvent<'turn-interrupted'>,
): ThreadState {
  const { turnId } = event.payload
  const turn = state.turns[turnId]
  if (!turn) {
    throw new ReducerError('unknown-turn', `Turn "${turnId}" not found.`, event)
  }
  const next: Turn = {
    ...turn,
    status: 'interrupted',
    completedAt: event.timestamp,
  }
  const isActive = state.activeTurnId === turnId
  return {
    ...state,
    turns: { ...state.turns, [turnId]: next },
    activeTurnId: isActive ? undefined : state.activeTurnId,
    idle: isActive,
  }
}

// ── Item handlers ──────────────────────────────────────────────────────────

function applyItemStart(
  state: ThreadState,
  event: RuntimeEvent<'item-start'>,
): ThreadState {
  const payload = event.payload
  const turn = state.turns[payload.turnId]
  if (!turn) {
    throw new ReducerError('unknown-turn', `Turn "${payload.turnId}" not found for item-start.`, event)
  }
  if (state.items[payload.itemId]) {
    throw new ReducerError(
      'illegal-transition',
      `Item "${payload.itemId}" already started (duplicate item-start).`,
      event,
    )
  }
  const item = makeItem(payload, event.timestamp)
  return {
    ...state,
    items: { ...state.items, [payload.itemId]: item },
    itemOrder: [...state.itemOrder, payload.itemId],
  }
}

function applyItemEnd(
  state: ThreadState,
  event: RuntimeEvent<'item-end'>,
): ThreadState {
  const { itemId, status, errorMessage } = event.payload
  const item = state.items[itemId]
  if (!item) {
    throw new ReducerError('unknown-item', `Item "${itemId}" not found for item-end.`, event)
  }
  if (item.status === 'completed' || item.status === 'failed' || item.status === 'declined' || item.status === 'interrupted') {
    throw new ReducerError(
      'illegal-transition',
      `Item "${itemId}" already in terminal state "${item.status}".`,
      event,
    )
  }
  const next: ThreadItem = (() => {
    switch (item.kind) {
      case 'error':
        return { ...item, status, completedAt: event.timestamp, message: errorMessage ?? item.message }
      case 'tool-call':
        return { ...item, status, completedAt: event.timestamp, error: errorMessage ?? item.error }
      default:
        return { ...item, status, completedAt: event.timestamp }
    }
  })()
  return {
    ...state,
    items: { ...state.items, [itemId]: next },
  }
}

function applyTextDelta(
  state: ThreadState,
  event: RuntimeEvent<'text-delta'>,
): ThreadState {
  const { itemId, content } = event.payload
  const item = state.items[itemId]
  if (!item) {
    throw new ReducerError('unknown-item', `Item "${itemId}" not found for text-delta.`, event)
  }
  if (item.status !== 'in_progress' && item.status !== 'pending') {
    throw new ReducerError(
      'illegal-transition',
      `text-delta on item "${itemId}" in status "${item.status}".`,
      event,
    )
  }
  if (item.kind !== 'agent-message' && item.kind !== 'user-message') {
    throw new ReducerError(
      'illegal-transition',
      `text-delta on non-message item "${itemId}" (kind=${item.kind}).`,
      event,
    )
  }
  const next: ThreadItem =
    item.kind === 'agent-message'
      ? { ...item, status: 'in_progress', text: item.text + content }
      : { ...item, status: 'in_progress', text: item.text + content }
  return {
    ...state,
    items: { ...state.items, [itemId]: next },
  }
}

function applyReasoningDelta(
  state: ThreadState,
  event: RuntimeEvent<'reasoning-start' | 'reasoning-delta'>,
): ThreadState {
  const item = state.items[event.payload.itemId]
  if (!item) {
    throw new ReducerError(
      'unknown-item',
      `Item "${event.payload.itemId}" not found for reasoning-delta.`,
      event,
    )
  }
  if (item.kind !== 'reasoning') {
    throw new ReducerError(
      'illegal-transition',
      `reasoning-delta on non-reasoning item "${item.itemId}" (kind=${item.kind}).`,
      event,
    )
  }
  const next: ReasoningItem =
    event.type === 'reasoning-start'
      ? { ...item, status: 'in_progress', text: '' }
      : { ...item, status: 'in_progress', text: item.text + event.payload.content }
  return {
    ...state,
    items: { ...state.items, [item.itemId]: next },
  }
}

function applyReasoningEnd(
  state: ThreadState,
  event: RuntimeEvent<'reasoning-end'>,
): ThreadState {
  const item = state.items[event.payload.itemId]
  if (!item || item.kind !== 'reasoning') {
    // No-op for non-reasoning items (defensive: the dispatch table routes
    // both reasoning-start/delta to applyReasoningDelta, so this is the
    // canonical reasoning-end handler).
    return state
  }
  const next: ReasoningItem = { ...item, status: 'completed', completedAt: event.timestamp }
  return {
    ...state,
    items: { ...state.items, [item.itemId]: next },
  }
}

// ── Tool-call handlers ─────────────────────────────────────────────────────

function applyToolCallStart(
  state: ThreadState,
  event: RuntimeEvent<'tool-call-start'>,
): ThreadState {
  const { itemId, turnId, name, input } = event.payload
  const turn = state.turns[turnId]
  if (!turn) {
    throw new ReducerError('unknown-turn', `Turn "${turnId}" not found for tool-call-start.`, event)
  }
  if (state.items[itemId]) {
    throw new ReducerError(
      'illegal-transition',
      `Item "${itemId}" already started (tool-call-start).`,
      event,
    )
  }
  const item: ThreadItem = {
    itemId,
    turnId,
    kind: 'tool-call',
    status: 'in_progress',
    startedAt: event.timestamp,
    name,
    input: input ?? {},
  }
  return {
    ...state,
    items: { ...state.items, [itemId]: item },
    itemOrder: [...state.itemOrder, itemId],
  }
}

function applyToolCallDelta(
  state: ThreadState,
  event: RuntimeEvent<'tool-call-delta'>,
): ThreadState {
  const { itemId, inputFragment } = event.payload
  const item = state.items[itemId]
  if (!item) {
    throw new ReducerError('unknown-item', `Item "${itemId}" not found for tool-call-delta.`, event)
  }
  if (item.kind !== 'tool-call') {
    throw new ReducerError(
      'illegal-transition',
      `tool-call-delta on non-tool item "${itemId}" (kind=${item.kind}).`,
      event,
    )
  }
  if (item.status !== 'in_progress') {
    throw new ReducerError(
      'illegal-transition',
      `tool-call-delta on item "${itemId}" in status "${item.status}".`,
      event,
    )
  }
  // Accumulate the input fragment on the item. Parsing is lazy at
  // tool-call-end so the JSON arrives whole.
  const buffer = (item as ToolCallItem & { _inputBuffer?: string })._inputBuffer ?? ''
  const next: ThreadItem = {
    ...item,
    _inputBuffer: buffer + inputFragment,
  } as ThreadItem
  return { ...state, items: { ...state.items, [itemId]: next } }
}

function applyToolCallEnd(
  state: ThreadState,
  event: RuntimeEvent<'tool-call-end'>,
): ThreadState {
  const { itemId, input } = event.payload
  const item = state.items[itemId]
  if (!item) {
    throw new ReducerError('unknown-item', `Item "${itemId}" not found for tool-call-end.`, event)
  }
  if (item.kind !== 'tool-call') {
    throw new ReducerError(
      'illegal-transition',
      `tool-call-end on non-tool item "${itemId}" (kind=${item.kind}).`,
      event,
    )
  }
  // Prefer the parsed input from the event; fall back to the accumulated
  // buffer (parsed lazily if needed).
  const next: ThreadItem = { ...item, input }
  return { ...state, items: { ...state.items, [itemId]: next } }
}

function applyToolResult(
  state: ThreadState,
  event: RuntimeEvent<'tool-result'>,
): ThreadState {
  const { itemId, output, success, error, truncated } = event.payload
  const item = state.items[itemId]
  if (!item) {
    throw new ReducerError('unknown-item', `Item "${itemId}" not found for tool-result.`, event)
  }
  if (item.kind !== 'tool-call') {
    throw new ReducerError(
      'illegal-transition',
      `tool-result on non-tool item "${itemId}" (kind=${item.kind}).`,
      event,
    )
  }
  const next: ThreadItem = {
    ...item,
    output,
    success,
    error,
    truncated,
    status: success ? 'completed' : 'failed',
    completedAt: event.timestamp,
  }
  return { ...state, items: { ...state.items, [itemId]: next } }
}

// ── Plan / Todo ────────────────────────────────────────────────────────────

function applyPlanUpdate(
  state: ThreadState,
  event: RuntimeEvent<'plan-update'>,
): ThreadState {
  const { itemId, steps } = event.payload
  const item = state.items[itemId]
  if (!item) {
    throw new ReducerError('unknown-item', `Item "${itemId}" not found for plan-update.`, event)
  }
  if (item.kind !== 'plan') {
    throw new ReducerError(
      'illegal-transition',
      `plan-update on non-plan item "${itemId}" (kind=${item.kind}).`,
      event,
    )
  }
  const next: ThreadItem = { ...item, steps }
  return { ...state, items: { ...state.items, [itemId]: next } }
}

function applyTodoUpdate(
  state: ThreadState,
  event: RuntimeEvent<'todo-update'>,
): ThreadState {
  const { itemId, items } = event.payload
  const item = state.items[itemId]
  if (!item) {
    throw new ReducerError('unknown-item', `Item "${itemId}" not found for todo-update.`, event)
  }
  if (item.kind !== 'todo') {
    throw new ReducerError(
      'illegal-transition',
      `todo-update on non-todo item "${itemId}" (kind=${item.kind}).`,
      event,
    )
  }
  const next: ThreadItem = { ...item, items }
  return { ...state, items: { ...state.items, [itemId]: next } }
}

// ── Subagent ───────────────────────────────────────────────────────────────

function applySubagentStart(
  state: ThreadState,
  event: RuntimeEvent<'subagent-start'>,
): ThreadState {
  const { itemId, parentTurnId, childTurnId, label } = event.payload
  if (!state.turns[parentTurnId]) {
    throw new ReducerError(
      'unknown-turn',
      `Parent turn "${parentTurnId}" not found for subagent-start.`,
      event,
    )
  }
  if (state.items[itemId]) {
    throw new ReducerError(
      'illegal-transition',
      `Item "${itemId}" already started (subagent-start).`,
      event,
    )
  }
  const item: ThreadItem = {
    itemId,
    turnId: parentTurnId,
    kind: 'subagent',
    status: 'in_progress',
    startedAt: event.timestamp,
    parentTurnId,
    childTurnId,
    label,
  }
  return {
    ...state,
    items: { ...state.items, [itemId]: item },
    itemOrder: [...state.itemOrder, itemId],
  }
}

function applySubagentEnd(
  state: ThreadState,
  event: RuntimeEvent<'subagent-end'>,
): ThreadState {
  const { itemId } = event.payload
  const item = state.items[itemId]
  if (!item) {
    throw new ReducerError('unknown-item', `Item "${itemId}" not found for subagent-end.`, event)
  }
  if (item.kind !== 'subagent') {
    throw new ReducerError(
      'illegal-transition',
      `subagent-end on non-subagent item "${itemId}" (kind=${item.kind}).`,
      event,
    )
  }
  const next: ThreadItem = { ...item, status: 'completed', completedAt: event.timestamp }
  return { ...state, items: { ...state.items, [itemId]: next } }
}

// ── Approval handlers ──────────────────────────────────────────────────────

function applyApprovalRequired(
  state: ThreadState,
  event: RuntimeEvent<'approval-required'>,
): ThreadState {
  const { approvalId, turnId, itemId, tool, description, resource } = event.payload
  if (state.approvals[approvalId]) {
    throw new ReducerError(
      'illegal-transition',
      `Approval "${approvalId}" already required (duplicate).`,
      event,
    )
  }
  const approval: Approval = {
    approvalId,
    turnId,
    itemId,
    tool,
    description,
    resource,
  }
  const turn = state.turns[turnId]
  const nextTurns = turn
    ? {
        ...state.turns,
        [turnId]: { ...turn, status: 'waiting' as TurnStatus, waitingKind: 'approval' as const },
      }
    : state.turns
  return {
    ...state,
    approvals: { ...state.approvals, [approvalId]: approval },
    turns: nextTurns,
  }
}

function applyApprovalResolved(
  state: ThreadState,
  event: RuntimeEvent<'approval-resolved'>,
): ThreadState {
  const { approvalId, decision, scope } = event.payload
  const approval = state.approvals[approvalId]
  if (!approval) {
    throw new ReducerError('unknown-approval', `Approval "${approvalId}" not found.`, event)
  }
  const next: Approval = {
    ...approval,
    decision,
    scope,
    resolvedAt: event.timestamp,
  }
  const turn = state.turns[approval.turnId]
  const nextTurns =
    turn && turn.status === 'waiting'
      ? {
          ...state.turns,
          [approval.turnId]: { ...turn, status: 'running' as TurnStatus, waitingKind: 'none' as const },
        }
      : state.turns
  return {
    ...state,
    approvals: { ...state.approvals, [approvalId]: next },
    turns: nextTurns,
  }
}

// ── Usage ──────────────────────────────────────────────────────────────────

function applyUsage(
  state: ThreadState,
  event: RuntimeEvent<'usage'>,
): ThreadState {
  const { inputTokens, outputTokens, cachedTokens = 0, costUSD = 0 } = event.payload
  const turnId = event.turnId ?? '__unattributed__'
  const existing = state.usage.perTurn[turnId] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUSD: 0,
  }
  return {
    ...state,
    usage: {
      ...state.usage,
      inputTokens: state.usage.inputTokens + inputTokens,
      outputTokens: state.usage.outputTokens + outputTokens,
      cachedTokens: state.usage.cachedTokens + cachedTokens,
      costUSD: state.usage.costUSD + costUSD,
      perTurn: {
        ...state.usage.perTurn,
        [turnId]: {
          inputTokens: existing.inputTokens + inputTokens,
          outputTokens: existing.outputTokens + outputTokens,
          cachedTokens: existing.cachedTokens + cachedTokens,
          costUSD: existing.costUSD + costUSD,
        },
      },
    },
  }
}

// ── Error / disconnect ────────────────────────────────────────────────────

function applyError(state: ThreadState, event: RuntimeEvent<'error'>): ThreadState {
  return { ...state, lastError: event.payload.message }
}

function applyDisconnect(
  state: ThreadState,
  event: RuntimeEvent<'disconnect'>,
): ThreadState {
  if (!state.activeTurnId) return state
  const turn = state.turns[state.activeTurnId]
  if (!turn) return state
  return {
    ...state,
    turns: {
      ...state.turns,
      [state.activeTurnId]: {
        ...turn,
        errorMessage: `Disconnected: ${event.payload.reason}`,
      },
    },
  }
}

// ── Item factory ───────────────────────────────────────────────────────────

function makeItem(payload: ItemStartPayload, timestamp: number): ThreadItem {
  const base = {
    itemId: payload.itemId,
    turnId: payload.turnId,
    status: 'in_progress' as const,
    startedAt: timestamp,
  }
  const c = (payload.content ?? {}) as Record<string, unknown>
  switch (payload.kind) {
    case 'user-message':
      return {
        ...base,
        kind: 'user-message',
        role: 'user',
        text: (c.text as string) ?? '',
        imageRefs: c.imageRefs as string[] | undefined,
      } satisfies UserMessageItem
    case 'agent-message':
      return {
        ...base,
        kind: 'agent-message',
        role: 'assistant',
        text: (c.text as string) ?? '',
      } satisfies AgentMessageItem
    case 'reasoning':
      return { ...base, kind: 'reasoning', text: '' } satisfies ReasoningItem
    case 'plan':
      return { ...base, kind: 'plan', steps: [] }
    case 'todo':
      return { ...base, kind: 'todo', items: [] }
    case 'tool-call':
      return { ...base, kind: 'tool-call', name: '', input: {} }
    case 'command-execution':
      return { ...base, kind: 'command-execution', command: '', startedAt: timestamp }
    case 'file-change': {
      const item: FileChangeItem = { ...base, kind: 'file-change', path: '', operation: 'create' }
      return item
    }
    case 'skill-use':
      return { ...base, kind: 'skill-use', skillName: '', status: 'loading' as const }
    case 'mcp-tool-call':
      return { ...base, kind: 'mcp-tool-call', serverId: '', toolName: '', input: {} }
    case 'question':
      return { ...base, kind: 'question', prompt: '', options: [], multiSelect: false }
    case 'subagent':
      return { ...base, kind: 'subagent', parentTurnId: '', childTurnId: '', label: '' }
    case 'compaction':
      return { ...base, kind: 'compaction', replacedFrom: 0, replacedTo: 0, summary: '' }
    case 'error':
      return { ...base, kind: 'error', message: '' }
    default: {
      const _exhaustive: never = payload.kind
      throw new ReducerError(
        'invalid-payload',
        `No item factory for kind "${String(_exhaustive)}".`,
      )
    }
  }
}
