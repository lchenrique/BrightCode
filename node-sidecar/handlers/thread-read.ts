import { emptyThreadState, type ThreadState } from '../shared/agent-protocol.js'
import { threads } from './thread-create.js'

export interface ThreadReadInput {
  threadId: string
}

export function threadRead({ threadId }: ThreadReadInput): ThreadState {
  let state = threads.get(threadId)
  if (!state) {
    state = emptyThreadState(threadId)
    threads.set(threadId, state)
  }
  return state
}
