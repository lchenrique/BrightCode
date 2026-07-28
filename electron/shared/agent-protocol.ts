/**
 * Agent runtime protocol — the single IPC and persistence contract.
 *
 * This file is the source of truth for runtime types. Per the architecture
 * plan:
 *   - Thread, turn, item, permission, approval, content, usage, and event
 *     schemas live here.
 *   - Ajv 2020 compiles an in-memory schema for every IPC command and
 *     persisted event (defined alongside these types in
 *     `agent-protocol.schemas.ts` once it's needed).
 *   - Tagged unions and exhaustive switches. No provider-specific response
 *     objects leak into `ThreadItem` — those live in provider modules.
 *
 * The reducer (`electron/main/agent-runtime/event-reducer.ts`) is the only
 * consumer of `RuntimeEvent` and the only writer of `ThreadState`. The
 * renderer projects `ThreadState` into UI; it never constructs events.
 *
 * Compatibility contract:
 *   - `schemaVersion: 2` is the only version this build understands.
 *   - Older versions open read-only (future migration).
 *   - Newer versions open read-only (no implicit rewrite by an older app).
 *
 * See `docs/plans/2026-07-28-agent-runtime-codex-opencode.md` §3.
 */

// ── Primitive enums ─────────────────────────────────────────────────────────

/** Lifecycle of a single model turn (one round-trip: user input → model + tools). */
export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'

/** Lifecycle of a single item within a turn. */
export type ItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'declined'
  | 'interrupted'

/** Why a turn is waiting. `none` is the default. */
export type WaitingKind = 'none' | 'approval' | 'question' | 'tool-input'

/** Item kinds — used as the `kind` discriminator on `ThreadItem`. */
export type ThreadItemKind =
  | 'user-message'
  | 'agent-message'
  | 'reasoning'
  | 'plan'
  | 'todo'
  | 'tool-call'
  | 'command-execution'
  | 'file-change'
  | 'skill-use'
  | 'mcp-tool-call'
  | 'question'
  | 'subagent'
  | 'compaction'
  | 'error'

/** Permission profile — mirrors the config schema (kept here so the runtime
 *  can talk about profiles without depending on the config module). */
export type PermissionProfile = 'read_only' | 'workspace_write' | 'full_access'

// ── Event payload types (one per event type) ──────────────────────────────

/** Initial state of a turn. */
export interface TurnStartPayload {
  turnId: string
  /** Profile active for this turn (inherited from the thread, narrowed per turn). */
  permissionProfile: PermissionProfile
}

/** Terminal state of a turn. */
export interface TurnCompletePayload {
  turnId: string
  status: Extract<TurnStatus, 'completed' | 'interrupted' | 'failed'>
  /** Human-readable error message (only when status='failed'). */
  errorMessage?: string
  /** Stop reason from the model — e.g. 'end_turn', 'tool_calls', 'max_tokens'. */
  stopReason?: string
}

/** Force-interrupt signal (separate from turn-complete). */
export interface TurnInterruptedPayload {
  turnId: string
  reason: 'user' | 'abort' | 'error' | 'tool-timeout' | 'approval-timeout'
}

/** A new item begins. `content` is the initial state (may be empty). */
export interface ItemStartPayload {
  itemId: string
  turnId: string
  kind: ThreadItemKind
  /** Item-specific initial data — see the `ThreadItem` of the same `kind`. */
  content?: unknown
  /** Optional display role for `user-message` / `agent-message`. */
  role?: 'user' | 'assistant' | 'system' | 'tool'
}

/** Terminal state of an item. */
export interface ItemEndPayload {
  itemId: string
  status: Extract<ItemStatus, 'completed' | 'failed' | 'declined' | 'interrupted'>
  errorMessage?: string
}

/** A piece of text streamed from the model. */
export interface TextDeltaPayload {
  itemId: string
  content: string
}

/** Reasoning summary tick (visible to the user, summarized). */
export interface ReasoningDeltaPayload {
  itemId: string
  content: string
}

/** A tool call begins — `name` is the tool's identifier. */
export interface ToolCallStartPayload {
  itemId: string
  turnId: string
  name: string
  /** Optional initial input; the `tool-call-delta` events fill this in. */
  input?: unknown
}

/** A fragment of tool-call input (the args are streamed in). */
export interface ToolCallDeltaPayload {
  itemId: string
  turnId: string
  /** A piece of the JSON-serialized input — concat to reconstruct. */
  inputFragment: string
}

/** A tool call is fully specified. */
export interface ToolCallEndPayload {
  itemId: string
  turnId: string
  name: string
  input: unknown
}

/** Result of a tool call (success or failure). */
export interface ToolResultPayload {
  itemId: string
  turnId: string
  /** Free-form result payload — provider/tool-specific. */
  output: unknown
  /** When false, the call failed and `error` is set. */
  success: boolean
  error?: string
  /** Truncated flag — UI should show a "view full" affordance. */
  truncated?: boolean
}

