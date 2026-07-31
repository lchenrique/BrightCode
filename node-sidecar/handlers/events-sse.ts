import { subscribe, unsubscribe } from './events.js'

export function eventsSse(subscriptionId: string, threadId: string, send: (data: string) => void): () => void {
  subscribe(subscriptionId, threadId, (envelope) => send(`data: ${JSON.stringify(envelope)}\n\n`))
  return () => unsubscribe(subscriptionId)
}
