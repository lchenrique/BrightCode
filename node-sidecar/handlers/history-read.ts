import type { RuntimeEvent } from '../shared/agent-protocol.js'

export interface HistoryReadInput {
  threadId: string
  afterSequence?: number
}

const histories = new Map<string, RuntimeEvent[]>()

export function appendHistory(event: RuntimeEvent): void {
  const history = histories.get(event.threadId) ?? []
  history.push(event)
  histories.set(event.threadId, history)
}

export function historyRead({ threadId, afterSequence = -1 }: HistoryReadInput): RuntimeEvent[] {
  return (histories.get(threadId) ?? []).filter((event) => event.sequence > afterSequence)
}
