/**
 * Sidecar HTTP routes.
 *
 * Phase 2 wires only `POST /v1/agent-runtime/thread/create`. Path
 * allowlist is enforced in Rust (`proxy_agent_runtime`), so this
 * module only needs to serve the routes that pass that allowlist.
 */

import type { FastifyInstance, FastifySchema } from 'fastify'
import { threadCreate } from './handlers/thread-create.js'

const threadCreateSchema: FastifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      threadId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[A-Za-z0-9_-]+$',
      },
    },
  },
} as const

export async function registerIpcRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/agent-runtime/thread/create',
    { schema: threadCreateSchema },
    async (request) => {
      // `request.body` is validated by the schema above; cast is
      // safe because the schema enforces the same shape.
      const body = request.body as { threadId?: string }
      const result = threadCreate(body)
      return result
    },
  )
}
