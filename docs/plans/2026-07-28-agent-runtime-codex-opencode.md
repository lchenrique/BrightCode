# BrightCode Agent Runtime Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Replace the renderer-owned chat loop with a durable, multi-provider coding-agent runtime that matches the observable thread, turn, tool, permission, skill, and subagent behavior of Codex and OpenCode.

**Architecture:** The Electron main process owns execution, persistence, permissions, tools, provider streams, context, and child agents. The renderer becomes a client that sends commands and projects a versioned `thread -> turn -> item` event stream. Existing BrightCode providers and conversations remain compatible through pure provider adapters and a lazy V1-to-V2 migration.

**Tech Stack:** Electron 33, React 19, TypeScript 6, Vite 8, Ajv 2020 for runtime schema validation, electron-store for indexes and user settings, append-only JSONL thread logs, Vitest, CDP integration tests, existing provider adapters and OS keyring integration.

---

## 1. Product decisions and success criteria

### Decisions

- Build a native BrightCode runtime. Codex CLI and OpenCode are references, not required runtime dependencies.
- Preserve every currently configured provider and account.
- Use `workspace_write` as the default permission profile.
- Deliver full parity in incremental, independently shippable milestones.
- Reimplement contracts and behavior; do not copy upstream source without a separate license and attribution review.
- Real agent execution requires Electron. Browser development uses a deterministic fake runtime.
- Use `.brightcode/agent.json` as the only project runtime configuration file. Existing Codex/OpenCode configs are not imported implicitly.

### Observable behavior to match

- A conversation is a durable thread containing ordered turns and typed items.
- Every item follows `started -> delta* -> completed`; failed, interrupted, and declined are terminal states.
- The user sees tools, commands, file changes, skills, approvals, questions, plans, todos, reasoning summaries, MCP calls, and subagents while they run.
- Reloading or restarting the app resumes the canonical transcript without repeating side effects.
- One turn runs at a time per thread; different threads may run concurrently.
- Stopping a turn aborts its provider request, tools, background processes, approvals, and child agents.
- Permission controls are effective runtime policy, not UI labels.
- Skills are loaded completely before use and remain constrained by the active permission profile.
- Unsupported model capabilities are disabled explicitly instead of being silently simulated.

### Upstream references

- Codex lifecycle and application protocol: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Codex core protocol vocabulary: https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md
- OpenCode server and session API: https://opencode.ai/docs/server/
- OpenCode permission model: https://opencode.ai/docs/permissions/
- OpenCode skill discovery and loading: https://opencode.ai/docs/skills/

## 2. Target architecture

```text
React chat and workspace UI
        |
        | typed IPC commands and events
        v
Electron preload bridge
        |
        v
Agent Runtime in Electron main
  - thread and turn scheduler
  - append-only event store
  - provider service
  - context and compaction manager
  - instruction and skill resolver
  - tool registry and permission engine
  - process, MCP, LSP, and web managers
  - checkpoint and subagent managers
        |
        v
Existing BrightCode providers and local project
```

### Runtime invariants

- The main process is the only writer of thread history.
- The renderer never executes a tool or decides whether a turn is complete.
- Events carry a monotonically increasing per-thread `sequence`.
- Replaying persisted events through the reducer reconstructs the same state returned live.
- Tool execution starts only after schema validation and permission resolution.
- A child agent cannot receive permissions broader than its parent.
- Provider-native continuation data is preserved but never exposed as the UI's canonical state.
- Live deltas may be coalesced; item start and terminal states are persisted immediately.
- Every IPC payload, configuration file, tool input, and persisted record is validated before use.
- A newer unknown schema version opens read-only with a diagnostic; it is never rewritten by an older app.

### Configuration and precedence

Runtime configuration uses one versioned JSON schema in `electron/shared/agent-config-schema.ts`. Ajv 2020 compiles that schema once in the main process and validates all configuration and IPC payloads.

Configuration layers are applied in this exact order:

1. Non-overridable hard safety guards: path canonicalization, symlink boundaries, process ownership, request identity, and child-permission intersection.
2. Built-in BrightCode defaults.
3. User settings stored by the main process under the Electron user-data directory.
4. Trusted project configuration from `<project>/.brightcode/agent.json`.
5. The selected `AgentDefinition`.
6. Thread settings.
7. Explicit per-turn overrides.

