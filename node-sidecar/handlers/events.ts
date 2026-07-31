import type { RuntimeEvent, ThreadState } from '../shared/agent-protocol.js'

export interface EventEnvelope {
  event: RuntimeEvent
  state: ThreadState
}

type Subscriber = (envelope: EventEnvelope) => void
const subscribers = new Map<string, { threadId: string; fn: Subscriber }>()

export function subscribe(subscriptionId: string, threadId: string, fn: Subscriber): void {
  subscribers.set(subscriptionId, { threadId, fn })
}

export function unsubscribe(subscriptionId: string): void {
  subscribers.delete(subscriptionId)
}

export function publish(threadId: string, envelope: EventEnvelope): void {
  for (const subscriber of subscribers.values()) {
    if (subscriber.threadId === threadId) subscriber.fn(envelope)
  }
}