/** Provider returned a usage record. */
export interface UsagePayload {
  inputTokens: number
  outputTokens: number
  /** Cached input tokens (read from cache). */
  cachedTokens?: number
  costUSD?: number
}

/** Provider signalled a transient error. */
export interface ErrorPayload {
  message: string
  code?: string
  /** Whether the runtime will retry automatically. */
  retryable?: boolean
}

/** Provider disconnected mid-stream. */
export interface DisconnectPayload {
  reason: 'network' | 'server' | 'client' | 'unknown'
}

/** Plan/todo updates. */
export interface PlanPayload {
  itemId: string
  /** Ordered list of plan steps. */
  steps: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>
}

export interface TodoPayload {
  itemId: string
  items: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>
}

/** Subagent launch. */
export interface SubagentPayload {
  itemId: string
  parentTurnId: string
  childTurnId: string
  label: string
}

/** Approval request — the runtime asks the user before proceeding. */
export interface ApprovalRequiredPayload {
  /** Approval id is separate from itemId — the user can resolve this even
   *  if the originating item has been compacted away. */
  approvalId: string
  turnId: string
  itemId?: string
  /** What kind of operation needs approval (mirrors PermissionRule). */
  tool: 'bash' | 'edit' | 'webfetch' | 'read' | 'glob' | 'grep' | 'task' | 'lsp' | 'websearch' | 'external_directory' | 'doom_loop'
  /** Human-readable description — e.g. the bash command, the URL to fetch. */
  description: string
  /** Optional resource — file path, URL, command, etc. */
  resource?: string
}

/** User resolved an approval request. */
export interface ApprovalResolvedPayload {
  approvalId: string
  /** What the user picked. */
  decision: 'allow' | 'allow-always' | 'deny'
  /** Optional scope when 'allow-always' — saved as a permission rule. */
  scope?: { pattern: string; tool: ApprovalRequiredPayload['tool'] }
}

// ── Runtime event type (generic envelope) ──────────────────────────────────

/** Schema version this build writes/reads. */
export const RUNTIME_SCHEMA_VERSION = 2 as const

/** All possible event types. Adding a new one is a breaking change to the
 *  protocol — the reducer must be updated exhaustively. */
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

/** Map an event type to the shape of its payload. Adding a new event
 *  requires adding it here and to the reducer's exhaustive switch. */
export interface RuntimeEventPayloadMap {
  'turn-start': TurnStartPayload
  'turn-complete': TurnCompletePayload
  'turn-interrupted': TurnInterruptedPayload
  'turn-failed': TurnCompletePayload
  'item-start': ItemStartPayload
  'item-end': ItemEndPayload
  'text-delta': TextDeltaPayload
  'reasoning-start': ReasoningDeltaPayload
  'reasoning-delta': ReasoningDeltaPayload
  'reasoning-end': ReasoningDeltaPayload
  'tool-call-start': ToolCallStartPayload
  'tool-call-delta': ToolCallDeltaPayload
  'tool-call-end': ToolCallEndPayload
  'tool-result': ToolResultPayload
  'plan-update': PlanPayload
  'todo-update': TodoPayload
  'subagent-start': SubagentPayload
  'subagent-end': SubagentPayload
  'approval-required': ApprovalRequiredPayload
  'approval-resolved': ApprovalResolvedPayload
  'usage': UsagePayload
  'error': ErrorPayload
  'disconnect': DisconnectPayload
}

/** A single runtime event. Immutable. Persisted as JSONL. */
export interface RuntimeEvent<T extends RuntimeEventType = RuntimeEventType> {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION
  threadId: string
  turnId?: string
  itemId?: string
  /** Monotonically increasing per-thread. Reducer rejects duplicates/regressions. */
  sequence: number
  /** Epoch ms. The reducer doesn't trust it for ordering — only sequence matters. */
  timestamp: number
  type: T
  payload: RuntimeEventPayloadMap[T]
}

// ── ThreadItem (tagged union — the canonical projection) ──────────────────

interface ItemBase<K extends ThreadItemKind> {
  itemId: string
  turnId: string
  kind: K
  status: ItemStatus
  startedAt: number
  completedAt?: number
}

export interface UserMessageItem extends ItemBase<'user-message'> {
  role: 'user'
  /** Plain text + optional image refs. The model-native shape lives in
   *  the provider module; here we store the canonical projection. */
  text: string
  imageRefs?: string[]
}

export interface AgentMessageItem extends ItemBase<'agent-message'> {
  role: 'assistant'
  text: string
  /** Concatenated reasoning summary (for display). */
  reasoningSummary?: string
}

export interface ReasoningItem extends ItemBase<'reasoning'> {
  /** Full reasoning text. Long-form is stored verbatim; UI truncates. */
  text: string
}

export interface PlanItem extends ItemBase<'plan'> {
  steps: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>
}

export interface TodoItem extends ItemBase<'todo'> {
  items: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>
}