Scalar values use the last defined value. Permission rules are appended in layer order and the last matching rule wins, but later layers cannot bypass hard guards. Project configuration may narrow authority immediately; any attempt to broaden the user's active profile requires an explicit approval. MCP servers are namespaced by source (`user:<name>` or `project:<name>`) so project configuration cannot replace a user server silently. Skill roots are merged and deduplicated by canonical path.

Codex `config.toml`, OpenCode `opencode.json`, and generic `.mcp.json` may be imported only through an explicit Settings action that previews the converted `.brightcode/agent.json`; they are never executed or merged automatically.

### Storage retention

- Thread event history is durable until the user deletes the thread.
- When an inactive JSONL log exceeds 10 MiB or 50,000 events, compact it into final item snapshots while retaining turn boundaries, approval decisions, usage, errors, and audit metadata.
- Keep the pre-compaction log as `.bak` until the compacted thread has been opened and replayed successfully once.
- Retain artifacts referenced by active threads. Orphaned artifacts expire after 7 days; artifacts from archived threads expire after 90 days.
- Enforce a configurable 2 GiB global artifact cap. Evict only orphaned or archived artifacts, oldest first; never evict from an active thread automatically.
- Retain checkpoints for the last 10 mutation turns or 30 days, whichever is reached first. The UI must show when undo is no longer available.
- Rotate diagnostic logs at 100 MiB total or 14 days. Diagnostics must redact credentials and sensitive tool input.

## 3. Shared protocol

Create `electron/shared/agent-protocol.ts` as the single IPC and persistence contract.

### Public types

```ts
export type PermissionProfile = 'read_only' | 'workspace_write' | 'full_access'

export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'

export type ItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'declined'
  | 'interrupted'

export interface RuntimeEvent<T = unknown> {
  schemaVersion: 2
  threadId: string
  turnId?: string
  itemId?: string
  sequence: number
  timestamp: number
  type: RuntimeEventType
  payload: T
}

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
```

### IPC commands

```ts
thread.create
thread.read
thread.list
thread.resume
thread.fork
thread.archive
history.read
turn.start
turn.steer
turn.interrupt
approval.resolve
question.resolve
events.subscribe
events.unsubscribe
```

All mutating commands accept a `requestId`. Repeating the same request must return the prior result instead of creating duplicate turns, approvals, or tool effects.

## 4. Implementation tasks

### Task 0: Lock configuration and sandbox feasibility

**Files:**

- Create: `electron/shared/agent-config-schema.ts`
- Create: `scripts/spike-agent-sandbox.mjs`
- Create: `docs/spikes/agent-sandbox.md`
- Modify: `package.json`
- Test: `test/agent-runtime/config-schema.test.ts`

**Steps:**

1. Add Ajv 2020 and define the versioned `.brightcode/agent.json` schema, defaults, source namespaces, and precedence rules described above.
2. Write failing tests for invalid config, unknown keys, rule precedence, authority broadening, MCP name collisions, and unknown newer schema versions.
3. Prototype one filesystem-write escape and one network attempt on Windows restricted token/job, Linux bubblewrap, and macOS sandbox profile using CI runners where the local OS is unavailable.
4. Record support status, required packaged helpers, startup cost, blocked operations, and error behavior in `docs/spikes/agent-sandbox.md`.
5. Lock the fallback: when the platform adapter cannot prove isolation, mark execution `host_authority`, require approval, and never label it sandboxed.
6. Run `npm test -- config-schema.test.ts` and the platform spike; expect all config tests to pass and every platform to produce either verified isolation or the explicit host-authority fallback.
7. Commit as `docs(agent): lock runtime config and sandbox strategy`.

### Task 1: Add the runtime test harness

**Files:**

- Modify: `package.json`
- Modify: `tsconfig.app.json`
- Modify: `tsconfig.node.json`
- Create: `vitest.config.ts`
- Create: `test/agent-runtime/fake-provider.ts`
- Create: `test/agent-runtime/protocol.test.ts`

**Steps:**

1. Add Vitest and test scripts without changing production behavior.
2. Create a deterministic fake provider that emits text, reasoning, fragmented tool input, parallel calls, usage, transient errors, and disconnects.
3. Write failing protocol tests for event ordering, idempotent request IDs, terminal states, and replay determinism.
4. Run `npm test -- protocol.test.ts`; expect failures because the protocol and reducer do not exist.
5. Commit as `test(agent): add runtime contract harness`.

