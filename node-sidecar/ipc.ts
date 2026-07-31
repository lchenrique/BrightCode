/**
 * Sidecar HTTP routes.
 *
 * Phase 2 wires only `POST /v1/agent-runtime/thread/create` (placeholder
 * returning 501). Real handler lands in Task 2.6. Path allowlist is
 * enforced in Rust (`proxy_agent_runtime`), so this module only needs
 * to serve the routes that pass that allowlist.
 */

import type { FastifyInstance } from 'fastify'

export async function registerIpcRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/agent-runtime/thread/create',
    async (_request, reply) => {
      reply.code(501).send({ status: 'not_implemented' })
    },
  )
}
