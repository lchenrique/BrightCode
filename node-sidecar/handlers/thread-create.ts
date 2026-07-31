/**
 * `POST /v1/agent-runtime/thread/create` — minimal port of
 * `electron/main/agent-runtime/runtime.ts::createThread`.
 *
 * Phase 2 ships only the create-thread path. We return a fresh
 * empty `ThreadState` keyed by the requested `threadId` (random
 * UUID if absent) and store nothing — persistence is Phase 4.
 *
 * The shape returned here mirrors the real `ThreadState` interface
 * from `electron/shared/agent-protocol.ts`. We inline the minimal
 * subset here because the node-sidecar tsconfig's `rootDir: .`
 * blocks upward imports from `electron/`. The full interface
 * remains the source of truth; this file tracks its initial-state
 * fields by hand until a shared package can host both.
 *
 * ponytail: import the real interface once a workspace package
 * exists — for now, the duplicated literal is the smallest change
 * that keeps both tsconfigs green.
 */

import { randomUUID } from 'node:crypto'
import { emptyThreadState, type ThreadState } from '../shared/agent-protocol.js'

export interface ThreadCreateInput {
  threadId?: string
}

export interface ThreadCreateResponse {
  threadId: string
  thread: ThreadState
}

/** In-memory store. Phase 4 swaps this for an event-store + persistence. */
export const threads = new Map<string, ThreadState>()

export function threadCreate(
  input: ThreadCreateInput,
): ThreadCreateResponse {
  // Schema is enforced upstream in ipc.ts; `input` is already
  // validated and `threadId` is either a non-empty string or
  // absent.
  const threadId = input.threadId ?? `thread_${randomUUID()}`
  let state = threads.get(threadId)
  if (!state) {
    state = emptyThreadState(threadId)
    threads.set(threadId, state)
  }
  return { threadId, thread: state }
}