### Task 2: Implement protocol and deterministic reducer

**Files:**

- Create: `electron/shared/agent-protocol.ts`
- Create: `electron/main/agent-runtime/event-reducer.ts`
- Create: `test/agent-runtime/event-reducer.test.ts`

**Steps:**

1. Define thread, turn, item, permission, approval, content, usage, and event schemas.
2. Define Ajv schemas for every IPC command and persisted event; generate no second competing source of truth.
3. Use tagged unions and exhaustive switches; do not store provider-specific response objects in `ThreadItem`.
4. Implement a pure reducer from `RuntimeEvent[]` to `ThreadState`.
5. Reject invalid payloads, duplicate or regressing `sequence` values, unknown schema versions, and illegal state transitions.
6. Verify replay produces byte-equivalent normalized state.
7. Run the protocol and reducer tests; expect pass.
8. Commit as `feat(agent): define thread turn item protocol`.

### Task 3: Build the append-only thread store

**Files:**

- Create: `electron/main/agent-runtime/event-store.ts`
- Create: `electron/main/agent-runtime/thread-index.ts`
- Create: `electron/main/agent-runtime/storage-retention.ts`
- Create: `electron/main/agent-runtime/migrations/index.ts`
- Create: `test/agent-runtime/event-store.test.ts`
- Modify: `electron/main/tasks.ts`

**Steps:**

1. Store each thread under Electron `userData/agent-runtime/v2/threads/<threadId>.jsonl`.
2. Store searchable metadata in an atomic index; write a temporary file and rename it into place.
3. Flush `item.started`, approvals, tool effects, and terminal events immediately.
4. Coalesce text/reasoning deltas into checkpoints at most every 200 ms.
5. On recovery, mark non-terminal turns and items as interrupted while preserving partial output.
6. Add paginated history reads by sequence and turn boundary.
7. Implement the exact JSONL, artifact, checkpoint, and diagnostic retention rules defined above.
8. Implement version migrations as streaming rewrites to a temporary file, followed by flush, atomic rename, and one-release `.bak` retention.
9. Refuse to mutate logs with an unknown newer schema and expose them read-only.
10. Test truncated records, duplicate events, interrupted migration/compaction, retention boundaries, rollback to `.bak`, and restart recovery.
11. Commit as `feat(agent): persist event sourced threads`.

### Task 4: Move provider execution into Electron main

**Files:**

- Create: `electron/main/agent-runtime/provider-service.ts`
- Create: `electron/shared/providers/`
- Modify: `src/lib/providers/factory.ts`
- Modify: `src/lib/providers/registry.ts`
- Modify: `electron/main/provider-proxy.ts`
- Test: `test/agent-runtime/provider-service.test.ts`

**Steps:**

1. Extract provider types, request builders, SSE parsing, and model catalogs into modules with no `window` or React dependency.
2. Keep credential lookup and request headers exclusively in the main process.
3. Make the provider service emit normalized model events consumed by the runtime.
4. Preserve OpenAI reasoning items, Anthropic thinking/tool blocks, Gemini function calls, usage, cache metrics, and stop reasons.
5. Support cancellation and retry only before a side effect has been committed.
6. Keep renderer registry APIs as read-only catalog/account projections during migration.
7. Run provider contract tests for OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini Native.
8. Add `scripts/smoke-agent-runtime-providers.mjs`, disabled by default, to test one configured model per wire format using existing credentials without printing secrets.
9. Cover OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini Native, both OpenCode Go formats, OpenCode Zen, and MiniMax in the capability matrix; skip only providers without configured credentials.
10. Commit as `refactor(providers): run model streams in main process`.

### Task 5: Implement the thread and turn scheduler

**Files:**

- Create: `electron/main/agent-runtime/runtime.ts`
- Create: `electron/main/agent-runtime/turn-scheduler.ts`
- Create: `test/agent-runtime/turn-scheduler.test.ts`

**Steps:**