export interface ToolCallItem extends ItemBase<'tool-call'> {
  name: string
  /** Parsed input. May be empty object while still in_progress. */
  input: unknown
  /** Set when status='completed' or 'failed'. */
  output?: unknown
  success?: boolean
  error?: string
  truncated?: boolean
}

export interface CommandExecutionItem extends ItemBase<'command-execution'> {
  command: string
  exitCode?: number
  stdout?: string
  stderr?: string
  startedAt: number
  durationMs?: number
}

export interface FileChangeItem extends ItemBase<'file-change'> {
  path: string
  /** What kind of file change this is. */
  operation: 'create' | 'modify' | 'delete'
  /** Diff or patch — provider decides shape. */
  patch?: string
  bytesAdded?: number
  bytesRemoved?: number
}

export interface SkillUseItem {
  itemId: string
  turnId: string
  kind: 'skill-use'
  status: 'loading' | 'active' | 'completed' | 'failed' | 'interrupted' | 'declined'
  startedAt: number
  completedAt?: number
  skillName: string
  output?: unknown
}

export interface McpToolCallItem extends ItemBase<'mcp-tool-call'> {
  serverId: string
  toolName: string
  input: unknown
  output?: unknown
  success?: boolean
}

export interface QuestionItem extends ItemBase<'question'> {
  /** Question text. */
  prompt: string
  /** Single-select or multi-select. */
  options: Array<{ id: string; label: string; description?: string }>
  multiSelect: boolean
  /** Set when status='completed'. */
  selectedOptionIds?: string[]
}

export interface SubagentItem extends ItemBase<'subagent'> {
  parentTurnId: string
  childTurnId: string
  label: string
}

export interface CompactionItem extends ItemBase<'compaction'> {
  /** Range of sequences replaced by the summary. */
  replacedFrom: number
  replacedTo: number
  summary: string
}

export interface ErrorItem extends ItemBase<'error'> {
  message: string
  code?: string
  retryable?: boolean
}

/** The canonical projection of a thread item. Use `item.kind` to discriminate. */
export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | PlanItem
  | TodoItem
  | ToolCallItem
  | CommandExecutionItem
  | FileChangeItem
  | SkillUseItem
  | McpToolCallItem
  | QuestionItem
  | SubagentItem
  | CompactionItem
  | ErrorItem

// ── ThreadState (the reducer's output) ─────────────────────────────────────

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

export interface Approval {
  approvalId: string
  turnId: string
  itemId?: string
  tool: ApprovalRequiredPayload['tool']
  description: string
  resource?: string
  /** Set when resolved. */
  decision?: ApprovalResolvedPayload['decision']
  scope?: ApprovalResolvedPayload['scope']
  resolvedAt?: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUSD: number
  /** Per-turn usage breakdown (for the UI). */
  perTurn: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUSD: number }>
}

/**
 * The reducer's output. Persistable; byte-equivalent after replay.
 *
 * Invariants (enforced by the reducer):
 *   - `activeTurnId` is set iff a turn is running or waiting
 *   - Every item belongs to a known turn
 *   - Sequence is the last event's `sequence`
 *   - Usage totals equal the sum of all `usage` events
 */
export interface ThreadState {
  threadId: string
  /** Monotonic per-thread; bumped on every event. The UI keys its
   *  `useSyncExternalStore` snapshot on this. */
  generation: number
  /** Last event sequence applied. */
  sequence: number
  turns: Record<string, Turn>
  /** Insertion order of turn ids (preserves chronological view). */
  turnOrder: string[]
  items: Record<string, ThreadItem>
  /** Insertion order of item ids. */
  itemOrder: string[]
  approvals: Record<string, Approval>
  activeTurnId?: string
  usage: Usage
  /** True once the most recent turn has emitted a terminal event. */
  idle: boolean
  /** Last error message (cleared on the next turn-start). */
  lastError?: string
}

// ── Initial state factory ─────────────────────────────────────────────────

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
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUSD: 0,
      perTurn: {},
    },
    idle: true,
  }
}

// ── Reducer errors ─────────────────────────────────────────────────────────

/** The reducer throws `ReducerError` on any invariant violation. The caller
 *  decides whether to surface it to the user, log it, or re-throw. */
export class ReducerError extends Error {
  readonly kind:
    | 'unknown-schema-version'
    | 'regressing-sequence'
    | 'duplicate-sequence'
    | 'illegal-transition'
    | 'unknown-turn'
    | 'unknown-item'
    | 'unknown-approval'
    | 'invalid-payload'

  readonly event?: RuntimeEvent

  constructor(
    kind: ReducerError['kind'],
    message: string,
    event?: RuntimeEvent,
  ) {
    super(message)
    this.name = 'ReducerError'
    this.kind = kind
    this.event = event
  }
}

// ── Item kind inference helper ─────────────────────────────────────────────

/** Build the kind field for a new item from its initial payload. Used by the
 *  reducer when handling `item-start` — the kind comes from the event, not
 *  the caller. */
export function itemKindFromStart(payload: ItemStartPayload): ThreadItemKind {
  return payload.kind
}
