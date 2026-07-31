import type { FastifyInstance, FastifySchema } from 'fastify'
import { eventsSse } from './handlers/events-sse.js'
import { historyRead } from './handlers/history-read.js'
import { threadCreate } from './handlers/thread-create.js'
import { threadRead } from './handlers/thread-read.js'
import { turnInterrupt } from './handlers/turn-interrupt.js'
import { turnStart } from './handlers/turn-start.js'

const threadId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } as const
const body = (properties: Record<string, unknown>, required: string[]): FastifySchema => ({
  body: { type: 'object', additionalProperties: false, properties, required },
})

const threadCreateSchema = body({ threadId }, [])
const threadReadSchema = body({ threadId }, ['threadId'])
const historyReadSchema = body({ threadId, afterSequence: { type: 'integer', minimum: -1 } }, ['threadId'])
const turnStartSchema = body({
  threadId,
  prompt: { type: 'string', minLength: 1, maxLength: 102400 },
  modelId: { type: 'string' },
  accountId: { type: 'string' },
  images: { type: 'array' },
  subscriptionId: { type: 'string', minLength: 1, maxLength: 128 },
}, ['threadId', 'prompt'])
const turnInterruptSchema = body({ threadId, turnId: { type: 'string', minLength: 1 } }, ['threadId'])

export async function registerIpcRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/agent-runtime/thread/create', { schema: threadCreateSchema }, (request) =>
    threadCreate(request.body as { threadId?: string }))
  app.post('/v1/agent-runtime/thread/read', { schema: threadReadSchema }, (request) =>
    threadRead(request.body as Parameters<typeof threadRead>[0]))
  app.post('/v1/agent-runtime/history/read', { schema: historyReadSchema }, (request) =>
    historyRead(request.body as Parameters<typeof historyRead>[0]))
  app.post('/v1/agent-runtime/turn/start', { schema: turnStartSchema }, (request) =>
    turnStart(request.body as Parameters<typeof turnStart>[0]))
  app.post('/v1/agent-runtime/turn/interrupt', { schema: turnInterruptSchema }, (request) =>
    turnInterrupt(request.body as Parameters<typeof turnInterrupt>[0]))

  app.get('/v1/agent-runtime/events/stream', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['subscriptionId', 'threadId'],
        properties: {
          subscriptionId: { type: 'string', minLength: 1, maxLength: 128 },
          threadId,
        },
      },
    },
  }, (request, reply) => {
    const { subscriptionId, threadId } = request.query as { subscriptionId: string; threadId: string }
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    reply.raw.write(': connected\n\n')
    const cleanup = eventsSse(subscriptionId, threadId, (chunk) => reply.raw.write(chunk))
    request.raw.once('close', cleanup)
  })
}