1. Implement create, resume, fork, archive, start, steer, and interrupt operations.
2. Enforce one active turn per thread and bounded global concurrency.
3. Persist the user item before starting the provider request.
4. Queue complete user inputs, including images, when steering is unavailable.
5. Propagate a shared abort signal through provider, tools, approvals, processes, MCP, and subagents.
6. Terminate a turn only when the model produces no executable output or a terminal error occurs.
7. Replace the arbitrary eight-round limit with a configurable emergency ceiling of 64 rounds and doom-loop detection after three identical calls.
8. Test rapid submits, stop during streaming, stop during tool execution, and restart with a queued turn.
9. Commit as `feat(agent): add durable turn scheduler`.

### Task 5A: Ship a minimal vertical runtime slice

**Files:**

- Create: `electron/main/agent-runtime/ipc.ts`
- Modify: `electron/shared/ipc-channels.ts`
- Modify: `electron/preload/index.ts`
- Modify: `electron/main/index.ts`
- Create: `src/hooks/use-agent-thread.ts`
- Create: `src/components/chat/AgentRuntimeTranscript.tsx`
- Create: `scripts/cdp-agent-runtime-vertical-slice.mjs`

**Steps:**

1. Expose only `thread.create/read`, `turn.start/interrupt`, `history.read`, and scoped event subscription.
2. Validate every command with the shared Ajv schemas.
3. Render user message, agent text/reasoning, turn state, interruption, and recovery using the fake provider.
4. Keep the existing V1 chat as the default; open the vertical slice only behind `agentRuntimeV2`.
5. Reload during fake-provider streaming and verify resubscription from the last sequence without duplicate content.
6. Run the unit tests and `node scripts/cdp-agent-runtime-vertical-slice.mjs`; expect the full main-to-renderer path to pass before tool work begins.
7. Commit as `feat(agent): prove runtime vertical slice`.

### Task 6: Create the tool registry and result contract

**Files:**

- Create: `electron/main/agent-runtime/tools/registry.ts`
- Create: `electron/main/agent-runtime/tools/result.ts`
- Modify: `src/lib/agents/tools.ts`
- Test: `test/agent-runtime/tool-registry.test.ts`

**Steps:**

1. Define every tool with name, description, JSON schema, permission action, resource resolver, cancellation support, and concurrency class.
2. Validate arguments before requesting permission.
3. Standardize results as `content`, `structuredContent`, `artifacts`, `metadata`, and `isError`.
4. Keep stable snake_case model-facing names.
5. Spill oversized results into a runtime artifact directory and return a bounded preview plus artifact reference.
6. Add lazy/deferred tool registration and a `tool_search` tool.
7. Test invalid arguments, duplicate call IDs, truncation, cancellation, and unsupported tools.
8. Commit as `feat(agent): add typed tool registry`.

### Task 7: Implement filesystem tools and patch application

**Files:**

- Create: `electron/main/agent-runtime/tools/filesystem.ts`
- Create: `electron/main/agent-runtime/path-policy.ts`
- Modify: `electron/main/tools.ts`
- Test: `test/agent-runtime/filesystem-tools.test.ts`

**Steps:**

1. Implement ranged file reads, directory listing, glob, regex grep, atomic writes, exact edits, and `apply_patch`.
2. Canonicalize project root and candidate paths before access.
3. Reject `..`, absolute-path escapes, symlink escapes, device paths, and invalid Windows drive transitions.
4. Treat `.env`, credential files, SSH material, key stores, and configured secret patterns as sensitive resources.
5. Serialize conflicting writes by canonical path while allowing independent reads in parallel.
6. Emit `fileChange` items with structured changes and unified diffs.
7. Test git and non-git projects, spaces, Unicode, CRLF/LF, binary files, large files, and symlinks.
8. Commit as `feat(agent): add sandboxed filesystem tools`.

### Task 8: Implement the permission engine

**Files:**

- Create: `electron/main/agent-runtime/permissions/engine.ts`
- Create: `electron/main/agent-runtime/permissions/defaults.ts`
- Create: `electron/main/agent-runtime/permissions/grants.ts`
- Test: `test/agent-runtime/permission-engine.test.ts`

**Steps:**

1. Implement ordered `action + resource -> allow | ask | deny` rules.
2. Add profiles `read_only`, `workspace_write`, and `full_access`.
3. Apply the locked precedence rules from Task 0 and prevent project/agent/thread layers from silently broadening the active user profile.
4. Resolve both external-directory permission and the tool's own permission.
5. Support approval decisions `once`, `session`, `always`, `decline`, and `cancel`.
6. Keep session grants in memory and persistent grants in the main-process settings store.
7. Scope command grants to safe proposed patterns, never arbitrary substring matches.
8. Emit approval requests with thread, turn, item, reason, command/path, risk, and available decisions.
9. Test precedence, revocation, child-agent restriction, sensitive reads, external roots, network, and destructive commands.
10. Commit as `feat(agent): enforce granular permissions`.

### Task 9: Replace bash with managed command execution

**Files:**

- Create: `electron/main/agent-runtime/tools/exec-manager.ts`
- Create: `electron/main/agent-runtime/tools/platform-sandbox.ts`
- Test: `test/agent-runtime/exec-manager.test.ts`
- Modify: `electron/main/tools.ts`

**Steps:**

1. Add command start, output delta, stdin, wait, resize, kill, timeout, and process exit events.
2. Track every process by thread, turn, and item; clean it on interruption or thread disposal.
3. Stream stdout and stderr with independent caps and preserve overflow as artifacts.
4. Implement only the platform adapters proven in Task 0: Windows restricted token/job, Linux bubblewrap, and macOS sandbox profile.
5. When the locked adapter is unavailable or fails self-check, require approval and label the command as `host_authority`.
6. Deny background-process leaks after app shutdown.
7. Test output ordering, timeout, cancellation, background processes, missing executables, and sandbox fallback.
8. Commit as `feat(agent): add managed command execution`.

### Task 10: Add checkpoints, diffs, and safe undo

**Files:**

- Create: `electron/main/agent-runtime/checkpoint-store.ts`
- Create: `test/agent-runtime/checkpoint-store.test.ts`
- Modify: `src/components/task/EditedFilesCard.tsx`

**Steps:**

1. Capture a checkpoint before the first mutation in each tool batch.
2. Store original bytes and hashes for changed files, including non-git projects.
3. Aggregate the turn-level diff after every completed file change.
4. Restore only files whose current hash still matches the runtime's last written hash.
5. Refuse unsafe undo and show the conflicting paths.
6. Test create, modify, delete, partial failure, external user edits, and non-git rollback.
7. Commit as `feat(agent): add turn checkpoints and undo`.

### Task 11: Resolve project instructions and trust

**Files:**

- Create: `electron/main/agent-runtime/instructions/resolver.ts`
- Create: `electron/main/agent-runtime/instructions/trust-store.ts`
- Modify: `src/lib/agents/system-prompt.ts`
- Test: `test/agent-runtime/instruction-resolver.test.ts`

**Steps:**

1. Resolve instructions in deterministic order: BrightCode base, mode, global rules, root-to-cwd `AGENTS.md`, agent config, and turn context.
2. Add a first-open trust decision before project hooks or executables may run.
3. Persist the instruction fingerprint on each turn.
4. Treat loaded project text as untrusted context below system/developer policy.
5. Watch relevant instruction files and invalidate only future turns.
6. Test monorepos, nested directories, worktrees, malformed files, and instruction changes during a turn.
7. Commit as `feat(agent): load scoped project instructions`.

### Task 12: Implement skills as first-class runtime input

**Files:**

- Create: `electron/main/agent-runtime/skills/service.ts`
- Modify: `electron/main/skills.ts`
- Modify: `src/lib/agents/system-prompt.ts`
- Test: `test/agent-runtime/skills.test.ts`

**Steps:**

1. Discover global and project skills from supported Codex, Agents, Claude, Gemini, OpenCode, and BrightCode roots.
2. Expose only selector, name, description, source, and interface metadata before loading.
3. Implement one `skill` tool that loads the complete `SKILL.md` and a protected resource reader for referenced files.
4. Resolve explicit `$skill-name` mentions before the first provider request.
5. Emit visible `skillUse` items for loading, success, failure, and denial.
6. Apply skill-specific permissions and prevent path escapes from the skill directory.
7. Watch skill roots and emit catalog invalidation events.
8. Test duplicate names, explicit selectors, missing resources, binary resources, denied skills, and live changes.
9. Commit as `feat(agent): add first class skill loading`.

### Task 13: Make Bright Memory a deterministic lifecycle hook

**Files:**

- Create: `electron/main/agent-runtime/hooks/bright-memory.ts`
- Modify: `electron/main/bright-memory.ts`
- Test: `test/agent-runtime/bright-memory-hook.test.ts`

**Steps:**

1. Run `bright-memory ensure --json` once before relevant project work.
2. Inject returned memories as untrusted context, not higher-priority instructions.
3. Report CLI/auth/API failure once and continue without retry loops.
4. Run `bright-memory save --text ...` only after meaningful completed work.
5. Never write `.bright-memory.json` or Markdown memory from the runtime.
6. Emit hook items so the user can see whether context was loaded or skipped.
7. Commit as `feat(agent): integrate memory lifecycle hooks`.

### Task 14: Implement context accounting and compaction

**Files:**

- Create: `electron/main/agent-runtime/context/manager.ts`
- Create: `electron/main/agent-runtime/context/compactor.ts`
- Test: `test/agent-runtime/context-manager.test.ts`
- Remove after migration: context preparation from `src/components/chat/ChatSurface.tsx`

**Steps:**

1. Use provider usage when available and conservative estimates otherwise.
2. Reserve output and tool-result budget before each provider request.
3. Preserve current instructions, unresolved tool calls, recent turns, reasoning replay data, and selected durable facts.
4. Record compaction as a typed item with omitted range and summary metadata.
5. Support automatic and manual compaction.
6. Never compact between a tool call and its result.
7. Test boundary conditions, provider changes, image turns, interrupted tools, and repeated compaction.
8. Commit as `feat(agent): add durable context compaction`.

### Task 15: Add MCP runtime support

**Files:**

- Create: `electron/main/agent-runtime/mcp/manager.ts`
- Create: `electron/main/agent-runtime/mcp/tool-adapter.ts`
- Create: `test/fixtures/mcp-server.mjs`
- Test: `test/agent-runtime/mcp-manager.test.ts`

**Steps:**

1. Load MCP definitions only from user settings and trusted `.brightcode/agent.json` using the source namespaces defined above.
2. Support stdio and HTTP MCP servers with startup, status, timeout, cancellation, and shutdown.
3. Discover tools, resources, prompts, and elicitation capabilities.
4. Register MCP tools lazily and gate them by server/tool permission patterns.
5. Normalize text, image, audio, embedded resource, and resource-link results.
6. Render elicitation as a waiting item and resume after the client response.
7. Test source collisions, untrusted project config, server failure, reconnect, malformed output, cancellation, approval, and multimodal content.
8. Commit as `feat(agent): add MCP tools and elicitation`.

### Task 16: Add LSP and web capabilities

**Files:**

- Create: `electron/main/agent-runtime/lsp/manager.ts`
- Create: `electron/main/agent-runtime/tools/lsp.ts`
- Create: `electron/main/agent-runtime/tools/web.ts`
- Test: `test/agent-runtime/lsp-web-tools.test.ts`

**Steps:**

1. Detect already-installed language servers without installing software automatically.
2. Add diagnostics, symbols, definition, references, hover, and implementation tools.
3. Fall back to grep/search when no language server is available.
4. Add permission-gated `web_fetch` with redirects, size limits, content-type validation, and private-network protection.
5. Add `web_search` only when a configured search capability exists; otherwise omit it from the tool catalog.
6. Test missing servers, server crashes, unsupported languages, blocked network, redirect loops, and oversized responses.
7. Commit as `feat(agent): add LSP and web tools`.

### Task 17: Implement modes, questions, plans, and todos

**Files:**

- Create: `electron/main/agent-runtime/modes.ts`
- Create: `electron/main/agent-runtime/tools/interaction.ts`
- Modify: `src/lib/agents/store.ts`
- Test: `test/agent-runtime/modes.test.ts`

**Steps:**

1. Add primary modes `build`, `plan`, and `review`.
2. Deny mutations in plan mode and keep review mode limited to investigation and diff analysis.
3. Implement structured question requests, answers, cancellation, and turn resumption.
4. Implement structured plan and todo state with pending, in-progress, and completed steps.
5. Extend `AgentDefinition` with mode, permission rules, allowed tools, concurrency, depth, and budget.
6. Migrate existing agent definitions with compatible defaults.
7. Commit as `feat(agent): add modes questions and plans`.

### Task 18: Implement persistent subagents

**Files:**

- Create: `electron/main/agent-runtime/subagents/manager.ts`
- Create: `test/agent-runtime/subagents.test.ts`
- Remove after migration: `src/lib/agents/runner.ts`

**Steps:**

1. Create a persistent child thread for every delegation.
2. Link parent item, child thread, child turn, and final result.
3. Intersect parent and child permissions; never broaden authority.
4. Set default depth to one and hard maximum to two unless an explicit trusted rule permits more.
5. Enforce per-thread and global child concurrency and token budgets.
6. Propagate cancellation from parent to descendants and retain partial output.
7. Return a bounded result summary plus artifact/thread references to the parent.
8. Test parallel children, recursive delegation, missing agents, permission narrowing, failures, and cancellation.
9. Commit as `feat(agent): add persistent subagent threads`.

### Task 19: Harden and expand runtime IPC

**Files:**

- Modify: `electron/shared/ipc-channels.ts`
- Modify: `electron/preload/index.ts`
- Modify: `electron/main/index.ts`
- Modify: `electron/main/agent-runtime/ipc.ts`
- Test: `test/agent-runtime/ipc.test.ts`

**Steps:**

1. Extend the Task 5A bridge with fork/archive, steer, approvals, questions, MCP elicitation, subagent navigation, pagination, and artifact reads.
2. Validate every renderer payload before it reaches the runtime.
3. Bind subscriptions to the requesting `webContents` and clean them on destruction.
4. Support resubscription from the last observed sequence.
5. Add backpressure/coalescing for high-frequency deltas without delaying terminal events.
6. Ensure one window cannot answer another thread's approval without the matching IDs.
7. Commit as `feat(agent): harden runtime IPC protocol`.

### Task 20: Complete chat event projection

**Files:**

- Modify: `src/hooks/use-agent-thread.ts`
- Create: `src/lib/agents/thread-client.ts`
- Modify: `src/components/chat/ChatSurface.tsx`
- Modify: `src/components/chat/AssistantTurn.tsx`
- Modify: `src/components/chat/ToolTimeline.tsx`
- Modify: `src/components/home/ChatInput.tsx`

**Steps:**

1. Replace the Task 5A transcript with the production thread history and live-event client.
2. Render typed items rather than inferring a timeline from message adjacency.
3. Add command output, file diffs, skill usage, MCP calls, questions, plans, todos, approvals, artifacts, and child agents to the already-proven text/reasoning projection.
4. Render approvals inline in their item with only server-provided decisions.
5. Replace the decorative auth toggle with `read_only`, `workspace_write`, and `full_access` profiles.
6. Implement stop, steer, durable queue, retry-safe reconnect, and background completion notifications.
7. Preserve model picker, accounts, attachments, DiceBear avatars, auto-scroll, and environmental panel integration.
8. Keep all user-facing UI free of emoji.
9. Commit as `feat(chat): render agent runtime events`.

### Task 21: Migrate existing tasks and transcripts

**Files:**

- Create: `electron/main/agent-runtime/migration/v1-messages.ts`
- Modify: `electron/main/tasks.ts`
- Modify: `src/lib/tasks/store.ts`
- Test: `test/agent-runtime/migration.test.ts`

**Steps:**

1. Add `runtimeVersion` and `threadId` to task metadata.
2. Lazily convert V1 messages into V2 turns and items on first V2 open.
3. Repair incomplete assistant/tool history before conversion.
4. Validate reducer output before marking migration complete.
5. Keep an immutable V1 backup until the first successful V2 turn completes.
6. Never dual-run a prompt through V1 and V2.
7. Test empty chats, interrupted streams, parallel tool batches, provider reasoning items, images, errors, and corrupted snapshots.
8. Commit as `feat(agent): migrate legacy chat history`.

### Task 22: Remove the renderer-owned execution loop

**Files:**

- Modify: `src/components/chat/ChatSurface.tsx`
- Remove: `src/lib/agents/runner.ts`
- Simplify: `src/lib/agents/tools.ts`
- Simplify: `electron/main/provider-proxy.ts`

**Steps:**

1. Confirm all new tasks and migrated fixtures run through V2.
2. Remove provider streaming, tool execution, context compaction, and agent delegation from React.
3. Remove obsolete IPC channels only after preload and renderer references reach zero.
4. Run `rg` checks for old execution entry points.
5. Run the complete test, build, and CDP suites.
6. Commit as `refactor(chat): remove legacy agent loop`.

### Task 23: Add CDP acceptance coverage

**Files:**

- Create: `scripts/cdp-agent-runtime-test.mjs`
- Create: `scripts/cdp-agent-runtime-recovery-test.mjs`
- Create: `scripts/cdp-agent-runtime-permissions-test.mjs`
- Create screenshots under: `scripts/screenshots/`

**Steps:**

1. Verify text and reasoning streaming.
2. Verify file read, patch, shell output, and diff items.
3. Verify inline approval decisions and real read-only enforcement.
4. Verify skill loading, question response, plan/todo updates, MCP call, and subagent expansion.
5. Reload during a turn and confirm recovery without duplicate effects.
6. Stop during a command and confirm provider/process/child cancellation.
7. Capture screenshots for every UI state required by `AGENTS.md`.
8. Commit as `test(agent): cover runtime flows with CDP`.

### Task 24: Final hardening and rollout

**Files:**

- Modify: `README.md`
- Create: `docs/agent-runtime.md`
- Modify: relevant settings and diagnostics components

**Steps:**

1. Document protocol, persistence, permissions, recovery, tool development, skills, MCP, and troubleshooting.
2. Add a diagnostics view for runtime version, active turns, processes, MCP/LSP status, event-store path, and recoverable warnings.
3. Add a storage panel showing event-log, artifact, checkpoint, and diagnostic usage plus their effective retention policy.
4. Default new tasks to V2 and `workspace_write`.
5. Keep a temporary read-only V1 history importer for one release cycle.
6. Remove the feature flag only after migration, recovery, vertical-slice, and real-provider smoke gates stay clean.
7. Run all final validation commands.
8. Commit as `feat(agent): ship agent runtime v2`.

## 5. Required validation commands

Run after each relevant task and before completion:

```powershell
npm test
npm run lint
npx tsc --noEmit
npm run build
node scripts/smoke-agent-runtime-providers.mjs
```

For Electron integration milestones:

```powershell
npm run electron:dev
node scripts/cdp-agent-runtime-test.mjs
node scripts/cdp-agent-runtime-recovery-test.mjs
node scripts/cdp-agent-runtime-permissions-test.mjs
```

Expected final result:

- Every command exits successfully.
- CDP scripts report zero failed assertions.
- The real-provider smoke script passes every configured wire format and reports unconfigured providers as skipped, never failed.
- Screenshots exist for transcript, approval, permission profiles, skill use, question, plan, MCP, subagent, interrupted turn, and recovered turn.
- `rg` finds no provider stream or tool execution loop inside React components.

## 6. Final acceptance matrix

| Area | Acceptance condition |
| --- | --- |
| Persistence | Reload/crash loses no completed item and repeats no committed effect |
| Schemas | Invalid/unknown payloads are rejected; newer stores open read-only; migrations are atomic and recoverable |
| Retention | Active history is preserved; artifacts, checkpoints, and diagnostics follow the documented limits |
| Streaming | Text, reasoning, commands, and tools update incrementally |
| Permissions | Read-only blocks writes; workspace-write gates sensitive/external/network access |
| Filesystem | Traversal, symlink, device-path, and external-root escapes are blocked |
| Commands | Output, timeout, stdin, cancellation, and cleanup are deterministic |
| Skills | Full instructions load before use and appear in the transcript |
| Context | Compaction never separates a tool call from its result |
| Providers | OpenAI, Anthropic, Gemini, OpenCode, and MiniMax pass contract tests |
| Vertical slice | Main-to-renderer create, stream, interrupt, reload, and resume pass before tool implementation |
| MCP | Tools, resources, approval, elicitation, cancellation, and errors work |
| Subagents | Child threads persist, cannot escalate permissions, and cancel with the parent |
| Migration | Existing conversations remain readable and continue through V2 |
| Projects | Git, non-git, monorepo, worktree, Windows paths, spaces, and Unicode work |
| UI | No emoji; every runtime state has an explicit visual representation |

## 7. Out of scope for this plan

- Exact byte-for-byte reproduction of Codex or OpenCode prompts.
- Requiring Codex CLI or OpenCode as a production dependency.
- Automatically installing language servers or sandbox packages without user consent.
- Cloud synchronization or multi-user collaboration.
- Remote code execution environments.
- Copying upstream source without license, attribution, and maintenance review.
